# 维创发型 Hair2 项目开发文档

## 一、项目概述

- **项目名称**：维创发型
- **小程序AppID**：wx182b0a111df1bca3
- **项目类型**：微信小程序 + 自建服务器

## 二、技术架构

| 组件 | 技术 |
|------|------|
| 小程序端 | 微信小程序 |
| 后端服务 | Node.js Express |
| 数据库 | MySQL |
| AI换发 | 第三方API |

## 三、部署说明

详见 [DEPLOY.md](./DEPLOY.md)

## 四、目录结构

```
hair2/
├── server/                    # 后端服务
│   ├── public/
│   │   └── admin/           # 后台管理页面
│   ├── src/
│   │   ├── routes/          # API接口
│   │   └── utils/           # 工具函数
│   └── package.json
├── pages/                     # 小程序页面
└── utils/                     # 工具函数
```

## 五、访问地址

| 服务 | 地址 |
|------|------|
| 后台管理 | `http://your-server.com/admin` |
| API | `http://your-server.com/api` |

## 六、快速开始

### 1. 配置服务器

```bash
cd server
cp .env.example .env
# 编辑 .env 填写配置
npm install
npm start
```

### 2. 小程序端

修改 `utils/api.js` 中的 API 地址为服务器地址