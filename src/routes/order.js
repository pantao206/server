const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const crypto = require('crypto');

// 微信支付相关配置
const WX_PAY = {
  mchId: process.env.WX_MCHID,
  serialNo: process.env.WX_CERT_SERIAL,
  privateKey: process.env.WX_PRIVATE_KEY,
  apiV3Key: process.env.WX_API_V3_KEY
};

// 创建订单
router.post('/create', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { total_fee, body, quota } = req.body;

    if (!total_fee || !body) return res.json({ code: -1, message: '参数缺失' });

    const outTradeNo = Date.now().toString() + Math.random().toString().substr(2, 9);

    // 创建订单记录
    await db.query(
      `INSERT INTO orders (openid, out_trade_no, type, amount, quota, status, created_at) VALUES (?, ?, "purchase", ?, ?, "pending", NOW())`,
      [openid, outTradeNo, total_fee / 100, quota]
    );

    // 构建微信支付参数
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const packageStr = 'prepay_id=test'; // 实际需要调用微信支付统一下单

    // 签名
    const paySignStr = process.env.MINI_APP_ID + '\n' + timeStamp + '\n' + nonceStr + '\n' + packageStr + '\n';
    const paySign = crypto.createSign('RSA-SHA256').update(paySignStr).sign(WX_PAY.privateKey, 'base64');

    res.json({
      code: 0,
      data: {
        appId: process.env.MINI_APP_ID,
        timeStamp,
        nonceStr,
        package: packageStr,
        paySign
      }
    });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// 支付回调
router.post('/notify', async (req, res) => {
  try {
    const data = req.body;
    
    if (data.event_type === 'TRANSACTION.SUCCESS') {
      const { out_trade_no, transaction_id, amount } = data.resource;
      
      // 更新订单状态
      await db.query(
        'UPDATE orders SET status = "paid", transaction_id = ?, paid_at = NOW() WHERE out_trade_no = ?',
        [transaction_id, out_trade_no]
      );

      // 发放次数
      const [[order]] = await db.query('SELECT openid, quota FROM orders WHERE out_trade_no = ?', [out_trade_no]);
      if (order) {
        await db.query('UPDATE users SET quota = quota + ? WHERE openid = ?', [order.quota, order.openid]);
      }
    }

    res.xml({ code: 'SUCCESS', message: 'OK' });
  } catch (err) {
    console.error('Pay notify error:', err);
    res.xml({ code: 'FAIL', message: err.message });
  }
});

// 获取订单列表
router.post('/list', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { page = 1, pageSize = 20 } = req.body;
    const offset = (page - 1) * pageSize;

    const [list] = await db.query(
      'SELECT * FROM orders WHERE openid = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [openid, pageSize, offset]
    );

    res.json({ code: 0, data: { list } });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

module.exports = router;