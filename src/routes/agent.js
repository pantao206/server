const express = require('express');
const router = express.Router();
const db = require('../utils/db');

// 获取代理信息
router.post('/getInfo', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    if (!openid) return res.json({ code: -1, message: '未登录' });

    // 先检查是否有任何状态的代理申请
    const [agents] = await db.query('SELECT * FROM agents WHERE openid = ?', [openid]);

    if (agents.length === 0) {
      return res.json({
        code: 0,
        data: { isAgent: false, hasPendingApplication: false }
      });
    }

    const agent = agents[0];

    // 只有 active 状态才算正式代理
    if (agent.status === 'active') {
      return res.json({
        code: 0,
        data: {
          isAgent: true,
          hasPendingApplication: false,
          agentId: agent.id,
          code: agent.code,
          name: agent.name,
          phone: agent.phone,
          balance: agent.balance,
          totalEarned: agent.total_earned,
          totalReferred: agent.total_referred
        }
      });
    }

    // pending 或其他非active状态 -> 待审核
    return res.json({
      code: 0,
      data: {
        isAgent: false,
        hasPendingApplication: true,
        pendingAgent: {
          id: agent.id,
          name: agent.name,
          phone: agent.phone,
          status: agent.status,
          createdAt: agent.created_at
        }
      }
    });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// 申请代理
router.post('/apply', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { name, phone } = req.body;

    if (!name || !phone) return res.json({ code: -1, message: '请填写姓名和手机号' });

    // 检查是否已是代理（已通过或待审核都不能再申请）
    const [existing] = await db.query('SELECT * FROM agents WHERE openid = ? AND status IN ("active", "pending")', [openid]);
    if (existing.length > 0) return res.json({ code: -1, message: '您已经申请过代理了，请等待审核' });

    // TODO: 申请门槛检查（暂时禁用）
    // const [orders] = await db.query(
    //   'SELECT SUM(amount) as total FROM orders WHERE openid = ? AND status = "paid"', [openid]
    // );
    // const totalConsumed = orders[0]?.total || 0;
    // if (totalConsumed < 10) {
    //   return res.json({ code: -1, message: `累计消费满10元才能申请代理，当前消费：${totalConsumed.toFixed(2)}元` });
    // }

    // 创建申请
    const code = 'AG' + Date.now().toString(36).toUpperCase();
    await db.query(
      'INSERT INTO agents (openid, name, phone, code, commission, status, balance, total_earned, total_referred, created_at) VALUES (?, ?, ?, ?, 30, "pending", 0, 0, 0, NOW())',
      [openid, name, phone, code]
    );

    res.json({ code: 0, data: { status: 'pending', message: '申请已提交，等待审核' } });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// 申请提现
router.post('/applyWithdraw', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { amount, alipayAccount, alipayName } = req.body;

    if (!amount || amount < 10) return res.json({ code: -1, message: '提现金额最低10元' });
    if (!alipayAccount || !alipayName) return res.json({ code: -1, message: '请填写支付宝信息' });

    const [agents] = await db.query('SELECT * FROM agents WHERE openid = ? AND status = "active"', [openid]);
    if (agents.length === 0) return res.json({ code: -1, message: '非代理用户' });
    const agent = agents[0];

    if (agent.balance < amount) return res.json({ code: -1, message: '余额不足' });

    // 检查每天限1次
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [todayWithdrawals] = await db.query(
      'SELECT * FROM agent_withdrawals WHERE agent_id = ? AND created_at >= ?',
      [agent.id, today]
    );
    if (todayWithdrawals.length > 0) {
      return res.json({ code: -1, message: '每天仅能申请提现一次，今日已申请' });
    }

    // 扣除余额
    await db.query('UPDATE agents SET balance = balance - ? WHERE id = ?', [amount, agent.id]);

    // 创建提现记录
    const withdrawNo = 'WD' + Date.now().toString(36).toUpperCase();
    await db.query(
      'INSERT INTO agent_withdrawals (agent_id, agent_name, agent_phone, alipay_account, alipay_name, amount, withdraw_no, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, "pending", NOW())',
      [agent.id, agent.name, agent.phone, alipayAccount, alipayName, amount, withdrawNo]
    );

    // 记录佣金明细（提现支出）
    await db.query(
      'INSERT INTO agent_incomes (agent_id, openid, source, description, amount, status, created_at) VALUES (?, ?, "withdraw", ?, ?, "completed", NOW())',
      [agent.id, openid, `提现申请（${withdrawNo}）`, -amount]
    );

    res.json({ code: 0, message: '申请成功，请等待审核' });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// 获取推荐用户列表（暂时禁用，因为users表没有agent_id字段）
router.post('/referrals', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { page = 1, pageSize = 10 } = req.body;
    const offset = (page - 1) * pageSize;

    const [agents] = await db.query('SELECT id, code FROM agents WHERE openid = ? AND status = "active"', [openid]);
    if (agents.length === 0) return res.json({ code: -1, message: '非代理用户' });

    const agent = agents[0];

    // 通过 agent_code 查找推荐的用户
    const [users] = await db.query(
      'SELECT nickname, avatarUrl, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [agent.code, pageSize, offset]
    );

    const list = users.map(u => ({
      nickname: u.nickname || '微信用户',
      avatarUrl: u.avatarUrl,
      createdAt: u.created_at
    }));

    res.json({ code: 0, data: { list } });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// 获取佣金明细
router.post('/incomes', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { page = 1, pageSize = 10 } = req.body;
    const offset = (page - 1) * pageSize;

    const [agents] = await db.query('SELECT id FROM agents WHERE openid = ? AND status = "active"', [openid]);
    if (agents.length === 0) return res.json({ code: -1, message: '非代理用户' });

    const agentId = agents[0].id;

    const [records] = await db.query(
      'SELECT * FROM agent_incomes WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [agentId, pageSize, offset]
    );

    const list = records.map(r => ({
      id: r.id,
      description: r.description,
      amount: r.amount,
      source: r.source,
      createdAt: r.created_at
    }));

    res.json({ code: 0, data: { list } });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// 获取提现记录
router.post('/getWithdrawals', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { page = 1, pageSize = 10 } = req.body;
    const offset = (page - 1) * pageSize;

    const [agents] = await db.query('SELECT id FROM agents WHERE openid = ? AND status = "active"', [openid]);
    if (agents.length === 0) return res.json({ code: -1, message: '非代理用户' });

    const agentId = agents[0].id;

    const [records] = await db.query(
      'SELECT * FROM agent_withdrawals WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [agentId, pageSize, offset]
    );

    const list = records.map(r => ({
      id: r.id,
      amount: r.amount,
      alipayAccount: r.alipay_account,
      alipayName: r.alipay_name,
      status: r.status,
      createdAt: r.created_at
    }));

    res.json({ code: 0, data: { list } });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

module.exports = router;