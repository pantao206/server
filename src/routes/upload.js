const express = require('express');
const router = express.Router();
const cos = require('../utils/cos');

// 上传发型图片
router.post('/hairstyle', async (req, res) => {
  try {
    const { base64Data, filename } = req.body;

    if (!base64Data) {
      return res.json({ code: -1, message: '图片数据不能为空' });
    }

    // 解析文件扩展名
    let ext = 'jpg';
    if (base64Data.includes('data:image/png')) ext = 'png';
    else if (base64Data.includes('data:image/webp')) ext = 'webp';

    // 生成存储路径
    const key = `hairstyles/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${ext}`;

    // 上传到COS
    const url = await cos.uploadBase64Image(base64Data, key);

    res.json({ code: 0, data: { url, key } });
  } catch (err) {
    console.error('Upload hairstyle error:', err);
    res.json({ code: -1, message: '上传失败: ' + err.message });
  }
});

// 上传头像
router.post('/avatar', async (req, res) => {
  try {
    const { base64Data } = req.body;

    if (!base64Data) {
      return res.json({ code: -1, message: '图片数据不能为空' });
    }

    const key = `avatars/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;
    const url = await cos.uploadBase64Image(base64Data, key);

    res.json({ code: 0, data: { url, key } });
  } catch (err) {
    console.error('Upload avatar error:', err);
    res.json({ code: -1, message: '上传失败: ' + err.message });
  }
});

// 上传用户结果图片
router.post('/result', async (req, res) => {
  try {
    const { base64Data, taskId } = req.body;

    if (!base64Data) {
      return res.json({ code: -1, message: '图片数据不能为空' });
    }

    const key = `results/${taskId || Date.now()}.jpg`;
    const url = await cos.uploadBase64Image(base64Data, key);

    res.json({ code: 0, data: { url, key } });
  } catch (err) {
    console.error('Upload result error:', err);
    res.json({ code: -1, message: '上传失败: ' + err.message });
  }
});

module.exports = router;