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
        'UPDATE users SET nickname = ?, avatar_url = ?, updated_at = NOW() WHERE openid = ?',
        [nickname || user.nickname, avatarUrl || user.avatar_url, openid]
      );
      
      // 如果有新的代理码，更新绑定关系
      if (agentCode && !user.agent_id) {
        const [agents] = await db.query('SELECT id FROM agents WHERE code = ? AND status = "active"', [agentCode]);
        if (agents.length > 0) {
          await db.query('UPDATE users SET agent_id = ? WHERE openid = ?', [agents[0].id, openid]);
          await db.query('UPDATE agents SET total_referred = total_referred + 1 WHERE id = ?', [agents[0].id]);
        }
      }
      
      return res.json({ code: 0, data: { ...user, nickname: nickname || user.nickname, avatar_url: avatarUrl || user.avatar_url } });
    } else {
      // 创建新用户
      let agentId = null;
      if (agentCode) {
        const [agents] = await db.query('SELECT id FROM agents WHERE code = ? AND status = "active"', [agentCode]);
        if (agents.length > 0) {
          agentId = agents[0].id;
          await db.query('UPDATE agents SET total_referred = total_referred + 1 WHERE id = ?', [agentId]);
        }
      }
      
      const [result] = await db.query(
        'INSERT INTO users (openid, nickname, avatar_url, agent_id, quota, created_at) VALUES (?, ?, ?, ?, 0, NOW())',
        [openid, nickname || '微信用户', avatarUrl || '', agentId]
      );
      
      return res.json({
        code: 0,
        data: {
          id: result.insertId,
          openid,
          nickname: nickname || '微信用户',
          avatar_url: avatarUrl || '',
          agent_id: agentId,
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