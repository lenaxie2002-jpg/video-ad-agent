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
app.use('/generated', express.static(path.join(__dirname, 'generated')));

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

function parseDurationList(value) {
  return String(value || '')
    .split(',')
    .map((item) => Number.parseInt(item.trim().replace(/[^0-9]/g, ''), 10))
    .filter((item) => Number.isFinite(item) && item > 0)
    .sort((a, b) => b - a);
}

function supportedDurationsForVideoModel(model) {
  const configured = parseDurationList(process.env.OPENROUTER_VIDEO_SUPPORTED_DURATIONS);
  if (configured.length) return configured;
  const id = String(model || optional('OPENROUTER_VIDEO_MODEL', '')).toLowerCase();
  // Seedance is the preferred ad-video model for this app because it can generate 15s clips.
  // This lets 15s run as a single clip, 30s as 15+15, 45s as 15*3, and 60s as 15*4.
  if (id.includes('seedance')) return [15, 10, 5];
  // Conservative fallback for models such as Veo variants that commonly support 4/6/8s clips.
  return [8, 6, 4];
}

function planVideoSegments(finalDuration, model) {
  const target = normalizeOpenRouterDuration(finalDuration);
  const allowed = supportedDurationsForVideoModel(model);
  const maxAllowed = Math.max(...allowed);

  function exactPlan(total) {
    const dp = Array(total + 1).fill(null);
    dp[0] = [];
    for (let t = 1; t <= total; t += 1) {
      for (const d of allowed) {
        if (t >= d && dp[t - d]) {
          dp[t] = [...dp[t - d], d];
          break;
        }
      }
    }
    return dp[total];
  }

  const exact = exactPlan(target);
  if (exact) return { durations: exact, generatedDuration: target, targetDuration: target, trimToTarget: false, allowedDurations: allowed };

  // If exact target cannot be represented (for example 15s with 4/6/8s-only models),
  // generate the nearest longer duration and trim it with ffmpeg after merging.
  for (let total = target + 1; total <= target + maxAllowed; total += 1) {
    const plan = exactPlan(total);
    if (plan) return { durations: plan, generatedDuration: total, targetDuration: target, trimToTarget: true, allowedDurations: allowed };
  }

  throw new Error(`Cannot plan video segments for ${target}s with supported durations: ${allowed.join(', ')}s`);
}

function getMaxDirectDuration(model) {
  const configured = Number(optional('OPENROUTER_VIDEO_MAX_DIRECT_DURATION', ''));
  if (Number.isFinite(configured) && configured > 0) return configured;
  return Math.max(...supportedDurationsForVideoModel(model));
}

function normalizeOpenRouterResolution(resolution) {
  // Front-end choices should override env defaults. Env is only a fallback.
  const value = String(resolution || process.env.OPENROUTER_VIDEO_RESOLUTION || '720p').toLowerCase();
  const allowed = new Set(['720p', '1080p', '2k', '4k']);
  return allowed.has(value) ? (value === '2k' ? '2K' : value === '4k' ? '4K' : value) : '720p';
}

function normalizeOpenRouterAspectRatio(ratio) {
  // Front-end choices should override env defaults. Env is only a fallback.
  const value = String(ratio || process.env.OPENROUTER_VIDEO_ASPECT_RATIO || '16:9').trim();
  const allowed = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3']);
  return allowed.has(value) ? value : '16:9';
}

function uniqueHttpsUrls(urls) {
  const seen = new Set();
  return (urls || [])
    .map((url) => String(url || '').trim())
    .filter((url) => /^https:\/\//i.test(url))
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}


function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function compactList(items) {
  return Array.from(new Set((items || []).map((x) => String(x || '').trim()).filter(Boolean)));
}


const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

function readKnowledgeFile(filename) {
  try {
    return fs.readFileSync(path.join(KNOWLEDGE_DIR, filename), 'utf8');
  } catch (_) {
    return '';
  }
}

const KNOWLEDGE_BASE = {
  furnitureVideoRules: readKnowledgeFile('furniture-video-rules.md'),
  lightingSceneRules: readKnowledgeFile('lighting-scene-rules.md'),
  lightingAdSystem: readKnowledgeFile('lighting-ad-system.md')
};

function clipText(value, max = 1800) {
  const text = String(value || '').replace(/\r/g, '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...`;
}

function detectProductCategory(product = {}) {
  const raw = [
    product.title,
    product.productType,
    product.vendor,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags,
    product.description,
    product.descriptionHtml,
    product.variantTitle
  ].filter(Boolean).join(' ').toLowerCase();

  if (/(pendant|chandelier|sconce|flush|ceiling|vanity|lamp|light|lighting|吊灯|灯具|壁灯|吸顶|镜前灯|pendant light|mini pendant)/i.test(raw)) return 'lighting';
  if (/(table|chair|sofa|stool|bench|cabinet|dresser|nightstand|bed|desk|console|sideboard|家具|桌|椅|沙发|柜|床|边几|边桌)/i.test(raw)) return 'furniture';
  return 'home';
}

function extractMostRelevantKnowledge(product = {}, targetPlatform = '', creativeType = '') {
  const category = detectProductCategory(product);
  const blocks = [];

  if (category === 'lighting') {
    blocks.push(`【灯具场景/安装/比例规则】\n${clipText(KNOWLEDGE_BASE.lightingSceneRules, 4200)}`);
    blocks.push(`【灯具广告创意规则/竞品视频MD】\n${clipText(KNOWLEDGE_BASE.lightingAdSystem, 4200)}`);
  } else if (category === 'furniture') {
    blocks.push(`【家具视频稳定与空镜头规则】\n${clipText(KNOWLEDGE_BASE.furnitureVideoRules, 4200)}`);
  } else {
    blocks.push(`【家居视频稳定规则】\n${clipText(KNOWLEDGE_BASE.furnitureVideoRules, 2400)}`);
    blocks.push(`【家居/灯具广告创意规则】\n${clipText(KNOWLEDGE_BASE.lightingAdSystem, 3000)}`);
  }

  const raw = [
    product.title,
    product.productType,
    product.description,
    product.descriptionHtml,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags
  ].filter(Boolean).join(' ').toLowerCase();

  const categoryRules = [];
  if (/mini|pendant|吊灯|小吊灯/i.test(raw)) {
    categoryRules.push('如果是 mini pendant / pendant light：必须表现为小型吊灯，不能放大成大型吊灯；必须与岛台、餐桌、床头、浴室、门厅等真实安装场景的尺度匹配。');
  }
  if (/vanity|bath|sconce|wall|mirror|镜前|壁灯|浴室/i.test(raw)) {
    categoryRules.push('如果是浴室镜前灯/壁灯：必须安装在镜子上方或左右两侧，与镜子、台盆、黄铜/黑色五金对齐；不要漂浮、不要挡镜面、不要改灯头数量。');
  }
  if (/side table|table|边几|边桌/i.test(raw)) {
    categoryRules.push('如果是边几/桌：必须保持桌面、桌脚、尺寸和人体尺度，不要变成餐桌、背景纹理或木板。');
  }
  if (categoryRules.length) blocks.push(`【本产品品类专项规则】\n${categoryRules.join('\n')}`);

  blocks.push(`【广告视频总原则】\n不要让观众感觉在看硬广；让观众觉得发现了一个想住进去的空间。空间情绪 > 品牌审美 > 材质细节 > 产品功能 > CTA。`);

  return blocks.join('\n\n');
}

function buildAIDirectorPrompt({ product, selectedMaterials = [], userPrompt = '', duration, ratio, resolution, variant = 'A', strategy = '' }) {
  const productFacts = productConstraintText(product, selectedMaterials);
  const knowledge = extractMostRelevantKnowledge(product, '', strategy);
  const variantMap = {
    A: '主候选：产品真实应用场景。先建立完整空间，再自然显现商品，镜头稳定克制，适合品牌主视觉。',
    B: '备选2：生活方式/空间氛围方向。强调商品如何提升空间情绪，但必须保持同一件商品的外观、比例和功能事实。',
    C: '备选3：社媒广告方向。前3秒有轻微视觉变化或光线变化，节奏更适合 Reels / Shorts / Pinterest，但不能变成廉价带货或夸张快切。'
  };

  return `
你是高端家居/灯具广告视频 Creative Director。请严格基于 Shopify 商品资料、用户选择的素材图和知识库规则生成视频，不要凭空设计新产品。

${productFacts}

【本次候选方向】
${variantMap[variant] || strategy || variantMap.A}

【用户本次输入】
${userPrompt || '生成真实高端家居广告视频。'}

【本次输出参数】
时长：${duration} 秒
比例：${ratio}
清晰度：${resolution}

${knowledge}

【强制执行】
1. 必须使用完整真实室内/生活方式场景，不允许纯色背景、抽象纹理背景、商品卡片背景。
2. 必须保持 Shopify 商品外观、尺寸比例、材质、颜色、安装方式、结构细节一致。
3. 只能呈现 Shopify 商品详情、标题、变体、图片、tags、metafields 中能证明的功能和卖点；不得编造遥控、调光、智能、防水、可伸缩、可旋转等功能。
4. 如果参考图是场景图，优先保持场景布局、光影和产品位置；如果参考图是白底/主图，必须把产品放入符合品类规则的真实空间。
5. 镜头语言高级克制：慢速推镜、轻微横移、轻微环绕、自然光影，不要夸张旋转，不要闪烁，不要结构变形。
6. 画面应像高端家居广告 / 室内杂志摄影，而不是低端电商素材或 AI 渲染。
`.replace(/\n{3,}/g, '\n\n').slice(0, 7200);
}

function buildSelectedMaterialSummary(materials) {
  if (!Array.isArray(materials) || !materials.length) return '';
  return materials.slice(0, 8).map((m, i) => {
    const parts = [
      `素材${i + 1}`,
      m.title || m.name || m.code || m.id || '',
      m.altText || m.alt || '',
      m.url ? '有商品图URL' : ''
    ].filter(Boolean);
    return parts.join('：');
  }).join('；');
}

function productInfoText(product, selectedMaterials = []) {
  if (!product) return '';
  const description = stripHtml(product.descriptionHtml || product.description).slice(0, 1600);
  const imageAlts = compactList((product.images || []).map((img) => img.altText || img.alt || '').concat(product.imageAlt || '')).slice(0, 12).join('；');
  const options = Array.isArray(product.options) ? product.options.map((o) => `${o.name}: ${(o.values || []).join('/')}`).join('；') : '';
  const selectedOptions = Array.isArray(product.selectedOptions) ? product.selectedOptions.map((o) => `${o.name}: ${o.value}`).join('；') : '';
  const metafields = Array.isArray(product.metafields) ? product.metafields
    .filter((m) => m && m.value && !/(json_string|json)$/i.test(String(m.type || '')))
    .slice(0, 35)
    .map((m) => `${m.namespace}.${m.key}: ${String(m.value).replace(/\s+/g, ' ').slice(0, 220)}`)
    .join('；') : '';
  const tags = Array.isArray(product.tags) ? product.tags.join('；') : '';
  const selectedMaterialSummary = buildSelectedMaterialSummary(selectedMaterials);
  return [
    `商品标题：${product.title || ''}`,
    `SKU：${product.sku || ''}`,
    `变体：${product.variantTitle || ''}`,
    `已选变体选项：${selectedOptions}`,
    `价格：${product.price || ''}`,
    `品类：${product.productType || ''}`,
    `品牌/供应商：${product.vendor || ''}`,
    `标签：${tags}`,
    `规格/选项：${options}`,
    `商品详情页描述：${description}`,
    `商品图 alt/场景说明：${imageAlts}`,
    `商品自定义字段/规格字段：${metafields}`,
    `用户本次选中的参考素材：${selectedMaterialSummary}`
  ].filter((line) => !line.endsWith('：') && !line.endsWith(': ')).join('\n');
}

function productConstraintText(product, selectedMaterials = []) {
  const info = productInfoText(product, selectedMaterials);
  const raw = `${info} ${product && product.title || ''} ${product && product.description || ''} ${product && product.variantTitle || ''}`.toLowerCase();
  const hints = [];
  if (/mini|pendant|p[eé]ndant|吊灯|小吊灯|灯/i.test(raw)) {
    hints.push('如果商品是 mini pendant / pendant light / 吊灯：必须表现为小型吊灯/小型灯具，保持灯罩尺寸和悬挂比例；不要放大成大型吊灯、吊扇、吸顶灯、台灯或家具。');
  }
  if (/side table|table|desk|桌|边几|边桌/i.test(raw)) {
    hints.push('如果商品是桌/边几：必须保持桌面、桌腿、比例和高度，不要把它变成餐桌、柜子、木纹背景或墙面纹理。');
  }
  if (/chair|sofa|stool|bench|椅|沙发|凳/i.test(raw)) {
    hints.push('如果商品是座椅/沙发：必须保持坐具结构和尺度，不要变成桌子、灯具或抽象软装。');
  }
  hints.push('只展示 Shopify 商品详情页明确存在的卖点、尺寸、材质、安装方式、用途和功能；没有在商品数据中出现的功能不要编造。');
  hints.push('尺寸和比例必须以 Shopify 商品图片、商品标题、变体和详情页规格为准。若是 4 inch / 4\" / mini 等小尺寸商品，画面中必须呈现为小件，不得夸大比例。');
  hints.push('必须把商品放进完整、真实、可投放的居家/商业空间场景中展示；不要生成纯色背景、抽象纹理背景、商品卡片背景或只有局部纹理的画面。');
  hints.push('允许使用场景图作为环境参考，但主体商品必须来自所选 Shopify 商品和所选素材，不要随机生成相似但不同的产品。');
  hints.push('场景中的其他物件只能作为比例参照和环境氛围，不能暗示商品拥有 Shopify 详情页没有写明的功能、配件或智能能力。');
  return `【Shopify 商品事实与约束】\n${info}\n\n【禁止模型捏造】\n${hints.join('\n')}`.slice(0, 4200);
}

function productImageUrls(product) {
  if (!product) return [];
  const urls = [];
  if (product.imageUrl) urls.push(product.imageUrl);
  if (product.featuredImage && product.featuredImage.url) urls.push(product.featuredImage.url);
  if (Array.isArray(product.images)) {
    for (const image of product.images) {
      if (!image) continue;
      if (typeof image === 'string') urls.push(image);
      else if (image.url) urls.push(image.url);
      else if (image.src) urls.push(image.src);
    }
  }
  return uniqueHttpsUrls(urls).slice(0, Number(optional('OPENROUTER_VIDEO_MAX_REFERENCE_IMAGES', 3)) || 3);
}

function imageLooksLikeScene(image) {
  const text = `${image && (image.altText || image.alt || image.title || image.name || '') || ''}`.toLowerCase();
  if (/(scene|room|kitchen|living|bedroom|bathroom|stair|entry|hall|interior|lifestyle|场景|客厅|卧室|厨房|空间|室内|安装|效果|搭配)/i.test(text)) return true;
  if (/(main|primary|主图|cutout|white background|plain|detail|closeup|细节|局部)/i.test(text)) return false;
  return false;
}

function productImageObjects(product) {
  const out = [];
  if (!product) return out;
  if (product.imageUrl) out.push({ url: product.imageUrl, altText: product.imageAlt || 'featured product image', priority: 1 });
  if (product.featuredImage && product.featuredImage.url) out.push({ url: product.featuredImage.url, altText: product.featuredImage.altText || 'featured product image', priority: 1 });
  if (Array.isArray(product.images)) {
    for (const image of product.images) {
      if (!image) continue;
      if (typeof image === 'string') out.push({ url: image, altText: '', priority: 2 });
      else if (image.url || image.src) out.push({ url: image.url || image.src, altText: image.altText || image.alt || image.title || '', priority: 2 });
    }
  }
  return out.filter((x) => x.url && /^https:\/\//i.test(x.url));
}

function buildVideoReferencePayload(product, explicitImages = []) {
  const productImages = productImageObjects(product);
  const explicit = (explicitImages || []).map((x) => typeof x === 'string' ? { url: x, altText: 'user selected material', priority: 0 } : x).filter(Boolean);
  const allObjects = [...explicit, ...productImages];
  const urls = uniqueHttpsUrls(allObjects.map((x) => x.url || x.src || x.imageUrl));
  if (!urls.length) return {};

  // Use a lifestyle/scene image as first frame when available. Using a plain product cutout as first frame
  // often makes video models produce product-card / pure-background videos. Product cutouts still remain
  // as input references to lock the exact item design.
  const sceneCandidate = allObjects.find((img) => img && (img.url || img.src || img.imageUrl) && imageLooksLikeScene(img));
  const firstFrameUrl = sceneCandidate ? (sceneCandidate.url || sceneCandidate.src || sceneCandidate.imageUrl) : urls[0];
  const orderedUrls = uniqueHttpsUrls([firstFrameUrl, ...urls]);
  const maxRefs = Number(optional('OPENROUTER_VIDEO_MAX_REFERENCE_IMAGES', 6)) || 6;

  const inputReferences = orderedUrls.slice(0, maxRefs).map((url) => ({
    type: 'image_url',
    image_url: { url }
  }));
  const frameImages = [{
    type: 'image_url',
    image_url: { url: firstFrameUrl },
    frame_type: 'first_frame'
  }];
  return { inputReferences, frameImages, referenceUrls: orderedUrls, firstFrameUrl };
}

function shouldUseProductImagesForVideo() {
  return String(optional('OPENROUTER_VIDEO_USE_PRODUCT_IMAGES', 'true')).toLowerCase() !== 'false';
}

async function createOpenRouterVideoJob({ prompt, duration = 4, ratio = '16:9', resolution = '720p', model: requestedModel, product, referenceImages }) {
  const model = requestedModel || optional('OPENROUTER_VIDEO_MODEL', 'bytedance/seedance-2.0');
  const payload = {
    model,
    prompt: String(prompt || '').slice(0, 2600),
    duration: normalizeOpenRouterDuration(duration),
    resolution: normalizeOpenRouterResolution(resolution),
    aspect_ratio: normalizeOpenRouterAspectRatio(ratio),
    generate_audio: String(optional('OPENROUTER_VIDEO_GENERATE_AUDIO', 'false')).toLowerCase() === 'true'
  };

  if (shouldUseProductImagesForVideo()) {
    const refs = buildVideoReferencePayload(product, referenceImages);
    if (refs.inputReferences && refs.inputReferences.length) {
      payload.input_references = refs.inputReferences;
      // Anchor the opening frame to the Shopify product image so the model does not invent a random product.
      payload.frame_images = refs.frameImages;
    }
  }

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

async function concatVideoBuffers({ localJobId, buffers, contentType = 'video/mp4', targetDuration, generatedDuration }) {
  const generatedDir = path.join(__dirname, 'generated');
  const workDir = path.join(generatedDir, `${localJobId}-segments`);
  fs.mkdirSync(workDir, { recursive: true });

  const segmentPaths = buffers.map((buffer, index) => {
    const p = path.join(workDir, `segment-${String(index + 1).padStart(2, '0')}.mp4`);
    fs.writeFileSync(p, buffer);
    return p;
  });

  const needsTrim = targetDuration && generatedDuration && Number(generatedDuration) > Number(targetDuration);
  const localVideoPath = path.join(generatedDir, `${localJobId}.mp4`);

  if (segmentPaths.length === 1 && !needsTrim) {
    fs.copyFileSync(segmentPaths[0], localVideoPath);
    return { buffer: fs.readFileSync(localVideoPath), contentType, localVideoPath };
  }

  if (!ffmpegPath) {
    if (segmentPaths.length === 1) {
      fs.copyFileSync(segmentPaths[0], localVideoPath);
      return { buffer: fs.readFileSync(localVideoPath), contentType, localVideoPath, trimSkipped: needsTrim };
    }
    throw new Error('ffmpeg-static is not available; cannot merge video segments into one ad video.');
  }

  const mergedPath = path.join(workDir, 'merged.mp4');

  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], mergedPath);
  } else {
    const listPath = path.join(workDir, 'segments.txt');
    fs.writeFileSync(listPath, segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    try {
      await execFilePromise(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', mergedPath], { timeout: 600000 });
    } catch (copyError) {
      await execFilePromise(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', mergedPath], { timeout: 900000 });
    }
  }

  if (needsTrim) {
    await execFilePromise(ffmpegPath, ['-y', '-i', mergedPath, '-t', String(targetDuration), '-c', 'copy', '-movflags', '+faststart', localVideoPath], { timeout: 600000 });
  } else {
    fs.copyFileSync(mergedPath, localVideoPath);
  }

  return { buffer: fs.readFileSync(localVideoPath), contentType: 'video/mp4', localVideoPath, trimmed: needsTrim };
}

function buildSegmentPrompt({ prompt, product, selectedMaterials, totalDuration, segmentIndex, segmentCount, segmentDuration }) {
  return [
    `你正在生成一个 ${totalDuration} 秒电商广告视频的第 ${segmentIndex + 1}/${segmentCount} 段，本段时长 ${segmentDuration} 秒。`,
    productConstraintText(product, selectedMaterials),
    '必须使用随请求提供的 Shopify 商品图片作为视觉参考。保持参考图中的商品外观、颜色、材质、轮廓、结构、比例和设计细节一致。',
    '不要生成无关物体、抽象木纹、随机家具、随机灯具或与参考图不一致的产品。商品必须是画面主体。',
    '要求：真实电商广告质感，完整空间场景，干净构图，镜头运动自然，适合投放；不要出现纯色底图、抽象背景、商品卡片背景、字幕乱码、水印、logo 乱入。',
    segmentIndex === 0 ? '本段是开场：3 秒内展示该商品本体在完整真实场景中的使用状态，并且商品尺寸必须与详情页和参考图一致。' : '',
    segmentIndex === segmentCount - 1 ? '本段是结尾：再次展示同一个商品，突出 Shopify 详情页中真实存在的卖点和自然 CTA，但不要编造功能。' : '',
    `完整广告 brief：${prompt}`
  ].filter(Boolean).join('\n').slice(0, 5200);
}

async function generateOpenRouterVideoAndSave({ localJobId, prompt, duration, ratio, resolution, model, product, referenceImages, selectedMaterials }) {
  const selectedModel = model || optional('OPENROUTER_VIDEO_MODEL', 'bytedance/seedance-2.0');
  const finalDuration = normalizeOpenRouterDuration(duration);
  const segmentPlan = planVideoSegments(finalDuration, selectedModel);
  const maxDirectDuration = getMaxDirectDuration(selectedModel);
  const shouldSegment = segmentPlan.durations.length > 1 || finalDuration > maxDirectDuration || segmentPlan.trimToTarget;
  const contentType = 'video/mp4';
  const segmentResults = [];

  updateJob(localJobId, {
    status: shouldSegment ? 'planning_segmented_ad_video' : 'submitting_to_openrouter',
    progress: 6,
    result: {
      model: selectedModel,
      targetDuration: segmentPlan.targetDuration,
      generatedDuration: segmentPlan.generatedDuration,
      plannedSegments: segmentPlan.durations,
      allowedDurations: segmentPlan.allowedDurations,
      trimToTarget: segmentPlan.trimToTarget,
      referenceImages: buildVideoReferencePayload(product, referenceImages).referenceUrls || []
    }
  });

  if (!shouldSegment) {
    updateJob(localJobId, { status: 'submitting_to_openrouter', progress: 8 });
    const openRouterCreate = await createOpenRouterVideoJob({ prompt, duration: finalDuration, ratio, resolution, model: selectedModel, product, referenceImages });
    const single = await pollOpenRouterVideoToBuffer(localJobId, openRouterCreate, 15, 78, 'video');
    segmentResults.push(single);
  } else {
    const segmentCount = segmentPlan.durations.length;
    for (let index = 0; index < segmentCount; index += 1) {
      const thisDuration = segmentPlan.durations[index];
      const base = 8 + Math.round((index / segmentCount) * 82);
      const span = Math.max(5, Math.round(82 / segmentCount));
      updateJob(localJobId, {
        status: `submitting_segment_${index + 1}_of_${segmentCount}`,
        progress: base,
        result: {
          segmentIndex: index + 1,
          segmentCount,
          finalDuration,
          generatedDuration: segmentPlan.generatedDuration,
          plannedSegments: segmentPlan.durations,
          segmentDuration: thisDuration,
          model: selectedModel
        }
      });
      const segmentPrompt = buildSegmentPrompt({ prompt, product, selectedMaterials, totalDuration: finalDuration, segmentIndex: index, segmentCount, segmentDuration: thisDuration });
      const openRouterCreate = await createOpenRouterVideoJob({ prompt: segmentPrompt, duration: thisDuration, ratio, resolution, model: selectedModel, product, referenceImages });
      const segment = await pollOpenRouterVideoToBuffer(localJobId, openRouterCreate, base, span, `segment_${index + 1}_of_${segmentCount}`);
      segmentResults.push(segment);
    }
  }

  updateJob(localJobId, { status: segmentResults.length > 1 ? 'merging_segments' : 'preparing_video', progress: 96, result: { segments: segmentResults.map((s) => ({ openRouterJobId: s.openRouterJobId })) } });
  const merged = await concatVideoBuffers({
    localJobId,
    buffers: segmentResults.map((s) => s.buffer),
    contentType,
    targetDuration: segmentPlan.targetDuration,
    generatedDuration: segmentPlan.generatedDuration
  });

  const baseResult = {
    finalDuration,
    generatedDuration: segmentPlan.generatedDuration,
    trimToTarget: segmentPlan.trimToTarget,
    plannedSegments: segmentPlan.durations,
    segmentCount: segmentResults.length,
    segmentJobs: segmentResults.map((s) => s.openRouterJobId),
    videoUrl: `/api/jobs/${localJobId}/video`,
    localVideoPath: merged.localVideoPath,
    segments: segmentResults.map((s, index) => ({ openRouterJobId: s.openRouterJobId, duration: segmentPlan.durations[index] }))
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

function normalizeImageAspectRatio(ratio) {
  const value = String(ratio || optional('OPENROUTER_IMAGE_ASPECT_RATIO', '1:1')).trim();
  const allowed = new Set(['1:1', '16:9', '9:16', '4:5', '5:4', '3:2', '2:3', '4:3', '3:4']);
  return allowed.has(value) ? value : '1:1';
}

function normalizeImageResolution(resolution) {
  const value = String(resolution || optional('OPENROUTER_IMAGE_RESOLUTION', '1024x1024')).trim();
  return value || '1024x1024';
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function firstImageUrlFromOpenRouter(responseData) {
  const choice = responseData && responseData.choices && responseData.choices[0];
  const message = choice && choice.message;
  const images = message && (message.images || message.image_urls || message.image_url ? (message.images || message.image_urls || [message.image_url]) : []);
  for (const image of images || []) {
    const url = image && (
      image.url ||
      (image.image_url && image.image_url.url) ||
      (image.imageUrl && image.imageUrl.url) ||
      image.image_url ||
      image.imageUrl
    );
    if (url) return url;
  }
  return null;
}

async function openRouterGenerateImage({ prompt, model, ratio, resolution, product }) {
  const selectedModel = model || optional('OPENROUTER_IMAGE_MODEL', 'google/gemini-3.1-flash-image-preview');
  const productContext = product ? `\n\n商品信息：${product.title || ''} SKU:${product.sku || ''} 描述:${product.description || ''}` : '';
  const finalPrompt = `${prompt || ''}${productContext}`.slice(0, 3000);
  const payload = {
    model: selectedModel,
    messages: [
      { role: 'system', content: '你是电商广告视觉设计师。请根据用户要求生成可用于广告素材的高质量商品图片，不要添加乱码文字、水印或错误品牌 logo。' },
      { role: 'user', content: finalPrompt }
    ],
    modalities: ['image', 'text'],
    image_config: {
      aspect_ratio: normalizeImageAspectRatio(ratio),
      resolution: normalizeImageResolution(resolution)
    }
  };
  const response = await axios.post(`${OPENROUTER_BASE_URL}/chat/completions`, payload, {
    headers: openRouterHeaders(),
    timeout: Number(optional('OPENROUTER_IMAGE_TIMEOUT_MS', 300000))
  });
  const imageUrl = firstImageUrlFromOpenRouter(response.data);
  if (!imageUrl) {
    throw new Error(`OpenRouter image response did not include an image. Response: ${JSON.stringify(response.data).slice(0, 1200)}`);
  }
  let buffer;
  let mimeType = 'image/png';
  const dataImage = dataUrlToBuffer(imageUrl);
  if (dataImage) {
    buffer = dataImage.buffer;
    mimeType = dataImage.mimeType || mimeType;
  } else if (/^https?:\/\//.test(imageUrl)) {
    const downloaded = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 300000 });
    buffer = Buffer.from(downloaded.data);
    mimeType = downloaded.headers['content-type'] || mimeType;
  } else {
    throw new Error('Unsupported image URL returned by OpenRouter.');
  }
  const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
  const generatedDir = path.join(__dirname, 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  const filename = `image-${Date.now()}-${uuidv4().slice(0, 8)}.${ext}`;
  const localImagePath = path.join(generatedDir, filename);
  fs.writeFileSync(localImagePath, buffer);

  const baseResult = {
    model: selectedModel,
    imageUrl: `/generated/${filename}`,
    localImagePath,
    mimeType,
    prompt: finalPrompt
  };

  try {
    const driveFile = await uploadBufferToDrive({ buffer, filename, mimeType });
    return { ...baseResult, driveFile };
  } catch (driveError) {
    return {
      ...baseResult,
      driveError: driveError.response && driveError.response.data ? JSON.stringify(driveError.response.data) : driveError.message
    };
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
  const images = [];
  if (product.images && product.images.edges) {
    for (const imageEdge of product.images.edges) {
      if (imageEdge.node && imageEdge.node.url) {
        images.push({ url: imageEdge.node.url, altText: imageEdge.node.altText || '' });
      }
    }
  }
  if (image && image.url && !images.some((item) => item.url === image.url)) {
    images.unshift({ url: image.url, altText: image.altText || '' });
  }
  const selectedOptions = Array.isArray(variant.selectedOptions) ? variant.selectedOptions.map((o) => ({ name: o.name, value: o.value })) : [];
  const productOptions = Array.isArray(product.options) ? product.options.map((o) => ({ name: o.name, values: o.values || [] })) : [];
  const metafields = [];
  if (product.metafields && product.metafields.edges) {
    for (const mfEdge of product.metafields.edges) {
      const mf = mfEdge.node;
      if (mf && mf.value) metafields.push({ namespace: mf.namespace, key: mf.key, type: mf.type, value: mf.value });
    }
  }
  return {
    productId: product.id,
    variantId: variant.id,
    title: product.title,
    handle: product.handle,
    description: product.description,
    descriptionHtml: product.descriptionHtml || '',
    productType: product.productType || '',
    vendor: product.vendor || '',
    tags: product.tags || [],
    seo: product.seo || {},
    options: productOptions,
    selectedOptions,
    metafields,
    sku: variant.sku,
    variantTitle: variant.title,
    price: variant.price,
    imageUrl: image && image.url,
    imageAlt: image && image.altText,
    images,
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
            selectedOptions { name value }
            product {
              id
              title
              handle
              description
              descriptionHtml
              productType
              vendor
              tags
              seo { title description }
              options { name values }
              metafields(first: 50) { edges { node { namespace key type value } } }
              featuredImage { url altText }
              images(first: 12) { edges { node { url altText } } }
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
      imageGeneration: Boolean(process.env.OPENROUTER_API_KEY),
      shopify: Boolean(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN),
      googleDrive: Boolean(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_DRIVE_FOLDER_ID)
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
      { id: optional('OPENROUTER_VIDEO_MODEL', 'bytedance/seedance-2.0'), label: 'OpenRouter · Seedance 2.0' },
      { id: optional('OPENROUTER_VIDEO_MODEL_ALT', 'google/veo-3.1-lite'), label: 'OpenRouter · Veo 3.1 Lite' }
    ],
    imageModels: [
      { id: optional('OPENROUTER_IMAGE_MODEL', 'google/gemini-3.1-flash-image-preview'), label: 'OpenRouter · Gemini Image' },
      { id: optional('OPENROUTER_IMAGE_MODEL_ALT', 'black-forest-labs/flux.2-pro'), label: 'OpenRouter · Flux 2 Pro' }
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

app.post('/api/agent/create-image', asyncHandler(async (req, res) => {
  const { sku, prompt, ratio = '1:1', resolution = '1024x1024', product, imageModel } = req.body;
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

  let resolvedProduct = product || null;
  if (!resolvedProduct && sku) {
    const found = await searchShopifyBySkuOrText(sku);
    resolvedProduct = found[0] || null;
  }

  const result = await openRouterGenerateImage({ prompt, model: imageModel, ratio, resolution, product: resolvedProduct });
  res.json({ ok: true, image: result });
}));

app.post('/api/generate-image', asyncHandler(async (req, res) => {
  req.url = '/api/agent/create-image';
  app._router.handle(req, res, () => {});
}));


app.get('/api/knowledge/status', asyncHandler(async (req, res) => {
  res.json({
    ok: true,
    files: {
      furnitureVideoRules: Boolean(KNOWLEDGE_BASE.furnitureVideoRules),
      lightingSceneRules: Boolean(KNOWLEDGE_BASE.lightingSceneRules),
      lightingAdSystem: Boolean(KNOWLEDGE_BASE.lightingAdSystem)
    }
  });
}));

app.post('/api/agent/create-video', asyncHandler(async (req, res) => {
  const { sku, prompt, duration = 30, ratio = '16:9', resolution = '1080p', product, videoModel, imageUrl, referenceImages, selectedMaterials = [] } = req.body;
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

  let resolvedProduct = product || null;
  if (!resolvedProduct && sku) {
    const found = await searchShopifyBySkuOrText(sku);
    resolvedProduct = found[0] || null;
  }

  const selectedMaterialUrls = Array.isArray(selectedMaterials)
    ? selectedMaterials.map((item) => item && (item.url || item.src || item.imageUrl)).filter(Boolean)
    : [];
  const refs = uniqueHttpsUrls([
    imageUrl,
    ...(referenceImages || []),
    ...selectedMaterialUrls,
    ...(selectedMaterialUrls.length ? [] : productImageUrls(resolvedProduct))
  ]);
  if (!refs.length) {
    return res.status(400).json({ ok: false, error: '没有可用的 Shopify 商品图片。请确认该产品在 Shopify 里有商品图，并且图片 URL 可公开访问。' });
  }

  const normalizedDuration = normalizeOpenRouterDuration(duration);
  const normalizedRatio = normalizeOpenRouterAspectRatio(ratio);
  const normalizedResolution = normalizeOpenRouterResolution(resolution);
  const finalPrompt = buildAIDirectorPrompt({
    product: resolvedProduct,
    selectedMaterials,
    userPrompt: prompt,
    duration: normalizedDuration,
    ratio: normalizedRatio,
    resolution: normalizedResolution,
    variant: 'A',
    strategy: 'product-scene-ad'
  });
  const job = createJob('openrouter-video-generation', { sku, prompt: finalPrompt, duration: normalizedDuration, ratio: normalizedRatio, resolution: normalizedResolution, product: resolvedProduct, referenceImages: refs, selectedMaterials, knowledgeVersion: 'md-pack-v1' });
  res.json({ ok: true, job });

  process.nextTick(async () => {
    try {
      updateJob(job.id, { status: 'starting_image_to_video_pipeline', progress: 5, result: { product: resolvedProduct, videoModel: videoModel || optional('OPENROUTER_VIDEO_MODEL', 'bytedance/seedance-2.0'), referenceImages: refs } });
      await generateOpenRouterVideoAndSave({ localJobId: job.id, prompt: finalPrompt, duration: normalizedDuration, ratio: normalizedRatio, resolution: normalizedResolution, model: videoModel, product: resolvedProduct, referenceImages: refs, selectedMaterials });
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
