const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { getMonitorData, updateTaskStats, getTryonTasksData, setTryonStoragePath, getTryonStoragePath } = require('../utils/monitor');

// 统一入口
router.post('/', async (req, res) => {
  try {
    const { action, data, adminToken } = req.body;
    if (!action) return res.json({ code: -1, message: '缺少action参数' });

    // 登录
    if (action === 'login') {
      const { username, password } = data || {};
      if (!username || !password) return res.json({ code: -1, message: '请输入账号和密码' });
      const [admins] = await db.query('SELECT * FROM admin_users WHERE username = ? AND password = ? AND status = "active"', [username, password]);
      if (admins.length === 0) return res.json({ code: -1, message: '账号或密码错误' });
      const token = 'admin_' + Date.now() + '_' + Math.random().toString(36).substr(2);
      await db.query('UPDATE admin_users SET token = ? WHERE id = ?', [token, admins[0].id]);
      return res.json({ code: 0, data: { token } });
    }

    // 验证
    if (!adminToken) return res.json({ code: -1, message: '未授权' });
    const [admins] = await db.query('SELECT * FROM admin_users WHERE token = ? AND status = "active"', [adminToken]);
    if (admins.length === 0) return res.json({ code: -1, message: '非管理员' });

    const d = data || {};

    switch (action) {
      case 'dashboard': return loadDashboard(res);
      case 'userList': return loadUserList(res, d);
      case 'userUpdate': return updateUser(res, d);
      case 'userDelete': return deleteUser(res, d);
      case 'orderList': return loadOrderList(res, d);
      case 'orderUpdate': return updateOrder(res, d);
      case 'usageList': return loadUsageList(res, d);
      case 'usageDelete': return deleteUsageRecord(res, d);
      case 'categoryList': return loadCategoryList(res);
      case 'categoryCreate': return createCategory(res, d);
      case 'categoryUpdate': return updateCategory(res, d);
      case 'categoryDelete': return deleteCategory(res, d);
      case 'hairstyleList': return loadHairstyleList(res, d);
      case 'hairstyleCreate': return createHairstyle(res, d);
      case 'hairstyleUpdate': return updateHairstyle(res, d);
      case 'hairstyleDelete': return deleteHairstyle(res, d);
      case 'uploadHairstyleImage': return uploadHairstyleImage(res, d);
      case 'agentList': return loadAgentList(res, d);
      case 'agentCreate': return createAgent(res, d);
      case 'agentUpdate': return updateAgent(res, d);
      case 'agentDelete': return deleteAgent(res, d);
      case 'withdrawalList': return loadWithdrawalList(res, d);
      case 'processWithdrawal': return processWithdrawal(res, d);
      case 'configGet': return getConfig(res);
      case 'configUpdate': return updateConfig(res, d);
      case 'apiConfigGet': return getApiConfig(res, d);
      case 'apiConfigUpdate': return updateApiConfig(res, d);
      case 'monitor': return getMonitor(req, res);
      case 'tryonList': return getTryonList(res, d);
      case 'setStoragePath': return setStoragePath(res, d);
      default: return res.json({ code: -1, message: '未知action' });
    }
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

async function loadDashboard(res) {
  const [[users]] = await db.query('SELECT COUNT(*) as total FROM users');
  const [[orders]] = await db.query('SELECT COUNT(*) as total FROM orders');
  const [[todayOrders]] = await db.query('SELECT COUNT(*) as total FROM orders WHERE DATE(created_at) = CURDATE()');
  const [[usage]] = await db.query('SELECT COUNT(*) as total FROM usage_records');
  const [[revenue]] = await db.query('SELECT SUM(amount) as total FROM orders WHERE status = "paid"');
  const [[todayRevenue]] = await db.query('SELECT SUM(amount) as total FROM orders WHERE status = "paid" AND DATE(created_at) = CURDATE()');
  res.json({ code: 0, data: { totalUsers: users.total, totalOrders: orders.total, todayOrders: todayOrders.total, totalRecords: usage.total, totalRevenue: revenue.total || 0, todayRevenue: todayRevenue.total || 0 } });
}

async function loadUserList(res, d) {
  const page = parseInt(d.page) || 1;
  const pageSize = parseInt(d.pageSize) || 15;
  const offset = (page - 1) * pageSize;
  let where = '1=1', params = [];
  if (d.keyword) { where += ' AND (nickname LIKE ? OR openid LIKE ?)'; params.push(`%${d.keyword}%`, `%${d.keyword}%`); }
  const [list] = await db.query(`SELECT * FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM users WHERE ${where}`, params);
  res.json({ code: 0, data: { list, total } });
}

async function updateUser(res, d) {
  const { id, nickName, phone, balance } = d;
  await db.query('UPDATE users SET nickname = ?, phone = ?, quota = ? WHERE openid = ?', [nickName, phone, balance, id]);
  res.json({ code: 0, message: '更新成功' });
}

async function deleteUser(res, d) {
  await db.query('DELETE FROM users WHERE openid = ?', [d._id]);
  res.json({ code: 0, message: '删除成功' });
}

async function loadOrderList(res, d) {
  const page = parseInt(d.page) || 1;
  const pageSize = parseInt(d.pageSize) || 15;
  const offset = (page - 1) * pageSize;
  let where = '1=1', params = [];
  if (d.status) { where += ' AND status = ?'; params.push(d.status); }
  if (d.keyword) { where += ' AND (openid LIKE ? OR order_no LIKE ?)'; params.push(`%${d.keyword}%`, `%${d.keyword}%`); }
  const [list] = await db.query(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM orders WHERE ${where}`, params);
  res.json({ code: 0, data: { list, total } });
}

async function updateOrder(res, d) {
  const { id, status } = d;
  await db.query('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
  res.json({ code: 0, message: '更新成功' });
}

async function loadUsageList(res, d) {
  const page = parseInt(d.page) || 1;
  const pageSize = parseInt(d.pageSize) || 15;
  const offset = (page - 1) * pageSize;
  let where = '1=1', params = [];
  if (d.status) { where += ' AND status = ?'; params.push(d.status); }
  const [list] = await db.query(`SELECT * FROM usage_records WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM usage_records WHERE ${where}`, params);
  res.json({ code: 0, data: { list, total } });
}

async function deleteUsageRecord(res, d) {
  const { id } = d;
  if (!id) return res.json({ code: -1, message: '缺少id参数' });

  // 获取记录，删除COS图片
  const [[record]] = await db.query('SELECT result_image FROM usage_records WHERE id = ?', [id]);
  if (record && record.result_image && record.result_image.startsWith('http')) {
    try {
      const urlObj = new URL(record.result_image);
      const key = urlObj.pathname.substring(1);
      const { deleteFile } = require('../utils/cos');
      await deleteFile(key);
    } catch (err) {
      console.error('[deleteUsageRecord] 删除COS文件失败:', err.message);
    }
  }

  await db.query('DELETE FROM usage_records WHERE id = ?', [id]);
  res.json({ code: 0, message: '删除成功' });
}

async function loadCategoryList(res) {
  const [list] = await db.query('SELECT * FROM categories ORDER BY sort ASC');
  res.json({ code: 0, data: list });
}

async function createCategory(res, d) {
  const { name, key, sort = 0 } = d;
  await db.query('INSERT INTO categories (name, ckey, sort, created_at) VALUES (?, ?, ?, NOW())', [name, key, sort]);
  res.json({ code: 0, message: '创建成功' });
}

async function updateCategory(res, d) {
  const { id, name, key, sort = 0 } = d;
  await db.query('UPDATE categories SET name = ?, ckey = ?, sort = ? WHERE id = ?', [name, key, sort, id]);
  res.json({ code: 0, message: '更新成功' });
}

async function deleteCategory(res, d) {
  await db.query('DELETE FROM categories WHERE id = ?', [d._id]);
  res.json({ code: 0, message: '删除成功' });
}

async function loadHairstyleList(res, d) {
  const { category = '' } = d;
  let where = '1=1', params = [];
  if (category) { where += ' AND category = ?'; params.push(category); }
  const [list] = await db.query(`SELECT * FROM hairstyles WHERE ${where} ORDER BY sort ASC`, params);
  res.json({ code: 0, data: { list, total: list.length } });
}

async function createHairstyle(res, d) {
  const { name, category, image, sort = 0, hot = false } = d;
  await db.query('INSERT INTO hairstyles (name, category, image, is_hot, sort, created_at) VALUES (?, ?, ?, ?, ?, NOW())', [name, category, image, hot ? 1 : 0, sort]);
  res.json({ code: 0, message: '创建成功' });
}

async function updateHairstyle(res, d) {
  const { id, name, category, image, sort = 0, hot = false } = d;
  await db.query('UPDATE hairstyles SET name = ?, category = ?, image = ?, is_hot = ?, sort = ?, updated_at = NOW() WHERE id = ?', [name, category, image, hot ? 1 : 0, sort, id]);
  res.json({ code: 0, message: '更新成功' });
}

async function deleteHairstyle(res, d) {
  await db.query('DELETE FROM hairstyles WHERE id = ?', [d._id]);
  res.json({ code: 0, message: '删除成功' });
}

async function uploadHairstyleImage(res, d) {
  try {
    const { base64Data, filename } = d;
    console.log('[Upload] 开始上传图片, filename:', filename);
    console.log('[Upload] base64Data前50字符:', base64Data ? base64Data.substring(0, 50) : 'empty');
    
    const cos = require('../utils/cos');
    
    console.log('[Upload] COS配置检查:', {
      SecretId: process.env.COS_SECRET_ID ? '已配置' : '未配置',
      SecretKey: process.env.COS_SECRET_KEY ? '已配置' : '未配置',
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION
    });
    
    const url = await cos.uploadBase64Image(base64Data, `hairstyles/${filename || Date.now()}.jpg`);
    console.log('[Upload] 上传成功, URL:', url);
    res.json({ code: 0, data: { url } });
  } catch (err) {
    console.error('[Upload] 上传失败:', err.message);
    console.error('[Upload] 错误详情:', err);
    res.json({ code: -1, message: err.message });
  }
}

async function loadAgentList(res, d) {
  const page = parseInt(d.page) || 1;
  const pageSize = parseInt(d.pageSize) || 15;
  const offset = (page - 1) * pageSize;
  let where = '1=1', params = [];
  if (d.status) { where += ' AND status = ?'; params.push(d.status); }
  if (d.keyword) { where += ' AND (name LIKE ? OR phone LIKE ? OR code LIKE ?)'; params.push(`%${d.keyword}%`, `%${d.keyword}%`, `%${d.keyword}%`); }
  const [list] = await db.query(`SELECT * FROM agents WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM agents WHERE ${where}`, params);
  res.json({ code: 0, data: { list, total } });
}

async function createAgent(res, d) {
  const { name, phone, code = '', commission = 30 } = d;
  const finalCode = code || 'A' + Date.now();
  await db.query('INSERT INTO agents (name, phone, code, commission, status, created_at) VALUES (?, ?, ?, ?, "active", NOW())', [name, phone, finalCode, commission]);
  res.json({ code: 0, message: '创建成功' });
}

async function updateAgent(res, d) {
  const { _id, name, phone, commission, status, balance } = d;

  // 拒绝申请时直接删除记录
  if (status === 'rejected') {
    await db.query('DELETE FROM agents WHERE id = ? AND status = "pending"', [_id]);
    return res.json({ code: 0, message: '已拒绝并删除申请' });
  }

  // 批准申请时只更新 status，不更新 name/phone（否则会覆盖成 null）
  if (status === 'active' && !name && !phone) {
    await db.query('UPDATE agents SET status = ? WHERE id = ?', [status, _id]);
    return res.json({ code: 0, message: '更新成功' });
  }

  await db.query('UPDATE agents SET name = ?, phone = ?, commission = ?, status = ?, balance = ? WHERE id = ?',
    [name || null, phone || null, commission || null, status || null, balance || null, _id]);
  res.json({ code: 0, message: '更新成功' });
}

async function deleteAgent(res, d) {
  await db.query('DELETE FROM agents WHERE id = ?', [d._id]);
  res.json({ code: 0, message: '删除成功' });
}

async function loadWithdrawalList(res, d) {
  const { status = '' } = d;
  let where = '1=1', params = [];
  if (status) { where += ' AND status = ?'; params.push(status); }
  const [list] = await db.query(`SELECT w.*, a.name as agentName, a.phone as agentPhone, a.balance as agentBalance FROM agent_withdrawals w LEFT JOIN agents a ON w.agent_id = a.id WHERE ${where} ORDER BY w.created_at DESC`, params);
  res.json({ code: 0, data: { list } });
}

async function processWithdrawal(res, d) {
  const { id, action } = d;
  if (action === 'complete') await db.query('UPDATE agent_withdrawals SET status = "completed", updated_at = NOW() WHERE id = ?', [id]);
  res.json({ code: 0, message: '处理成功' });
}

async function getConfig(res) {
  const [[config]] = await db.query('SELECT * FROM config WHERE type = "public"');
  res.json({ code: 0, data: config || {} });
}

async function updateConfig(res, d) {
  const { max_concurrent = 100, welcome_text = '' } = d;
  await db.query(`INSERT INTO config (type, max_concurrent, welcome_text, updated_at) VALUES ("public", ?, ?, NOW()) ON DUPLICATE KEY UPDATE max_concurrent = ?, welcome_text = ?, updated_at = NOW()`, [max_concurrent, welcome_text, max_concurrent, welcome_text]);
  res.json({ code: 0, message: '保存成功' });
}

async function getApiConfig(res, d) {
  const { type = 'ai' } = d;
  const [[config]] = await db.query('SELECT * FROM config WHERE type = ?', [type]);
  res.json({ code: 0, data: config || {} });
}

async function updateApiConfig(res, d) {
  const { type = 'ai', api_url = '', model = '', prompt = '', price_normal, price_avatar, max_concurrent } = d;
  try {
    // 构建更新字段
    let updates = [];
    let params = [];
    if (api_url !== undefined) { updates.push('api_url = ?'); params.push(api_url); }
    if (model !== undefined) { updates.push('model = ?'); params.push(model); }
    if (prompt !== undefined) { updates.push('prompt = ?'); params.push(prompt); }
    if (price_normal !== undefined) { updates.push('price_normal = ?'); params.push(price_normal); }
    if (price_avatar !== undefined) { updates.push('price_avatar = ?'); params.push(price_avatar); }
    if (max_concurrent !== undefined) { updates.push('max_concurrent = ?'); params.push(max_concurrent); }

    if (updates.length === 0) {
      return res.json({ code: -1, message: '没有要保存的配置' });
    }

    params.push(type);

    const [result] = await db.query(
      `UPDATE config SET ${updates.join(', ')}, updated_at = NOW() WHERE type = ?`,
      params
    );

    // 如果没有匹配到记录，则插入
    if (result.affectedRows === 0) {
      const fields = [...updates.map(u => u.split(' = ')[0]), 'type', 'created_at', 'updated_at'];
      const placeholders = updates.map(() => '?').join(', ');
      const values = [...params.slice(0, -1), type, 'NOW()', 'NOW()'];
      await db.query(
        `INSERT INTO config (${fields.join(', ')}) VALUES (${placeholders}, ?, ?, ?)`,
        values
      );
    }
    res.json({ code: 0, message: '保存成功' });
  } catch (err) {
    console.error('[updateApiConfig] SQL执行失败:', err.message);
    res.json({ code: -1, message: err.message });
  }
}

async function getMonitor(req, res) {
  try {
    // 更新任务统计
    const [[taskStats]] = await db.query(`
      SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM usage_records
    `);

    const data = getMonitorData();
    data.taskStats = taskStats;

    res.json({ code: 0, data });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
}

async function getTryonList(res, d) {
  try {
    const { page = 1, pageSize = 30 } = d || {};
    const data = getTryonTasksData(page, pageSize);
    res.json({ code: 0, data });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
}

async function setStoragePath(res, d) {
  try {
    const { path: p } = d || {};
    if (!p) return res.json({ code: -1, message: '请提供路径' });
    setTryonStoragePath(p);
    res.json({ code: 0, message: '存储路径已设置' });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
}

module.exports = router;