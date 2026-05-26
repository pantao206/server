const os = require('os');

// ========== 监控数据 ==========
const monitorData = {
  requests: [],      // 最近请求记录
  errors: [],        // 错误日志
  totalRequests: 0,
  errorCount: 0,
  startTime: Date.now(),
  apiCalls: {        // 各API调用次数
    '/api/login': 0,
    '/api/usage/create': 0,
    '/api/usage/detail': 0,
    '/api/hairstyle/list': 0
  },
  taskStats: {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0
  }
};

// 最大保留请求记录数
const MAX_REQUESTS = 500;
const MAX_ERRORS = 100;
const MAX_API_CALLS = 100;

// 记录请求
function recordRequest(path, status, duration, isError = false) {
  monitorData.totalRequests++;
  if (isError || status >= 400) {
    monitorData.errorCount++;
  }

  // 记录请求
  monitorData.requests.push({
    path,
    status,
    duration,
    time: new Date().toISOString()
  });

  // 超过最大条数，移除最早的
  if (monitorData.requests.length > MAX_REQUESTS) {
    monitorData.requests.shift();
  }

  // API调用次数统计
  if (monitorData.apiCalls[path] !== undefined) {
    monitorData.apiCalls[path]++;
  }
}

// 更新任务状态统计
function updateTaskStats(stats) {
  monitorData.taskStats = stats;
}

// 记录错误
function logError(message, stack, path = '') {
  monitorData.errors.push({
    message,
    stack,
    path,
    time: new Date().toISOString()
  });
  monitorData.errorCount++;

  // 超过最大条数，移除最早的
  if (monitorData.errors.length > MAX_ERRORS) {
    monitorData.errors.shift();
  }
}

// 获取监控数据
function getMonitorData() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // 计算CPU使用率（简化）
  let cpuUsage = 0;
  cpus.forEach(cpu => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    cpuUsage += ((total - idle) / total) * 100;
  });
  cpuUsage = cpuUsage / cpus.length;

  // 最近1分钟的请求
  const oneMinuteAgo = Date.now() - 60000;
  const recentRequests = monitorData.requests.filter(r => new Date(r.time).getTime() > oneMinuteAgo);
  const qps = recentRequests.length;

  // 最近1分钟错误率
  const recentErrors = recentRequests.filter(r => r.status >= 400).length;
  const errorRate = recentRequests.length > 0 ? (recentErrors / recentRequests.length * 100).toFixed(1) : 0;

  return {
    uptime: Math.floor((Date.now() - monitorData.startTime) / 1000),
    memory: {
      total: Math.floor(totalMem / 1024 / 1024),
      used: Math.floor(usedMem / 1024 / 1024),
      free: Math.floor(freeMem / 1024 / 1024),
      usagePercent: Math.floor((usedMem / totalMem) * 100)
    },
    cpu: {
      usage: cpuUsage.toFixed(1),
      cores: cpus.length
    },
    requests: {
      total: monitorData.totalRequests,
      recent: recentRequests.slice(-20),  // 最近20条
      qps,
      errorRate
    },
    errors: monitorData.errors.slice(-20).reverse(),  // 最近20条错误，倒序
    errorCount: monitorData.errorCount,
    apiCalls: monitorData.apiCalls,
    taskStats: monitorData.taskStats
  };
}

module.exports = {
  recordRequest,
  logError,
  updateTaskStats,
  getMonitorData
};