require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const RUNWAY_VERSION = process.env.RUNWAY_API_VERSION || '2024-11-06';
const RUNWAY_BASE_URL = process.env.RUNWAY_API_BASE_URL || 'https://api.dev.runwayml.com';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

const jobs = new Map();

function required(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error(`Missing environment variable: ${name}`);
    err.statusCode = 500;
    throw err;
  }
  return value;
}

function optional(name, fallback = '') {
  return process.env[name] || fallback;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createJob(type, payload = {}) {
  const id = uuidv4();
  const job = {
    id,
    type,
    status: 'queued',
    progress: 0,
    payload,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  jobs.set(id, job);
  return job;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  jobs.set(id, job);
  return job;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePrivateKey(key) {
  if (!key) return key;
  return key.replace(/\\n/g, '\n');
}

function getDriveClient() {
  const clientEmail = required('GOOGLE_CLIENT_EMAIL');
  const privateKey = normalizePrivateKey(required('GOOGLE_PRIVATE_KEY'));
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
  return google.drive({ version: 'v3', auth });
}

async function uploadBufferToDrive({ buffer, filename, mimeType, folderId }) {
  const drive = getDriveClient();
  const { Readable } = require('stream');
  const stream = Readable.from(buffer);
  const response = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId || required('GOOGLE_DRIVE_FOLDER_ID')]
    },
    media: {
      mimeType: mimeType || 'application/octet-stream',
      body: stream
    },
    fields: 'id,name,mimeType,webViewLink,webContentLink'
  });
  return response.data;
}

async function uploadUrlToDrive({ url, filename, folderId }) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 300000 });
  const contentType = response.headers['content-type'] || 'video/mp4';
  const buffer = Buffer.from(response.data);
  return uploadBufferToDrive({ buffer, filename, mimeType: contentType, folderId });
}

function runwayHeaders() {
  return {
    Authorization: `Bearer ${required('RUNWAY_API_KEY')}`,
    'Content-Type': 'application/json',
    'X-Runway-Version': RUNWAY_VERSION
  };
}

function normalizeRunwayRatio(ratio) {
  const value = String(ratio || '1:1').trim();
  const map = {
    '1:1': '960:960',
    '16:9': '1280:720',
    '9:16': '720:1280',
    '4:5': '832:1104',
    '5:4': '1104:832',
    '2:3': '768:1280',
    '3:2': '1280:768'
  };
  return map[value] || value;
}

function normalizeRunwayDuration(duration) {
  const n = Number.parseInt(duration, 10);
  if (n >= 8) return 10;
  return 5;
}

function extractVideoUrlFromTask(task) {
  if (!task) return null;
  const candidates = [
    task.videoUrl,
    task.video_url,
    task.url,
    task.output,
    task.outputs,
    task.artifacts,
    task.result && task.result.output,
    task.result && task.result.outputs,
    task.data && task.data.output,
    task.data && task.data.outputs
  ].filter(Boolean);

  for (const item of candidates) {
    if (typeof item === 'string' && /^https?:\/\//.test(item)) return item;
    if (Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry === 'string' && /^https?:\/\//.test(entry)) return entry;
        if (entry && typeof entry === 'object') {
          const url = entry.url || entry.uri || entry.downloadUrl || entry.webViewLink;
          if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
        }
      }
    }
    if (item && typeof item === 'object') {
      const url = item.url || item.uri || item.downloadUrl || item.webViewLink;
      if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
    }
  }
  return null;
}

function normalizeRunwayStatus(task) {
  const raw = String(task && (task.status || task.state || task.taskStatus || '') || '').toUpperCase();
  if (['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'COMPLETE'].includes(raw)) return 'succeeded';
  if (['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED'].includes(raw)) return 'failed';
  if (['RUNNING', 'PROCESSING', 'PENDING', 'QUEUED', 'SUBMITTED', 'THROTTLED'].includes(raw)) return 'running';
  return raw ? raw.toLowerCase() : 'running';
}

async function createRunwayTask({ prompt, imageUrl, duration = 5, ratio = '1:1' }) {
  const model = optional('RUNWAY_MODEL', imageUrl ? 'gen4_turbo' : 'gen4_turbo');
  const normalizedRatio = normalizeRunwayRatio(ratio);
  const normalizedDuration = normalizeRunwayDuration(duration);
  const promptText = String(prompt || '').slice(0, 950);

  const payload = {
    model,
    promptText,
    duration: normalizedDuration,
    ratio: normalizedRatio,
    watermark: false
  };

  let endpoint = '/v1/text_to_video';
  if (imageUrl) {
    endpoint = '/v1/image_to_video';
    payload.promptImage = imageUrl;
  }

  const response = await axios.post(`${RUNWAY_BASE_URL}${endpoint}`, payload, {
    headers: runwayHeaders(),
    timeout: 120000
  });
  return response.data;
}

async function getRunwayTask(taskId) {
  const response = await axios.get(`${RUNWAY_BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: runwayHeaders(),
    timeout: 120000
  });
  return response.data;
}

function getRunwayTaskId(data) {
  return data && (data.id || data.taskId || data.task_id || (data.data && data.data.id));
}

async function pollRunwayAndSave(jobId, runwayTaskId) {
  const maxAttempts = Number(optional('RUNWAY_POLL_ATTEMPTS', 90));
  const intervalMs = Number(optional('RUNWAY_POLL_INTERVAL_MS', 10000));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const task = await getRunwayTask(runwayTaskId);
    const status = normalizeRunwayStatus(task);
    const progress = Math.min(95, 25 + Math.round((attempt / maxAttempts) * 65));
    updateJob(jobId, { status: status === 'running' ? 'running' : status, progress, result: { runwayTaskId, runwayTask: task } });

    if (status === 'failed') {
      const message = task.error || task.failure || task.message || 'Runway task failed';
      throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
    }

    if (status === 'succeeded') {
      const videoUrl = extractVideoUrlFromTask(task);
      if (!videoUrl) throw new Error('Runway task succeeded, but no video URL was found in the response.');
      updateJob(jobId, { status: 'saving_to_drive', progress: 97, result: { runwayTaskId, runwayTask: task, videoUrl } });
      const filename = `video-ad-agent-${jobId}.mp4`;
      const driveFile = await uploadUrlToDrive({ url: videoUrl, filename });
      updateJob(jobId, { status: 'completed', progress: 100, result: { runwayTaskId, runwayTask: task, videoUrl, driveFile } });
      return;
    }

    await sleep(intervalMs);
  }
  throw new Error('Runway task polling timed out. The task may still be running in Runway.');
}

async function shopifyGraphql(query, variables = {}) {
  const shop = required('SHOPIFY_STORE_DOMAIN');
  const token = required('SHOPIFY_ADMIN_TOKEN');
  const version = optional('SHOPIFY_API_VERSION', '2024-10');
  const response = await axios.post(
    `https://${shop}/admin/api/${version}/graphql.json`,
    { query, variables },
    { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 120000 }
  );
  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors));
  }
  return response.data.data;
}

function normalizeShopifyProductFromVariantEdge(edge) {
  const variant = edge.node;
  const product = variant.product || {};
  const image = variant.image || product.featuredImage || null;
  return {
    productId: product.id,
    variantId: variant.id,
    title: product.title,
    handle: product.handle,
    description: product.description,
    sku: variant.sku,
    variantTitle: variant.title,
    price: variant.price,
    imageUrl: image && image.url,
    imageAlt: image && image.altText,
    shop: process.env.SHOPIFY_STORE_DOMAIN
  };
}

async function searchShopifyBySkuOrText(q) {
  const queryString = q ? `sku:${q} OR title:*${q}* OR ${q}` : '';
  const gql = `
    query SearchVariants($query: String!) {
      productVariants(first: 20, query: $query) {
        edges {
          node {
            id
            title
            sku
            price
            image { url altText }
            product {
              id
              title
              handle
              description
              featuredImage { url altText }
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphql(gql, { query: queryString });
  return (data.productVariants.edges || []).map(normalizeShopifyProductFromVariantEdge);
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'video-ad-agent', time: new Date().toISOString() });
});

app.get('/api/config/status', (req, res) => {
  res.json({
    ok: true,
    services: {
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      shopify: Boolean(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN),
      googleDrive: Boolean(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_DRIVE_FOLDER_ID),
      runway: Boolean(process.env.RUNWAY_API_KEY)
    }
  });
});

app.post('/api/analyze-md', asyncHandler(async (req, res) => {
  const { mdText, product, competitorUrl, videoUrl } = req.body;
  if (!mdText || !String(mdText).trim()) return res.status(400).json({ ok: false, error: 'mdText is required' });
  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: optional('OPENROUTER_MODEL', 'anthropic/claude-3.7-sonnet'),
      messages: [
        { role: 'system', content: '你是资深视频广告策略师。请把用户的 MD 需求、商品信息、竞品信息整理成可执行的视频生成 brief，输出中文 JSON。' },
        { role: 'user', content: JSON.stringify({ mdText, product, competitorUrl, videoUrl }, null, 2) }
      ],
      temperature: 0.4
    },
    {
      headers: {
        Authorization: `Bearer ${required('OPENROUTER_API_KEY')}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': optional('OPENROUTER_SITE_URL', optional('PUBLIC_BASE_URL', 'https://render.com')),
        'X-Title': optional('OPENROUTER_APP_NAME', 'Video Ad Agent')
      },
      timeout: 120000
    }
  );
  res.json({ ok: true, data: response.data });
}));

app.get('/api/shopify/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || req.query.sku || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'q or sku is required' });
  const products = await searchShopifyBySkuOrText(q);
  res.json({ ok: true, products });
}));

app.get('/api/shopify/products', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q) {
    const products = await searchShopifyBySkuOrText(q);
    return res.json({ ok: true, products });
  }
  const shop = required('SHOPIFY_STORE_DOMAIN');
  const token = required('SHOPIFY_ADMIN_TOKEN');
  const version = optional('SHOPIFY_API_VERSION', '2024-10');
  const limit = Math.min(Number(req.query.limit || 50), 250);
  const response = await axios.get(`https://${shop}/admin/api/${version}/products.json`, {
    params: { limit },
    headers: { 'X-Shopify-Access-Token': token },
    timeout: 120000
  });
  res.json({ ok: true, products: response.data.products || [] });
}));

app.post('/api/upload', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'file is required' });
  const localDir = path.join(__dirname, 'uploads');
  fs.mkdirSync(localDir, { recursive: true });
  const safeName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const localPath = path.join(localDir, safeName);
  fs.writeFileSync(localPath, req.file.buffer);
  res.json({ ok: true, file: { originalName: req.file.originalname, filename: safeName, mimeType: req.file.mimetype, size: req.file.size } });
}));

app.post('/api/save-drive', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'file is required' });
  const data = await uploadBufferToDrive({ buffer: req.file.buffer, filename: req.body.filename || req.file.originalname, mimeType: req.file.mimetype, folderId: req.body.folderId });
  res.json({ ok: true, file: data });
}));

app.post('/api/save-drive-json', asyncHandler(async (req, res) => {
  const { filename, data, folderId } = req.body;
  if (!filename || data === undefined) return res.status(400).json({ ok: false, error: 'filename and data are required' });
  const buffer = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  const result = await uploadBufferToDrive({ buffer, filename, mimeType: filename.endsWith('.json') ? 'application/json' : 'text/plain', folderId });
  res.json({ ok: true, file: result });
}));

app.post('/api/agent/create-video', asyncHandler(async (req, res) => {
  const { sku, prompt, imageUrl, duration = 5, ratio = '1:1', product } = req.body;
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

  let resolvedProduct = product || null;
  if (!resolvedProduct && sku) {
    const found = await searchShopifyBySkuOrText(sku);
    resolvedProduct = found[0] || null;
  }
  const resolvedImageUrl = imageUrl || (resolvedProduct && resolvedProduct.imageUrl) || null;

  const job = createJob('real-video-generation', { sku, prompt, imageUrl: resolvedImageUrl, duration, ratio, product: resolvedProduct });
  res.json({ ok: true, job });

  process.nextTick(async () => {
    try {
      updateJob(job.id, { status: 'submitting_to_runway', progress: 10 });
      const runwayCreate = await createRunwayTask({ prompt, imageUrl: resolvedImageUrl, duration, ratio });
      const runwayTaskId = getRunwayTaskId(runwayCreate);
      if (!runwayTaskId) throw new Error(`Runway did not return a task id: ${JSON.stringify(runwayCreate)}`);
      updateJob(job.id, { status: 'running', progress: 20, result: { runwayTaskId, runwayCreate, product: resolvedProduct } });
      await pollRunwayAndSave(job.id, runwayTaskId);
    } catch (error) {
      updateJob(job.id, { status: 'failed', progress: 100, error: error.response && error.response.data ? JSON.stringify(error.response.data) : error.message });
    }
  });
}));

app.post('/api/generate-video', asyncHandler(async (req, res) => {
  // Backwards-compatible route used by older front-end code.
  req.url = '/api/agent/create-video';
  app._router.handle(req, res, () => {});
}));

app.get('/api/jobs/:id', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true, job });
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err.response && err.response.data ? err.response.data : err);
  res.status(err.statusCode || 500).json({ ok: false, error: err.response && err.response.data ? JSON.stringify(err.response.data) : (err.message || 'Internal server error') });
});

app.listen(PORT, () => {
  console.log(`Video Ad Agent is running on port ${PORT}`);
});
