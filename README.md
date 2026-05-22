# Video Ad Agent on Render

这个版本已经把当前阶段需要的真实链路接上：

Shopify SKU 查询 → 使用商品图和提示词调用 Runway → 轮询 Runway 任务 → 下载生成视频 → 上传到 Google Drive → 前端展示视频和 Drive 链接。

## 必填 Render 环境变量

```txt
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_xxx
SHOPIFY_API_VERSION=2024-10
OPENROUTER_API_KEY=sk-or-xxx
RUNWAY_API_KEY=key_xxx
GOOGLE_CLIENT_EMAIL=xxx@xxx.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
GOOGLE_DRIVE_FOLDER_ID=drive_folder_id
```

注意：如果 Render 的多行私钥填入后报错，可以保留 JSON 里的 `\n`，后端会自动转换成真实换行。

## Render 配置

```txt
Build Command: npm install
Start Command: npm start
Health Check Path: /health
```

## 测试方法

1. 打开 `/health`，看到 `{ "ok": true }`。
2. 打开主页，在 Shopify 搜索框输入真实 SKU 并按 Enter。
3. 商品卡片应该变成 Shopify 返回的真实标题/图片。
4. 进入“选择素材 / 生成视频片段”，填写提示词，点“开始生成视频片段”。
5. 页面会进入“视频结果”，显示真实任务进度。
6. Runway 完成后，视频会显示在候选 A 的预览里，并自动保存到 Google Drive。

## 目前不需要的 API

Google Ads / Meta / Pinterest / Reddit / X 广告平台 API 暂时没有接入。当前阶段只跑通视频生成工作流。

## 重要限制

- Render 免费实例长任务可能休眠或超时，真实视频生成建议升级实例或后续加 Background Worker + Redis/Postgres。
- 当前任务状态存在内存里，服务重启后任务状态会丢失，但已上传到 Drive 的文件不会丢失。
