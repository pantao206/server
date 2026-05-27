const os = require('os');

// ========== 监控数据 ==========
const monitorData = {
  requests: [],      // 最近请求记录
  errors: [],        // 错误日志
  taskLogs: [],      // 任务处理实时日志
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
  },
  // 换发任务追踪
  tryonTasks: {},    // { taskId: { id, openid, status, queueStart, processStart, aiStart, endTime, error } }
  tryonPage: 1,
  tryonPageSize: 30,
  tryonStoragePath: ''
};

// 最大保留请求记录数
const MAX_REQUESTS = 500;
const MAX_ERRORS = 100;
const MAX_API_CALLS = 100;
const MAX_TASK_LOGS = 200;
const MAX_TRYON_TASKS = 1000;

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
  } else {
    monitorData.apiCalls[path] = 1;
  }
}

// 更新任务状态统计
function updateTaskStats(stats) {
  monitorData.taskStats = stats;
}

// 记录任务处理日志
function logTaskEvent(taskId, openid, message, type = 'info') {
  const log = {
    taskId,
    openid: openid ? openid.substring(0, 10) + '...' : '',
    message,
    type, // info, success, error, warning
    time: new Date().toISOString()
  };
  monitorData.taskLogs.push(log);
  if (monitorData.taskLogs.length > MAX_TASK_LOGS) {
    monitorData.taskLogs.shift();
  }
  console.log(`[TaskLog][${type.toUpperCase()}]`, message);
}

// ========== 换发任务追踪 ==========
const fs = require('fs');
const path = require('path');

function initTryonTask(taskId, openid) {
  monitorData.tryonTasks[taskId] = {
    id: taskId,
    openid: openid,
    status: 'queued',
    queueStart: Date.now(),
    processStart: null,
    aiStart: null,
    endTime: null,
    error: null,
    queueDuration: 0,
    processDuration: 0,
    aiDuration: 0,
    totalDuration: 0
  };
}

function updateTryonTaskStatus(taskId, status) {
  const task = monitorData.tryonTasks[taskId];
  if (!task) return;

  const now = Date.now();
  task.status = status;

  if (status === 'processing') {
    task.processStart = now;
    task.queueDuration = ((now - task.queueStart) / 1000).toFixed(1) + 's';
  } else if (status === 'ai_processing') {
    task.aiStart = now;
    task.processDuration = task.processStart ? ((now - task.processStart) / 1000).toFixed(1) + 's' : '-';
  } else if (status === 'completed' || status === 'failed') {
    task.endTime = now;
    task.aiDuration = task.aiStart ? ((now - task.aiStart) / 1000).toFixed(1) + 's' : '-';
    task.totalDuration = ((now - task.queueStart) / 1000).toFixed(1) + 's';
    if (status === 'failed') {
      task.error = '失败';
    }
    // 保存到文件
    saveTryonTasksToFile();
  }
}

function setTryonTaskError(taskId, error) {
  const task = monitorData.tryonTasks[taskId];
  if (!task) return;
  task.error = error;
  task.status = 'failed';
  task.endTime = Date.now();
  task.aiDuration = task.aiStart ? ((Date.now() - task.aiStart) / 1000).toFixed(1) + 's' : '-';
  task.totalDuration = ((Date.now() - task.queueStart) / 1000).toFixed(1) + 's';
  saveTryonTasksToFile();
}

function saveTryonTasksToFile() {
  if (!monitorData.tryonStoragePath) return;

  try {
    const data = Object.values(monitorData.tryonTasks).sort((a, b) => {
      return (b.queueStart || 0) - (a.queueStart || 0);
    });
    const filePath = path.join(monitorData.tryonStoragePath, 'tryon_tasks.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log('[TryonTracker] 数据已保存到:', filePath);
  } catch (err) {
    console.error('[TryonTracker] 保存失败:', err.message);
  }
}

function getTryonTasksData(page = 1, pageSize = 30) {
  const tasks = Object.values(monitorData.tryonTasks).sort((a, b) => {
    return (b.queueStart || 0) - (a.queueStart || 0);
  });

  const total = tasks.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const list = tasks.slice(start, end);

  return {
    list,
    total,
    page,
    pageSize,
    totalPages
  };
}

function setTryonStoragePath(p) {
  monitorData.tryonStoragePath = p;
}

function getTryonStoragePath() {
  return monitorData.tryonStoragePath;
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
    taskStats: monitorData.taskStats,
    taskLogs: monitorData.taskLogs.slice(-50),  // 最近50条任务日志，保持正序
    tryonTasks: getTryonTasksData(monitorData.tryonPage, monitorData.tryonPageSize),
    tryonStoragePath: monitorData.tryonStoragePath
  };
}

module.exports = {
  recordRequest,
  logError,
  logTaskEvent,
  updateTaskStats,
  getMonitorData,
  initTryonTask,
  updateTryonTaskStatus,
  setTryonTaskError,
  getTryonTasksData,
  setTryonStoragePath,
  getTryonStoragePath
};