const express = require('express');
const router = express.Router();
const db = require('../utils/db');

// 获取公开配置
router.post('/public', async (req, res) => {
  try {
    const [[config]] = await db.query('SELECT * FROM config WHERE type = "public"');

    res.json({
      code: 0,
      data: {
        price_normal: config?.price_normal || 1,
        price_avatar: config?.price_avatar || 2,
        price_hd: config?.price_hd || 2,
        welcome_text: config?.welcome_text || '欢迎使用维创发型'
      }
    });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// 获取AI配置
router.post('/ai', async (req, res) => {
  try {
    const [[config]] = await db.query('SELECT * FROM config WHERE type = "ai"');

    res.json({
      code: 0,
      data: {
        api_url: config?.api_url || 'https://api.apiyi.com',
        api_key: config?.api_key || '',
        model: config?.model || 'gemini-2.0-flash',
        prompt: config?.prompt || 'Replace the hairstyle in the first image with the hairstyle in the second image'
      }
    });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

module.exports = router;