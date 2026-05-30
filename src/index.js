require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// 导入路由
const loginRouter = require('./routes/login');
const agentRouter = require('./routes/agent');
const hairstyleRouter = require('./routes/hairstyle');
const usageRouter = require('./routes/usage');
const orderRouter = require('./routes/order');
const adminRouter = require('./routes/admin');
const configRouter = require('./routes/config');
const uploadRouter = require('./routes/upload');
const qrcodeRouter = require('./routes/qrcode');
const { recordRequest, logError } = require('./utils/monitor');

const app = express();
const PORT = process.env.PORT || 3650;

// 静态文件托管
const adminPath = path.join(__dirname, '../public/admin');
app.use('/admin', express.static(adminPath));
app.use('/assets', express.static(path.join(adminPath, 'assets')));

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 请求日志和监控
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    recordRequest(req.path, res.statusCode, duration, res.statusCode >= 400);
  });
  next();
});

// 路由
app.use('/api/login', loginRouter);
app.use('/api/agent', agentRouter);
app.use('/api/hairstyle', hairstyleRouter);
app.use('/api/usage', usageRouter);
app.use('/api/order', orderRouter);
app.use('/api/admin', adminRouter);
app.use('/api/config', configRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/qrcode', qrcodeRouter);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 404处理
app.use((req, res) => {
  res.status(404).json({ code: -1, message: '接口不存在' });
});

// 错误处理
app.use((err, req, res, next) => {
  logError(err.message, err.stack, req.path);
  console.error('[Error]', req.path, err.message);
  res.status(500).json({ code: -1, message: '服务器错误: ' + err.message });
});

app.listen(PORT, () => {
  console.log(`hair2-server running on port ${PORT}`);
});