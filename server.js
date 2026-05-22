require('dotenv').config();

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

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
    fields: 'id,name,mimeType,webViewLink,webContentLink',
    supportsAllDrives: true
  });
  return response.data;
}

async function uploadUrlToDrive({ url, filename, folderId }) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 300000 });
  const contentType = response.headers['content-type'] || 'video/mp4';
  const buffer = Buffer.from(response.data);
  return uploadBufferToDrive({ buffer, filename, mimeType: contentType, folderId });
}

function openRouterHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${required('OPENROUTER_API_KEY')}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': optional('OPENROUTER_SITE_URL', optional('PUBLIC_BASE_URL', 'https://render.com')),
    'X-Title': optional('OPENROUTER_APP_NAME', 'Video Ad Agent'),
    ...extra
  };
}

async function openRouterPost(pathname, body) {
  const response = await axios.post(`${OPENROUTER_BASE_URL}${pathname}`, body, {
    headers: openRouterHeaders(),
    timeout: 120000
  });
  return response.data;
}

async function openRouterGet(pathOrUrl, responseType = 'json') {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${OPENROUTER_BASE_URL}${pathOrUrl}`;
  const response = await axios.get(url, {
    headers: openRouterHeaders(responseType === 'arraybuffer' ? {} : {}),
    responseType,
    timeout: 300000
  });
  return response;
}

function normalizeOpenRouterDuration(duration) {
  const raw = duration === undefined || duration === null || duration === ''
    ? optional('OPENROUTER_VIDEO_DURATION', 30)
    : duration;
  const n = Number.parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(n)) return 30;
  return Math.max(4, Math.min(n, 120));
}

function getSegmentDuration(finalDuration) {
  const configured = Number(optional('OPENROUTER_VIDEO_SEGMENT_DURATION', 8));
  const value = Number.isFinite(configured) && configured > 0 ? configured : 8;
  return Math.min(finalDuration, Math.max(4, Math.min(value, 12)));
}

function getMaxDirectDuration() {
  const configured = Number(optional('OPENROUTER_VIDEO_MAX_DIRECT_DURATION', 8));
  return Number.isFinite(configured) && configured > 0 ? configured : 8;
}

function normalizeOpenRouterResolution(resolution) {
  return process.env.OPENROUTER_VIDEO_RESOLUTION || resolution || '720p';
}

function normalizeOpenRouterAspectRatio(ratio) {
  if (process.env.OPENROUTER_VIDEO_ASPECT_RATIO) return process.env.OPENROUTER_VIDEO_ASPECT_RATIO;
  const value = String(ratio || '16:9').trim();
  const allowed = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3']);
  return allowed.has(value) ? value : '16:9';
}

async function createOpenRouterVideoJob({ prompt, duration = 4, ratio = '16:9', resolution = '720p', model: requestedModel }) {
  const model = requestedModel || optional('OPENROUTER_VIDEO_MODEL', 'google/veo-3.1-lite');
  const payload = {
    model,
    prompt: String(prompt || '').slice(0, 1800),
    duration: normalizeOpenRouterDuration(duration),
    resolution: normalizeOpenRouterResolution(resolution),
    aspect_ratio: normalizeOpenRouterAspectRatio(ratio),
    generate_audio: String(optional('OPENROUTER_VIDEO_GENERATE_AUDIO', 'false')).toLowerCase() === 'true'
  };
  return openRouterPost('/videos', payload);
}

function normalizeOpenRouterVideoStatus(statusPayload) {
  const raw = String(statusPayload && statusPayload.status || '').toLowerCase();
  if (['completed', 'succeeded', 'success', 'complete'].includes(raw)) return 'completed';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired'].includes(raw)) return 'failed';
  return 'running';
}

function getOpenRouterJobId(job) {
  return job && (job.id || job.job_id || job.jobId);
}

async function downloadOpenRouterVideoBuffer(status) {
  const apiKey = required('OPENROUTER_API_KEY');
  const unsignedUrl = status && Array.isArray(status.unsigned_urls) && status.unsigned_urls[0];
  const jobId = getOpenRouterJobId(status);
  const url = unsignedUrl || `${OPENROUTER_BASE_URL}/videos/${encodeURIComponent(jobId)}/content?index=0`;
  const headers = url.startsWith(OPENROUTER_BASE_URL) || url.includes('openrouter.ai/api/')
    ? { Authorization: `Bearer ${apiKey}` }
    : {};
  const response = await axios.get(url, { headers, responseType: 'arraybuffer', timeout: 300000 });
  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers['content-type'] || 'video/mp4'
  };
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function pollOpenRouterVideoToBuffer(localJobId, submittedJob, progressBase = 15, progressSpan = 75, label = 'video') {
  const maxAttempts = Number(optional('OPENROUTER_VIDEO_POLL_ATTEMPTS', 80));
  const intervalMs = Number(optional('OPENROUTER_VIDEO_POLL_INTERVAL_MS', 15000));
  let status = submittedJob;
  const openRouterJobId = getOpenRouterJobId(submittedJob);
  if (!openRouterJobId) throw new Error(`OpenRouter did not return a video job id: ${JSON.stringify(submittedJob)}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const normalizedStatus = normalizeOpenRouterVideoStatus(status);
    const progress = Math.min(95, progressBase + Math.round((attempt / maxAttempts) * progressSpan));
    updateJob(localJobId, {
      status: normalizedStatus === 'running' ? `running_${label}` : normalizedStatus,
      progress,
      result: { openRouterJobId, openRouterVideoJob: status, label }
    });

    if (normalizedStatus === 'failed') {
      const message = status.error || status.message || 'OpenRouter video generation failed';
      throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
    }

    if (normalizedStatus === 'completed') {
      updateJob(localJobId, { status: `downloading_${label}`, progress: Math.min(96, progress + 1), result: { openRouterJobId, openRouterVideoJob: status, label } });
      const downloaded = await downloadOpenRouterVideoBuffer(status);
      return { ...downloaded, openRouterJobId, openRouterVideoJob: status };
    }

    await sleep(intervalMs);
    const pollingUrl = status.polling_url || `/videos/${encodeURIComponent(openRouterJobId)}`;
    const response = await openRouterGet(pollingUrl, 'json');
    status = response.data;
  }
  throw new Error('OpenRouter video generation polling timed out. The task may still be running.');
}

async function concatVideoBuffers({ localJobId, buffers, contentType = 'video/mp4' }) {
  const generatedDir = path.join(__dirname, 'generated');
  const workDir = path.join(generatedDir, `${localJobId}-segments`);
  fs.mkdirSync(workDir, { recursive: true });

  const segmentPaths = buffers.map((buffer, index) => {
    const p = path.join(workDir, `segment-${String(index + 1).padStart(2, '0')}.mp4`);
    fs.writeFileSync(p, buffer);
    return p;
  });

  if (segmentPaths.length === 1) {
    const localVideoPath = path.join(generatedDir, `${localJobId}.mp4`);
    fs.copyFileSync(segmentPaths[0], localVideoPath);
    return { buffer: fs.readFileSync(localVideoPath), contentType, localVideoPath };
  }

  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available; cannot merge video segments into one 30-second ad.');
  }

  const listPath = path.join(workDir, 'segments.txt');
  fs.writeFileSync(listPath, segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const localVideoPath = path.join(generatedDir, `${localJobId}.mp4`);

  try {
    await execFilePromise(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', localVideoPath], { timeout: 600000 });
  } catch (copyError) {
    await execFilePromise(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', localVideoPath], { timeout: 900000 });
  }

  return { buffer: fs.readFileSync(localVideoPath), contentType: 'video/mp4', localVideoPath };
}

function buildSegmentPrompt({ prompt, product, totalDuration, segmentIndex, segmentCount, segmentDuration }) {
  const productLine = product ? `商品：${product.title || ''}，SKU：${product.sku || ''}。` : '';
  return [
    `你正在生成一个 ${totalDuration} 秒电商广告视频的第 ${segmentIndex + 1}/${segmentCount} 段，本段时长 ${segmentDuration} 秒。`,
    productLine,
    '要求：整体真实、高级、适合广告投放；镜头风格与前后片段一致；不要出现字幕乱码、水印、logo 乱入。',
    segmentIndex === 0 ? '本段是开场：3 秒内抓住注意力，展示商品和使用场景。' : '',
    segmentIndex === segmentCount - 1 ? '本段是结尾：突出购买动机和自然 CTA，但不要硬塞文字。' : '',
    `完整广告 brief：${prompt}`
  ].filter(Boolean).join('\n');
}

async function generateOpenRouterVideoAndSave({ localJobId, prompt, duration, ratio, resolution, model, product }) {
  const finalDuration = normalizeOpenRouterDuration(duration);
  const maxDirectDuration = getMaxDirectDuration();
  const segmentDuration = getSegmentDuration(finalDuration);
  const shouldSegment = finalDuration > maxDirectDuration && String(optional('OPENROUTER_VIDEO_SEGMENT_LONG_ADS', 'true')).toLowerCase() !== 'false';
  const contentType = 'video/mp4';
  const segmentResults = [];

  if (!shouldSegment) {
    updateJob(localJobId, { status: 'submitting_to_openrouter', progress: 8 });
    const openRouterCreate = await createOpenRouterVideoJob({ prompt, duration: finalDuration, ratio, resolution, model });
    const single = await pollOpenRouterVideoToBuffer(localJobId, openRouterCreate, 15, 78, 'video');
    segmentResults.push(single);
  } else {
    const segmentCount = Math.ceil(finalDuration / segmentDuration);
    for (let index = 0; index < segmentCount; index += 1) {
      const remaining = finalDuration - index * segmentDuration;
      const thisDuration = Math.min(segmentDuration, remaining);
      const base = 8 + Math.round((index / segmentCount) * 82);
      const span = Math.max(5, Math.round(82 / segmentCount));
      updateJob(localJobId, {
        status: `submitting_segment_${index + 1}_of_${segmentCount}`,
        progress: base,
        result: { segmentIndex: index + 1, segmentCount, finalDuration, segmentDuration }
      });
      const segmentPrompt = buildSegmentPrompt({ prompt, product, totalDuration: finalDuration, segmentIndex: index, segmentCount, segmentDuration: thisDuration });
      const openRouterCreate = await createOpenRouterVideoJob({ prompt: segmentPrompt, duration: thisDuration, ratio, resolution, model });
      const segment = await pollOpenRouterVideoToBuffer(localJobId, openRouterCreate, base, span, `segment_${index + 1}_of_${segmentCount}`);
      segmentResults.push(segment);
    }
  }

  updateJob(localJobId, { status: segmentResults.length > 1 ? 'merging_segments' : 'preparing_video', progress: 96, result: { segments: segmentResults.map((s) => ({ openRouterJobId: s.openRouterJobId })) } });
  const merged = await concatVideoBuffers({ localJobId, buffers: segmentResults.map((s) => s.buffer), contentType });

  const baseResult = {
    finalDuration,
    segmentCount: segmentResults.length,
    segmentJobs: segmentResults.map((s) => s.openRouterJobId),
    videoUrl: `/api/jobs/${localJobId}/video`,
    localVideoPath: merged.localVideoPath,
    segments: segmentResults.map((s) => ({ openRouterJobId: s.openRouterJobId }))
  };

  // Important: the video is already generated and saved locally before Drive upload.
  // Do not mark the whole video job as failed just because Drive has no quota or permission.
  updateJob(localJobId, { status: 'video_ready_saving_to_drive', progress: 98, result: baseResult });

  const filename = `video-ad-agent-${localJobId}-${finalDuration}s.mp4`;
  try {
    const driveFile = await uploadBufferToDrive({ buffer: merged.buffer, filename, mimeType: merged.contentType || 'video/mp4' });
    updateJob(localJobId, {
      status: 'completed',
      progress: 100,
      result: { ...baseResult, driveFile }
    });
  } catch (driveError) {
    updateJob(localJobId, {
      status: 'completed',
      progress: 100,
      result: {
        ...baseResult,
        driveError: driveError.response && driveError.response.data ? JSON.stringify(driveError.response.data) : driveError.message
      }
    });
  }
}

async function pollOpenRouterVideoAndSave(localJobId, submittedJob) {
  const single = await pollOpenRouterVideoToBuffer(localJobId, submittedJob, 15, 78, 'video');
  const generatedDir = path.join(__dirname, 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  const localVideoPath = path.join(generatedDir, `${localJobId}.mp4`);
  fs.writeFileSync(localVideoPath, single.buffer);
  const baseResult = { openRouterJobId: single.openRouterJobId, videoUrl: `/api/jobs/${localJobId}/video`, localVideoPath };
  updateJob(localJobId, { status: 'video_ready_saving_to_drive', progress: 98, result: baseResult });
  const filename = `video-ad-agent-${localJobId}.mp4`;
  try {
    const driveFile = await uploadBufferToDrive({ buffer: single.buffer, filename, mimeType: single.contentType || 'video/mp4' });
    updateJob(localJobId, { status: 'completed', progress: 100, result: { ...baseResult, driveFile } });
  } catch (driveError) {
    updateJob(localJobId, {
      status: 'completed',
      progress: 100,
      result: {
        ...baseResult,
        driveError: driveError.response && driveError.response.data ? JSON.stringify(driveError.response.data) : driveError.message
      }
    });
  }
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
      openrouterVideo: Boolean(process.env.OPENROUTER_API_KEY),
      shopify: Boolean(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN),
      googleDrive: Boolean(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_DRIVE_FOLDER_ID),
      runway: false,
      imageGeneration: Boolean(process.env.OPENROUTER_IMAGE_MODEL)
    }
  });
});

app.get('/api/openrouter/video-models', asyncHandler(async (req, res) => {
  const response = await openRouterGet('/videos/models', 'json');
  res.json({ ok: true, data: response.data.data || response.data });
}));

app.get('/api/openrouter/model-config', (req, res) => {
  res.json({
    ok: true,
    textModels: [
      { id: optional('OPENROUTER_TEXT_MODEL', optional('OPENROUTER_MODEL', 'anthropic/claude-3.7-sonnet')), label: 'OpenRouter · Claude 3.7 Sonnet' },
      { id: optional('OPENROUTER_FALLBACK_TEXT_MODEL', 'openai/gpt-4.1'), label: 'OpenRouter · GPT-4.1' },
      { id: optional('OPENROUTER_FAST_TEXT_MODEL', 'google/gemini-2.5-flash'), label: 'OpenRouter · Gemini 2.5 Flash' }
    ],
    videoModels: [
      { id: optional('OPENROUTER_VIDEO_MODEL', 'google/veo-3.1-lite'), label: 'OpenRouter · Veo 3.1 Lite' },
      { id: optional('OPENROUTER_VIDEO_MODEL_ALT', 'google/veo-3.1-fast'), label: 'OpenRouter · Veo 3.1 Fast' }
    ],
    imageModels: [
      { id: optional('OPENROUTER_IMAGE_MODEL', 'google/gemini-3.1-flash-image-preview'), label: 'OpenRouter · Gemini Image' }
    ],
    safeVideoDefaults: {
      duration: Number(optional('OPENROUTER_VIDEO_DURATION', 30)),
      resolution: optional('OPENROUTER_VIDEO_RESOLUTION', '1080p'),
      aspectRatio: optional('OPENROUTER_VIDEO_ASPECT_RATIO', '16:9')
    },
    supportedVideoDurations: [15, 30, 45, 60],
    supportedVideoResolutions: ['720p', '1080p', '2K', '4K'],
    supportedVideoAspectRatios: ['16:9', '9:16', '1:1', '4:5']
  });
});

app.post('/api/analyze-md', asyncHandler(async (req, res) => {
  const { mdText, product, competitorUrl, videoUrl } = req.body;
  if (!mdText || !String(mdText).trim()) return res.status(400).json({ ok: false, error: 'mdText is required' });
  const response = await axios.post(
    `${OPENROUTER_BASE_URL}/chat/completions`,
    {
      model: optional('OPENROUTER_TEXT_MODEL', optional('OPENROUTER_MODEL', 'anthropic/claude-3.7-sonnet')),
      messages: [
        { role: 'system', content: '你是资深视频广告策略师。请把用户的 MD 需求、商品信息、竞品信息整理成可执行的视频生成 brief，输出中文 JSON。' },
        { role: 'user', content: JSON.stringify({ mdText, product, competitorUrl, videoUrl }, null, 2) }
      ],
      temperature: 0.4
    },
    { headers: openRouterHeaders(), timeout: 120000 }
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
  const { sku, prompt, duration = 30, ratio = '16:9', resolution = '1080p', product, videoModel } = req.body;
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

  let resolvedProduct = product || null;
  if (!resolvedProduct && sku) {
    const found = await searchShopifyBySkuOrText(sku);
    resolvedProduct = found[0] || null;
  }

  const productContext = resolvedProduct
    ? `\n\n商品信息：${resolvedProduct.title || ''} SKU:${resolvedProduct.sku || ''} 价格:${resolvedProduct.price || ''} 描述:${resolvedProduct.description || ''}`
    : '';
  const finalPrompt = `${prompt}${productContext}`.slice(0, 1800);

  const normalizedDuration = normalizeOpenRouterDuration(duration);
  const job = createJob('openrouter-video-generation', { sku, prompt: finalPrompt, duration: normalizedDuration, ratio, resolution, product: resolvedProduct });
  res.json({ ok: true, job });

  process.nextTick(async () => {
    try {
      updateJob(job.id, { status: 'starting_30s_ad_pipeline', progress: 5, result: { product: resolvedProduct, videoModel: videoModel || optional('OPENROUTER_VIDEO_MODEL', 'google/veo-3.1-lite') } });
      await generateOpenRouterVideoAndSave({ localJobId: job.id, prompt: finalPrompt, duration: normalizedDuration, ratio, resolution, model: videoModel, product: resolvedProduct });
    } catch (error) {
      updateJob(job.id, { status: 'failed', progress: 100, error: error.response && error.response.data ? JSON.stringify(error.response.data) : error.message });
    }
  });
}));

app.post('/api/generate-video', asyncHandler(async (req, res) => {
  req.url = '/api/agent/create-video';
  app._router.handle(req, res, () => {});
}));

app.get('/api/jobs/:id', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true, job });
}));

app.get('/api/jobs/:id/video', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.result || !job.result.localVideoPath) return res.status(404).send('Video not found');
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(job.result.localVideoPath).pipe(res);
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
