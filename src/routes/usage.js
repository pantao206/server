const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { v4: uuidv4 } = require('uuid');

// 创建AI换发任务
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

    // 清理超时的任务
    await db.query(
      `UPDATE usage_records SET status = 'failed', error = '处理超时' 
       WHERE status IN ('queued', 'processing') AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`
    );

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

    const taskId = result.insertId;

    // 异步处理任务
    processTask(taskId).catch(err => console.error('Task failed:', err));

    res.json({ code: 0, data: { id: taskId }, message: '任务已创建' });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// 处理任务
async function processTask(taskId) {
  try {
    // 更新为处理中
    await db.query('UPDATE usage_records SET status = "processing", updated_at = NOW() WHERE id = ?', [taskId]);

    // 获取任务
    const [[task]] = await db.query('SELECT * FROM usage_records WHERE id = ?', [taskId]);
    if (!task) return;

    // 下载图片转base64
    const sourceBase64 = await downloadImage(task.source_image);
    const targetBase64 = await downloadImage(task.target_image);

    // 调用AI
    const promptText = task.prompt || 'Replace the hairstyle in the first image with the hairstyle in the second image';
    const result = await callAI(sourceBase64, targetBase64, promptText);

    // 上传结果
    const resultUrl = await uploadResult(result, taskId);

    // 更新任务为完成
    await db.query(
      'UPDATE usage_records SET status = "completed", result_image = ?, updated_at = NOW() WHERE id = ?',
      [resultUrl, taskId]
    );

    // 扣除次数
    await db.query('UPDATE users SET quota = quota - ? WHERE openid = ?', [task.cost, task.openid]);

    // 分佣给代理
    await distributeCommission(task.openid, task.cost);

  } catch (err) {
    console.error('Process task error:', err);
    await db.query(
      'UPDATE usage_records SET status = "failed", error = ?, updated_at = NOW() WHERE id = ?',
      [err.message, taskId]
    );
  }
}

// 下载图片转base64
async function downloadImage(url) {
  if (!url) throw new Error('图片地址为空');
  
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const ext = url.includes('.png') ? 'image/png' : 'image/jpeg';
  return `data:${ext};base64,` + buffer.toString('base64');
}

// 调用AI
async function callAI(sourceBase64, targetBase64, prompt) {
  // 从数据库获取AI配置
  const [[aiConfig]] = await db.query('SELECT api_url, api_key, model, prompt FROM config WHERE type = "ai" LIMIT 1');
  const apiUrl = aiConfig?.api_url || process.env.AI_API_URL || 'https://api.apiyi.com';
  const apiKey = aiConfig?.api_key || process.env.AI_API_KEY;
  const model = aiConfig?.model || process.env.AI_MODEL || 'gemini-2.0-flash';
  const promptText = aiConfig?.prompt || prompt || 'Replace the hairstyle in the first image with the hairstyle in the second image';

  if (!apiKey) {
    throw new Error('AI API密钥未配置');
  }

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
    })
  });

  const data = await response.json();
  if (!data.choices?.[0]?.message?.content) {
    throw new Error('AI返回格式错误');
  }
  return data.choices[0].message.content;
}

// 上传结果
async function uploadResult(base64Data, taskId) {
  // 这里简化处理，实际应该上传到云存储
  // 返回base64数据（实际项目中应该上传到CDN或云存储）
  return base64Data;
}

// 分佣（暂时禁用，因为users表没有agent_id字段）
async function distributeCommission(openid, cost) {
  // TODO: 需要在users表添加agent_id字段或建立推荐关系表才能实现分佣
  // 目前暂时禁用此功能
  return;
  try {
    const [users] = await db.query('SELECT agent_id FROM users WHERE openid = ?', [openid]);
    if (!users[0]?.agent_id) return;

    const [agents] = await db.query(
      'SELECT * FROM agents WHERE id = ? AND status = "active"',
      [users[0].agent_id]
    );
    if (agents.length === 0) return;

    const agent = agents[0];
    if (agent.openid === openid) return;

    const commission = Math.round(cost * (agent.commission || 30) / 100 * 100) / 100;
    if (commission <= 0) return;

    await db.query(
      'UPDATE agents SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?',
      [commission, commission, agent.id]
    );
  } catch (err) {
    console.error('Distribute commission error:', err);
  }
}

// 查询任务详情
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

// 查询使用记录
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

module.exports = router;