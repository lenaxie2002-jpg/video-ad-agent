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
      runway: Boolean(process.env.RUNWAY_API_KEY),
      pika: Boolean(process.env.PIKA_API_KEY),
      luma: Boolean(process.env.LUMA_API_KEY)
    }
  });
});

app.post('/api/analyze-md', asyncHandler(async (req, res) => {
  const { mdText, product, competitorUrl, videoUrl } = req.body;
  if (!mdText || !String(mdText).trim()) {
    return res.status(400).json({ ok: false, error: 'mdText is required' });
  }

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.7-sonnet',
      messages: [
        {
          role: 'system',
          content: '你是资深视频广告策略师。请把用户的 MD 需求、商品信息、竞品信息整理成可执行的视频生成 brief，输出中文 JSON。'
        },
        {
          role: 'user',
          content: JSON.stringify({ mdText, product, competitorUrl, videoUrl }, null, 2)
        }
      ],
      temperature: 0.4
    },
    {
      headers: {
        Authorization: `Bearer ${required('OPENROUTER_API_KEY')}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || process.env.PUBLIC_BASE_URL || 'https://render.com',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'Video Ad Agent'
      },
      timeout: 120000
    }
  );

  res.json({ ok: true, data: response.data });
}));

app.get('/api/shopify/products', asyncHandler(async (req, res) => {
  const shop = required('SHOPIFY_STORE_DOMAIN');
  const token = required('SHOPIFY_ADMIN_TOKEN');
  const version = process.env.SHOPIFY_API_VERSION || '2024-10';
  const limit = Math.min(Number(req.query.limit || 50), 250);
  const q = String(req.query.q || '').trim().toLowerCase();

  const response = await axios.get(`https://${shop}/admin/api/${version}/products.json`, {
    params: { limit },
    headers: { 'X-Shopify-Access-Token': token },
    timeout: 120000
  });

  let products = response.data.products || [];
  if (q) {
    products = products.filter((product) => {
      const title = String(product.title || '').toLowerCase();
      const handle = String(product.handle || '').toLowerCase();
      const body = String(product.body_html || '').toLowerCase();
      const skuMatch = (product.variants || []).some((variant) => String(variant.sku || '').toLowerCase().includes(q));
      return title.includes(q) || handle.includes(q) || body.includes(q) || skuMatch;
    });
  }

  res.json({ ok: true, products });
}));

app.get('/api/shopify/products/:id', asyncHandler(async (req, res) => {
  const shop = required('SHOPIFY_STORE_DOMAIN');
  const token = required('SHOPIFY_ADMIN_TOKEN');
  const version = process.env.SHOPIFY_API_VERSION || '2024-10';

  const response = await axios.get(`https://${shop}/admin/api/${version}/products/${req.params.id}.json`, {
    headers: { 'X-Shopify-Access-Token': token },
    timeout: 120000
  });

  res.json({ ok: true, product: response.data.product });
}));

app.post('/api/upload', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'file is required' });

  const localDir = path.join(__dirname, 'uploads');
  fs.mkdirSync(localDir, { recursive: true });
  const safeName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const localPath = path.join(localDir, safeName);
  fs.writeFileSync(localPath, req.file.buffer);

  res.json({
    ok: true,
    file: {
      originalName: req.file.originalname,
      filename: safeName,
      mimeType: req.file.mimetype,
      size: req.file.size
    }
  });
}));

app.post('/api/save-drive', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'file is required' });

  const folderId = req.body.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  const data = await uploadBufferToDrive({
    buffer: req.file.buffer,
    filename: req.body.filename || req.file.originalname,
    mimeType: req.file.mimetype,
    folderId
  });

  res.json({ ok: true, file: data });
}));

app.post('/api/save-drive-json', asyncHandler(async (req, res) => {
  const { filename, data, folderId } = req.body;
  if (!filename || data === undefined) {
    return res.status(400).json({ ok: false, error: 'filename and data are required' });
  }

  const buffer = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  const result = await uploadBufferToDrive({
    buffer,
    filename,
    mimeType: filename.endsWith('.json') ? 'application/json' : 'text/plain',
    folderId
  });

  res.json({ ok: true, file: result });
}));


app.post('/api/generate-image', asyncHandler(async (req, res) => {
  const { prompt, ratio = '1:1', count = 4 } = req.body || {};
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

  // This endpoint is intentionally explicit: real image generation needs a provider key
  // such as IDEOGRAM_API_KEY, FAL_API_KEY, REPLICATE_API_TOKEN, or another image model API.
  // Until such a provider is configured, it returns a usable metadata result so the UI never fails silently.
  const configured = Boolean(process.env.IDEOGRAM_API_KEY || process.env.FAL_API_KEY || process.env.REPLICATE_API_TOKEN);
  const result = {
    providerConfigured: configured,
    prompt,
    ratio,
    count,
    createdAt: new Date().toISOString(),
    assets: []
  };

  if (!configured) {
    return res.json({
      ok: true,
      message: '图片生成接口已触发，但尚未配置图片模型 API Key。请配置 IDEOGRAM_API_KEY / FAL_API_KEY / REPLICATE_API_TOKEN 后接入真实生成。',
      result
    });
  }

  res.json({ ok: true, message: '图片生成任务已收到。当前仓库保留 provider 接入位置。', result });
}));

app.post('/api/generate-video', asyncHandler(async (req, res) => {
  const { provider = 'runway', prompt, imageUrl, duration = 6, ratio = '1:1' } = req.body;
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

  const job = createJob('video-generation', { provider, prompt, imageUrl, duration, ratio });
  res.json({ ok: true, job });

  process.nextTick(async () => {
    try {
      updateJob(job.id, { status: 'running', progress: 15 });
      let result;

      if (provider === 'runway') {
        result = await createRunwayVideoTask({ prompt, imageUrl, duration, ratio });
      } else if (provider === 'luma') {
        result = await createLumaVideoTask({ prompt, imageUrl, duration, ratio });
      } else if (provider === 'pika') {
        result = await createPikaVideoTask({ prompt, imageUrl, duration, ratio });
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }

      updateJob(job.id, { status: 'submitted', progress: 60, result });
    } catch (error) {
      updateJob(job.id, { status: 'failed', progress: 100, error: error.message });
    }
  });
}));

async function createRunwayVideoTask({ prompt, imageUrl, duration, ratio }) {
  const apiKey = required('RUNWAY_API_KEY');
  const baseUrl = process.env.RUNWAY_API_BASE_URL || 'https://api.dev.runwayml.com';
  const model = process.env.RUNWAY_MODEL || 'gen4_turbo';

  const payload = {
    model,
    promptText: prompt,
    duration,
    ratio
  };
  if (imageUrl) payload.promptImage = imageUrl;

  const response = await axios.post(`${baseUrl}/v1/image_to_video`, payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': '2024-11-06'
    },
    timeout: 120000
  });
  return response.data;
}

async function createLumaVideoTask({ prompt, imageUrl, duration, ratio }) {
  const apiKey = required('LUMA_API_KEY');
  const baseUrl = process.env.LUMA_API_BASE_URL || 'https://api.lumalabs.ai/dream-machine/v1';

  const payload = {
    prompt,
    aspect_ratio: ratio,
    duration: `${duration}s`
  };
  if (imageUrl) payload.keyframes = { frame0: { type: 'image', url: imageUrl } };

  const response = await axios.post(`${baseUrl}/generations`, payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 120000
  });
  return response.data;
}

async function createPikaVideoTask({ prompt, imageUrl, duration, ratio }) {
  const apiKey = required('PIKA_API_KEY');
  const baseUrl = required('PIKA_API_BASE_URL');

  const response = await axios.post(`${baseUrl}/generate`, { prompt, imageUrl, duration, ratio }, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 120000
  });
  return response.data;
}

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true, job });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.statusCode || 500).json({ ok: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Video Ad Agent is running on port ${PORT}`);
});
