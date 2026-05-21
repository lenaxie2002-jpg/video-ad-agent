# Video Ad Agent on Render

这个仓库是一个可以直接部署到 Render 的“视频投放智能体”全栈版本：

- `public/index.html`：前端页面
- `server.js`：Node.js / Express 后端 API
- `render.yaml`：Render Blueprint 配置
- `.env.example`：环境变量模板

## 1. 本地运行

```bash
npm install
cp .env.example .env
npm run dev
```

打开：

```txt
http://localhost:3000
```

## 2. 上传 GitHub

```bash
git init
git add .
git commit -m "Initial video ad agent render app"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/video-ad-agent.git
git push -u origin main
```

## 3. Render 部署

Render 后台：

```txt
New + → Web Service → 选择 GitHub 仓库
Build Command: npm install
Start Command: npm start
Health Check Path: /health
```

如果用 Blueprint：

```txt
New + → Blueprint → 选择仓库
```

## 4. Render 环境变量

在 Render 的 Environment 里填写：

```txt
OPENROUTER_API_KEY
SHOPIFY_STORE_DOMAIN
SHOPIFY_ADMIN_TOKEN
GOOGLE_CLIENT_EMAIL
GOOGLE_PRIVATE_KEY
GOOGLE_DRIVE_FOLDER_ID
RUNWAY_API_KEY 或 LUMA_API_KEY 或 PIKA_API_KEY
```

注意：`GOOGLE_PRIVATE_KEY` 如果复制成一行，要把换行写成 `\n`。

## 5. 当前 API

```txt
GET  /health
GET  /api/config/status
POST /api/analyze-md
GET  /api/shopify/products
GET  /api/shopify/products/:id
POST /api/upload
POST /api/save-drive
POST /api/save-drive-json
POST /api/generate-video
GET  /api/jobs/:id
```

## 6. 重要说明

视频生成供应商的 API 字段经常变动。`server.js` 已经把 Runway / Luma / Pika 的调用位置拆出来：

- `createRunwayVideoTask`
- `createLumaVideoTask`
- `createPikaVideoTask`

上线前请根据你实际购买的供应商文档微调 payload 字段。
