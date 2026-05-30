const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const crypto = require('crypto');
const axios = require('axios');

// 微信支付配置
const WX_PAY = {
  appId: process.env.MINI_APP_ID,
  mchId: process.env.WX_MCHID,
  serialNo: process.env.WX_CERT_SERIAL,
  privateKey: process.env.WX_PRIVATE_KEY,
  apiV3Key: process.env.WX_API_V3_KEY,
  notifyUrl: process.env.WX_NOTIFY_URL || 'https://你的域名/api/order/notify'
};

// 微信支付API基础URL
const WX_PAY_BASE_URL = 'https://api.mch.weixin.qq.com';

// ========== 创建订单 ==========
router.post('/create', async (req, res) => {
  try {
    const openid = req.headers['x-openid'];
    const { total_fee, body, quota } = req.body;

    if (!total_fee || !body) return res.json({ code: -1, message: '参数缺失' });

    // 生成订单号
    const outTradeNo = Date.now().toString() + Math.random().toString().substr(2, 9);

    // 创建订单记录
    await db.query(
      `INSERT INTO orders (openid, out_trade_no, type, amount, quota, status, created_at) VALUES (?, ?, "purchase", ?, ?, "pending", NOW())`,
      [openid, outTradeNo, total_fee / 100, quota]
    );

    // 调用微信支付统一下单
    const prepayId = await createUnifiedOrder({
      outTradeNo,
      totalFee: total_fee, // 单位：分
      description: body,
      openid: openid
    });

    if (!prepayId) {
      return res.json({ code: -1, message: '支付创建失败' });
    }

    // 返回调起支付所需参数
    const payParams = await getPayParams(prepayId);

    res.json({
      code: 0,
      data: payParams
    });
  } catch (err) {
    console.error('[Order] 创建订单失败:', err);
    res.json({ code: -1, message: err.message });
  }
});

// ========== 微信支付回调 ==========
router.post('/notify', async (req, res) => {
  try {
    const data = req.body;

    if (data.event_type === 'TRANSACTION_SUCCESS') {
      const { out_trade_no, transaction_id, amount } = data.resource;

      // 查询订单
      const [[order]] = await db.query('SELECT * FROM orders WHERE out_trade_no = ?', [out_trade_no]);

      if (order && order.status !== 'paid') {
        // 更新订单状态
        await db.query(
          'UPDATE orders SET status = "paid", transaction_id = ?, paid_at = NOW() WHERE out_trade_no = ?',
          [transaction_id, out_trade_no]
        );

        // 发放次数
        await db.query('UPDATE users SET quota = quota + ? WHERE openid = ?', [order.quota, order.openid]);

        console.log('[Order] 支付成功，订单:', out_trade_no, '用户:', order.openid, '发放配额:', order.quota);
      }
    }

    res.json({ code: 'SUCCESS', message: 'OK' });
  } catch (err) {
    console.error('[Order] 回调处理失败:', err);
    res.json({ code: 'FAIL', message: err.message });
  }
});

// ========== 获取订单列表 ==========
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

// ========== 查询订单状态 ==========
router.post('/query', async (req, res) => {
  try {
    const { out_trade_no } = req.body;

    const [[order]] = await db.query('SELECT status FROM orders WHERE out_trade_no = ?', [out_trade_no]);

    if (!order) return res.json({ code: -1, message: '订单不存在' });

    res.json({ code: 0, data: { status: order.status } });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// ========== 微信支付统一下单 ==========
async function createUnifiedOrder(params) {
  const { outTradeNo, totalFee, description, openid } = params;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');

  // 构建请求体
  const reqBody = {
    appid: WX_PAY.appId,
    mchid: WX_PAY.mchId,
    description: description,
    out_trade_no: outTradeNo,
    notify_url: WX_PAY.notifyUrl,
    amount: {
      total: totalFee,
      currency: 'CNY'
    },
    payer: {
      openid: openid
    }
  };

  // 构建签名
  const signStr = buildPaySignStr({
    method: 'POST',
    url: '/v3/pay/transactions/app',
    timestamp,
    nonceStr,
    body: JSON.stringify(reqBody)
  });

  const signature = sign(WX_PAY.privateKey, signStr);

  // 发送请求
  try {
    const response = await axios.post(
      WX_PAY_BASE_URL + '/v3/pay/transactions/app',
      reqBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `WECHATPAY2-SHA256-RSA2048 mchid="${WX_PAY.mchId}",serial_no="${WX_PAY.serialNo}",timestamp="${timestamp}",nonce_str="${nonceStr}",signature="${signature}"`,
          'User-Agent': 'Mozilla/5.0'
        },
        timeout: 30000
      }
    );

    console.log('[createUnifiedOrder] 响应:', response.data);

    // 返回 prepay_id
    return response.data.prepay_id;
  } catch (err) {
    console.error('[createUnifiedOrder] 失败:', err.response?.data || err.message);
    return null;
  }
}

// ========== 获取调起支付参数 ==========
async function getPayParams(prepayId) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const packageStr = 'prepay_id=' + prepayId;

  // 签名
  const signStr = `${WX_PAY.appId}\n${timestamp}\n${nonceStr}\n${packageStr}\n`;
  const paySign = sign(WX_PAY.privateKey, signStr);

  return {
    appId: WX_PAY.appId,
    timeStamp: timestamp,
    nonceStr: nonceStr,
    package: packageStr,
    signType: 'RSA',
    paySign: paySign
  };
}

// ========== 构建签名字符串 ==========
function buildPaySignStr(params) {
  const { method, url, timestamp, nonceStr, body } = params;
  // v3 API 签名：METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n
  return `${method}\n${url}\n${timestamp}\n${nonceStr}\n${body}\n`;
}

// ========== 使用私钥签名 ==========
function sign(privateKey, message) {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  return sign.sign(privateKey, 'base64');
}

module.exports = router;