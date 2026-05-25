const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const https = require('https');

// 微信 code 换 openid
async function codeToOpenid(code) {
  return new Promise((resolve, reject) => {
    const appId = process.env.MINI_APP_ID;
    const appSecret = process.env.MINI_APP_SECRET;
    if (!appSecret) {
      reject(new Error('MINI_APP_SECRET not configured'));
      return;
    }
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errcode) {
            reject(new Error(json.errmsg || 'code exchange failed'));
          } else {
            resolve(json.openid);
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// 静默登录
router.post('/', async (req, res) => {
  try {
    const { code, nickname, avatarUrl, agentCode } = req.body;

    if (!code) {
      return res.json({ code: -1, message: 'code不能为空' });
    }

    // 用 code 换 openid
    let openid;
    try {
      openid = await codeToOpenid(code);
    } catch (e) {
      console.error('code exchange error:', e.message);
      return res.json({ code: -1, message: '登录失败: ' + e.message });
    }

    // 查找用户
    const [users] = await db.query('SELECT * FROM users WHERE openid = ?', [openid]);
    
    if (users.length > 0) {
      // 更新用户信息
      const user = users[0];
      await db.query(
        'UPDATE users SET nickname = ?, avatarUrl = ? WHERE openid = ?',
        [nickname || user.nickname, avatarUrl || user.avatarUrl, openid]
      );

      return res.json({ code: 0, data: { ...user, nickname: nickname || user.nickname, avatarUrl: avatarUrl || user.avatarUrl } });
    } else {
      // 创建新用户
      const [result] = await db.query(
        'INSERT INTO users (openid, nickname, avatarUrl, quota, created_at) VALUES (?, ?, ?, 0, NOW())',
        [openid, nickname || '微信用户', avatarUrl || '']
      );

      return res.json({
        code: 0,
        data: {
          id: result.insertId,
          openid,
          nickname: nickname || '微信用户',
          avatarUrl: avatarUrl || '',
          quota: 0
        }
      });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.json({ code: -1, message: err.message });
  }
});

module.exports = router;