const express = require('express');
const router = express.Router();
const db = require('../utils/db');

// ========== 配置 ==========
const MAX_CONCURRENT = 100; // 最多同时处理任务数，从 config.max_concurrent 读取
const MAX_RPM = 3000; // 每分钟最多请求数，从 config.max_rpm 读取
const MAX_PER_SECOND = 40; // 每秒最多发给AI的任务数，防止突发压力
const RETRY_MAX = 3; // 最大重试次数
const RETRY_DELAY_BASE = 2000; // 基础重试延迟（毫秒），指数退避

// ========== 状态 ==========
let isProcessing = 0; // 当前正在处理的任务数
let lastProcessTime = Date.now();
let rpmToken = MAX_RPM; // 当前的 RPM token
let lastRpmReset = Date.now();

// ========== 定时器（每100ms检查一次）==========
setInterval(async () => {
  try {
    if (isProcessing >= MAX_CONCURRENT) return;

    const [[task]] = await db.query(
      'SELECT * FROM usage_records WHERE status = "queued" ORDER BY created_at ASC LIMIT 1'
    );

    if (!task) return;

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

    // 获取任务详情
    const [[taskDetail]] = await db.query('SELECT * FROM usage_records WHERE id = ?', [task.id]);
    if (!taskDetail) {
      isProcessing--;
      return;
    }

    // 下载图片
    const sourceBase64 = await downloadImage(taskDetail.source_image);
    const targetBase64 = await downloadImage(taskDetail.target_image);

    // 调用 AI
    const promptText = taskDetail.prompt || 'Replace the hairstyle in the first image with the hairstyle in the second image';
    const result = await callAI(sourceBase64, targetBase64, promptText);

    // 完成
    await db.query(
      'UPDATE usage_records SET status = "completed", result_image = ? WHERE id = ?',
      [result, task.id]
    );

    // 扣除次数
    await db.query('UPDATE users SET quota = quota - ? WHERE openid = ?', [taskDetail.cost, taskDetail.openid]);

    // 分佣
    await distributeCommission(taskDetail.openid, taskDetail.cost);

  } catch (err) {
    console.error('Process task error:', err);

    // 如果是 429 错误且还能重试，放回队列等调度器重试
    if (err.message.includes('429') && retryCount < RETRY_MAX) {
      await db.query('UPDATE usage_records SET status = "queued", retry_count = ? WHERE id = ?', [retryCount + 1, task.id]);
      isProcessing--;
      return;
    }

    // 其他错误或重试次数用完，标记失败
    await db.query(
      'UPDATE usage_records SET status = "failed", error = ? WHERE id = ?',
      [err.message, task.id]
    );
  } finally {
    isProcessing--;
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

// 调用 AI
async function callAI(sourceBase64, targetBase64, prompt) {
  const [[aiConfig]] = await db.query('SELECT api_url, model, prompt FROM config WHERE type = "ai" LIMIT 1');
  const apiUrl = aiConfig?.api_url || process.env.AI_API_URL || 'https://api.apiyi.com';
  const apiKey = process.env.AI_API_KEY;  // api_key 直接从 .env 读取
  const model = aiConfig?.model || process.env.AI_MODEL || 'gemini-2.0-flash';
  const promptText = aiConfig?.prompt || prompt || 'Replace the hairstyle';

  if (!apiKey) throw new Error('AI API密钥未配置');

  // 设置120秒超时
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: sourceBase64 } },
            { type: 'image_url', image_url: { url: targetBase64 } }
          ]
        }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (response.status === 429) {
      throw new Error('429');
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API错误 ${response.status}: ${errText}`);
    }

    const data = await response.json();
    console.log('[callAI] AI响应:', JSON.stringify(data).substring(0, 200));

    // 检查不同返回格式
    let result = data.choices?.[0]?.message?.content;
    if (!result && data.result) {
      result = data.result;
    }
    if (!result && data.output) {
      result = data.output;
    }
    if (!result && data.text) {
      result = data.text;
    }

    if (!result) {
      throw new Error('AI返回格式错误: ' + JSON.stringify(data).substring(0, 100));
    }
    return result;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('AI请求超时(120秒)');
    }
    throw err;
  }
}

// 分佣（暂时禁用）
async function distributeCommission(openid, cost) {
  return; // 禁用，users表无agent_id字段
}

module.exports = router;
