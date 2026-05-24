const express = require('express');
const router = express.Router();
const db = require('../utils/db');

// 获取发型列表
router.post('/list', async (req, res) => {
  try {
    const { page = 1, pageSize = 20, category, hot } = req.body;
    const offset = (page - 1) * pageSize;
    
    let where = '1=1';
    const params = [];
    if (category) { where += ' AND category = ?'; params.push(category); }
    if (hot) { where += ' AND is_hot = 1'; }

    const [list] = await db.query(
      `SELECT * FROM hairstyles WHERE ${where} ORDER BY sort ASC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM hairstyles WHERE ${where}`, params
    );

    res.json({ code: 0, data: { list, total, page, pageSize } });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

// 获取分类
router.post('/categories', async (req, res) => {
  try {
    const [categories] = await db.query('SELECT * FROM categories ORDER BY sort ASC');
    res.json({ code: 0, data: categories });
  } catch (err) {
    res.json({ code: -1, message: err.message });
  }
});

module.exports = router;