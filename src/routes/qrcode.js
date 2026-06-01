const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');

// 生成代理推广二维码
router.get('/:code', async (req, res) => {
  try {
    const { code } = req.params;

    // 构造小程序路径
    const pagePath = `pages/home/index?agentCode=${code}`;

    // 生成二维码图片（base64 PNG）
    const dataUrl = await QRCode.toDataURL(pagePath, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });

    // 直接返回图片
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    res.json({
      code: 0,
      data: {
        image: dataUrl,
        path: pagePath
      }
    });
  } catch (err) {
    console.error('[QRCode] 生成失败:', err.message);
    res.json({ code: -1, message: err.message });
  }
});

// POST 路由（兼容客户端）
router.post('/', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.json({ code: -1, message: '缺少code参数' });

    // 构造小程序路径
    const pagePath = `pages/home/index?agentCode=${code}`;

    // 生成二维码图片（base64 PNG）
    const dataUrl = await QRCode.toDataURL(pagePath, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });

    res.json({
      code: 0,
      data: {
        image: dataUrl,
        path: pagePath
      }
    });
  } catch (err) {
    console.error('[QRCode] 生成失败:', err.message);
    res.json({ code: -1, message: err.message });
  }
});

module.exports = router;