const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const axios = require('axios');
const { uploadBase64Image, deleteFile } = require('../utils/cos');
const { logTaskEvent, initTryonTask, updateTryonTaskStatus, setTryonTaskError } = require('../utils/monitor');

// ========== 状态 ==========
let isProcessing = 0; // 当前正在处理的任务数
let cachedMaxConcurrent = 100; // 缓存的最大并发数
let lastConfigRefresh = 0; // 上次刷新配置的时间
const CONFIG_CACHE_TTL = 60000; // 配置缓存时间（60秒）
const RETRY_MAX = 3; // 最大重试次数

// ========== 获取最大并发配置 ==========
async function getMaxConcurrent() {
  const now = Date.now();
  // 每60秒刷新一次配置
  if (now - lastConfigRefresh > CONFIG_CACHE_TTL) {
    try {
      const [[config]] = await db.query('SELECT value FROM config WHERE name = "max_concurrent" LIMIT 1');
      if (config?.value) {
        cachedMaxConcurrent = parseInt(config.value) || 100;
      }
    } catch (err) {
      console.error('[getMaxConcurrent] 读取配置失败:', err.message);
    }
    lastConfigRefresh = now;
  }
  return cachedMaxConcurrent;
}

// ========== 定时器（每100ms检查一次）==========
setInterval(async () => {
  try {
    // 有空位吗？
    const maxConcurrent = await getMaxConcurrent();
    if (isProcessing >= maxConcurrent) return;

    // 有排队任务吗？
    const [[task]] = await db.query(
      'SELECT * FROM usage_records WHERE status = "queued" ORDER BY created_at ASC LIMIT 1'
    );

    if (!task) return;

    // 有空位，取1个任务处理
    isProcessing++;
    processTask(task, task.retry_count || 0).catch(err => console.error('Task failed:', err));
  } catch (err) {
    console.error('Scheduler error:', err);
  }
}, 100);

// ========== 处理任务 ==========
async function processTask(task, retryCount = 0) {
  try {
    // 更新为处理中
    await db.query('UPDATE usage_records SET status = "processing" WHERE id = ?', [task.id]);
    updateTryonTaskStatus(task.id, 'processing');
    logTaskEvent(task.id, task.openid, `调度器取出任务，开始处理`, 'info');

    // 获取任务详情
    const [[taskDetail]] = await db.query('SELECT * FROM usage_records WHERE id = ?', [task.id]);
    if (!taskDetail) {
      logTaskEvent(task.id, task.openid, `任务详情为空，终止处理`, 'error');
      console.error('[processTask] 任务详情为空, task.id:', task.id);
      return;
    }

    console.log('[processTask] 开始处理任务', task.id, 'source_image:', taskDetail.source_image?.substring(0, 50), 'target_image:', taskDetail.target_image?.substring(0, 50));

    // 下载图片
    logTaskEvent(task.id, task.openid, `开始下载源图片...`, 'info');
    const sourceBase64 = await downloadImage(taskDetail.source_image);
    logTaskEvent(task.id, task.openid, `源图片下载完成，大小: ${(sourceBase64.length/1024).toFixed(1)}KB`, 'info');

    logTaskEvent(task.id, task.openid, `开始下载目标图片...`, 'info');
    const targetBase64 = await downloadImage(taskDetail.target_image);
    logTaskEvent(task.id, task.openid, `目标图片下载完成，大小: ${(targetBase64.length/1024).toFixed(1)}KB`, 'info');

    // 调用 AI
    updateTryonTaskStatus(task.id, 'ai_processing');
    const [[aiConfig]] = await db.query('SELECT api_url, model, prompt FROM config WHERE type = "ai" LIMIT 1');
    const model = aiConfig?.model || '未配置';
    const promptText = aiConfig?.prompt || taskDetail.prompt || 'Replace the hairstyle in the first image with the hairstyle in the second image';
    logTaskEvent(task.id, task.openid, `开始调用AI接口...模型: ${model}`, 'info');
    console.log('[processTask] ★★★ 开始发送AI请求，任务ID:', task.id, '模型:', model, '时间:', new Date().toISOString());
    const result = await callAI(sourceBase64, targetBase64, promptText, model);
    logTaskEvent(task.id, task.openid, `AI调用成功${result.startsWith('http') ? ', 图片URL' : ', 返回数据大小: ' + (result.length/1024).toFixed(1) + 'KB'}`, 'success');

    // 上传结果图片（APIYI返回base64，需要上传COS）
    let resultUrl = result;
    if (!resultUrl.startsWith('http')) {
      logTaskEvent(task.id, task.openid, `开始上传结果图片到COS...`, 'info');
      const cosKey = `results/${task.id}_${Date.now()}.jpg`;
      // 补全 base64 前缀（uploadBase64Image 需要 data:image/xxx;base64, 格式）
      const base64WithPrefix = result.startsWith('data:') ? result : `data:image/jpeg;base64,${result}`;
      resultUrl = await uploadBase64Image(base64WithPrefix, cosKey);
    }
    logTaskEvent(task.id, task.openid, `结果图片URL: ${resultUrl}`, 'success');

    // 完成
    await db.query(
      'UPDATE usage_records SET status = "completed", result_image = ? WHERE id = ?',
      [resultUrl, task.id]
    );
    updateTryonTaskStatus(task.id, 'completed');
    logTaskEvent(task.id, task.openid, `任务完成！`, 'success');

    // 扣除次数
    await db.query('UPDATE users SET quota = quota - ? WHERE openid = ?', [taskDetail.cost, taskDetail.openid]);

    // 分佣
    await distributeCommission(taskDetail.openid, taskDetail.cost);

  } catch (err) {
    logTaskEvent(task.id, task.openid, `任务失败: ${err.message}`, 'error');
    setTryonTaskError(task.id, err.message);
    console.error('[processTask] 任务失败, id:', task.id, 'error:', err.message);
    console.error('[processTask] Stack:', err.stack);

    // 429限流 或 503服务不可用 且还能重试，放回队列等调度器重试
    if ((err.message.includes('429') || err.message.includes('503')) && retryCount < RETRY_MAX) {
      await db.query('UPDATE usage_records SET status = "queued", retry_count = ? WHERE id = ?', [retryCount + 1, task.id]);
      logTaskEvent(task.id, task.openid, `AI限流/服务不可用(${err.message})，任务重新排队等待重试`, 'warning');
      return;
    }

    // 其他错误或重试次数用完，标记失败
    await db.query(
      'UPDATE usage_records SET status = "failed", error = ? WHERE id = ?',
      [err.message, task.id]
    );
  } finally {
    isProcessing--;
    console.log('[processTask] finally, isProcessing:', isProcessing);
  }
}

// ========== 创建任务 ==========
router.post('/create', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { type = 'tryon', sourceImage, targetImage, prompt } = req.body;

    // 获取价格
    const [[config]] = await db.query('SELECT price_normal, price_avatar FROM config WHERE type = "public"');
    const cost = type === 'avatar' ? (config?.price_avatar || 2) : (config?.price_normal || 1);

    // 检查次数
    const [users] = await db.query('SELECT quota FROM users WHERE openid = ?', [openid]);
    if (users.length === 0 || users[0].quota < cost) {
      return res.json({ code: -1, message: '次数不足，请先购买' });
    }

    // 检查进行中任务
    const [processing] = await db.query(
      `SELECT id FROM usage_records WHERE openid = ? AND status IN ('queued', 'processing')`,
      [openid]
    );
    if (processing.length > 0) {
      return res.json({ code: -1, message: '您有任务正在处理中' });
    }

    // 创建任务
    const [result] = await db.query(
      `INSERT INTO usage_records (openid, type, source_image, target_image, prompt, cost, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', NOW())`,
      [openid, type, sourceImage, targetImage, prompt || '', cost]
    );

    initTryonTask(result.insertId, openid);
    logTaskEvent(result.insertId, openid, `任务已创建，等待调度器处理`, 'info');
    res.json({ code: 0, data: { id: result.insertId }, message: '任务已提交，请稍后查询结果' });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// ========== 查询任务 ==========
router.post('/detail', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { id } = req.body;

    const [tasks] = await db.query(
      'SELECT * FROM usage_records WHERE id = ? AND openid = ?',
      [id, openid]
    );

    if (tasks.length === 0) return res.json({ code: -1, message: '任务不存在' });

    res.json({ code: 0, data: tasks[0] });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// ========== 查询记录 ==========
router.post('/records', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { page = 1, pageSize = 10 } = req.body;
    const offset = (page - 1) * pageSize;

    const [list] = await db.query(
      'SELECT * FROM usage_records WHERE openid = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [openid, pageSize, offset]
    );

    res.json({ code: 0, data: { list } });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// ========== 删除记录 ==========
router.post('/delete', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { id } = req.body;

    // 获取记录，验证权限
    const [[record]] = await db.query('SELECT * FROM usage_records WHERE id = ? AND openid = ?', [id, openid]);
    if (!record) return res.json({ code: -1, message: '记录不存在' });

    // 删除COS图片
    if (record.result_image && record.result_image.startsWith('http')) {
      try {
        const urlObj = new URL(record.result_image);
        const key = urlObj.pathname.substring(1);
        await deleteFile(key);
      } catch (err) {
        console.error('[deleteUsage] 删除COS文件失败:', err.message);
      }
    }

    // 删除数据库记录
    await db.query('DELETE FROM usage_records WHERE id = ?', [id]);
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// ========== 辅助函数 ==========

// 下载图片转 base64
async function downloadImage(url) {
  if (!url) throw new Error('图片地址为空');

  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const ext = url.includes('.png') ? 'image/png' : 'image/jpeg';
  return `data:${ext};base64,` + buffer.toString('base64');
}

// 调用 AI（generateContent 格式，谷歌Gemini风格）
async function callAI(sourceBase64, targetBase64, prompt, model) {
  const [[aiConfig]] = await db.query('SELECT api_url, model, prompt FROM config WHERE type = "ai" LIMIT 1');
  const apiUrl = aiConfig?.api_url || 'https://api.apiyi.com/v1';
  const apiKey = process.env.AI_API_KEY;
  const modelName = model || aiConfig?.model || 'gemini-3.1-flash-image-preview';
  const promptText = aiConfig?.prompt || prompt || 'Replace the hairstyle in the first image with the hairstyle in the second image';

  console.log('[callAI] 配置 - apiUrl:', apiUrl, 'model:', modelName, 'apiKey存在:', !!apiKey);

  if (!apiKey) throw new Error('AI API密钥未配置');

  try {
    // 压缩图片（限制宽度512px，减少token消耗）
    let sourceBuffer, targetBuffer;
    try {
      const sharp = require('sharp');
      sourceBuffer = await compressImage(sourceBase64, sharp);
      targetBuffer = await compressImage(targetBase64, sharp);
      console.log('[callAI] 压缩后 source:', (sourceBuffer.length/1024).toFixed(1) + 'KB', 'target:', (targetBuffer.length/1024).toFixed(1) + 'KB');
    } catch (compressErr) {
      console.log('[callAI] 图片压缩失败，使用原图:', compressErr.message);
      const base64Str1 = sourceBase64.replace(/^data:image\/\w+;base64,/, '');
      const base64Str2 = targetBase64.replace(/^data:image\/\w+;base64,/, '');
      sourceBuffer = Buffer.from(base64Str1, 'base64');
      targetBuffer = Buffer.from(base64Str2, 'base64');
    }

    // generateContent 格式（谷歌Gemini风格）
    const requestBody = {
      contents: [{
        parts: [
          { text: promptText },
          { inlineData: { mimeType: 'image/jpeg', data: sourceBuffer.toString('base64') } },
          { inlineData: { mimeType: 'image/jpeg', data: targetBuffer.toString('base64') } }
        ]
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '9:16', imageSize: '2K' }
      }
    };

    console.log('[callAI] 发送请求到', apiUrl.replace('/v1', '') + '/v1beta/models/' + modelName + ':generateContent', 'body大小:', JSON.stringify(requestBody).length);
    const requestTime = new Date().toISOString();
    console.log('[callAI] ★请求发送时间:', requestTime);

    const response = await axios.post(apiUrl.replace('/v1', '') + '/v1beta/models/' + modelName + ':generateContent', requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: 600000,
      timeoutErrorMessage: 'AI请求超时(600秒)'
    });

    const responseTime = new Date().toISOString();
    console.log('[callAI] ★收到响应, status:', response.status, '响应时间:', responseTime);

    const data = response.data;
    console.log('[callAI] 响应数据:', JSON.stringify(data).substring(0, 500));

    if (data.error) {
      throw new Error('AI错误: ' + (data.error.message || JSON.stringify(data.error)));
    }

    // 提取结果（inlineData）
    const resultBase64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!resultBase64) {
      console.log('[callAI] 无法解析结果, data keys:', Object.keys(data || {}));
      console.log('[callAI] candidates:', JSON.stringify(data?.candidates));
      throw new Error('AI返回格式错误: ' + JSON.stringify(data).substring(0, 100));
    }

    console.log('[callAI] 成功, result长度:', resultBase64.length);
    return resultBase64;

  } catch (err) {
    console.log('[callAI] 捕获异常:', err.name, err.message);
    if (err.code === 'ECONNABORTED') {
      throw new Error('AI请求超时(600秒)');
    }
    // axios 把 HTTP 错误码放在 err.response.status
    if (err.response?.status) {
      throw new Error(`AI服务错误(${err.response.status}): ${err.message}`);
    }
    throw err;
  }
}

// 压缩图片（限制宽度512px）
async function compressImage(base64Data, sharp) {
  // 提取原始buffer
  const ext = base64Data.match(/^data:image\/(\w+);base64,/)?.[1] || 'jpeg';
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
  const base64Str = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Str, 'base64');

  // 压缩：如果宽度超过512就缩小
  const image = sharp(buffer);
  const metadata = await image.metadata();
  const width = metadata.width || 512;

  if (width > 512) {
    return await image.resize(512).jpeg({ quality: 80 }).toBuffer();
  }
  return await image.jpeg({ quality: 80 }).toBuffer();
}

// 分佣（暂时禁用）
async function distributeCommission(openid, cost) {
  return; // 禁用，users表无agent_id字段
}

// ========== 清理7天前的换发记录和COS图片 ==========
async function cleanupOldRecords() {
  try {
    // 查找7天前的已完成/失败记录
    const [oldRecords] = await db.query(
      "SELECT id, result_image FROM usage_records WHERE status IN ('completed', 'failed') AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)"
    );

    if (oldRecords.length === 0) {
      console.log('[cleanup] 没有需要清理的记录');
      return;
    }

    console.log('[cleanup] 发现', oldRecords.length, '条过期记录需要清理');

    for (const record of oldRecords) {
      // 删除COS图片
      if (record.result_image && record.result_image.startsWith('http')) {
        try {
          // 从URL提取COS key
          const urlObj = new URL(record.result_image);
          const key = urlObj.pathname.substring(1); // 去掉开头的/
          await deleteFile(key);
          console.log('[cleanup] 已删除COS文件:', key);
        } catch (cosErr) {
          console.error('[cleanup] 删除COS文件失败:', cosErr.message);
        }
      }
      // 删除数据库记录
      await db.query('DELETE FROM usage_records WHERE id = ?', [record.id]);
      console.log('[cleanup] 已删除记录:', record.id);
    }
  } catch (err) {
    console.error('[cleanup] 清理失败:', err.message);
  }
}

// 每天凌晨3点执行清理
setInterval(cleanupOldRecords, 24 * 60 * 60 * 1000);
setTimeout(cleanupOldRecords, 3 * 60 * 60 * 1000); // 启动3小时后首次执行

module.exports = router;
