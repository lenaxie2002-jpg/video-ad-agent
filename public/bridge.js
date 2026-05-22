(function () {
  const root = document.documentElement;
  const stateBag = {
    product: null,
    lastJob: null,
    lastVideoUrl: null,
    lastDriveFile: null
  };

  function $(selector, base = document) { return base.querySelector(selector); }
  function $all(selector, base = document) { return Array.from(base.querySelectorAll(selector)); }

  function toast(message, type = 'info') {
    let box = document.getElementById('real-agent-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'real-agent-toast';
      box.style.cssText = 'position:fixed;right:20px;bottom:86px;z-index:9999;max-width:420px;padding:12px 14px;border-radius:10px;font-size:13px;line-height:1.5;box-shadow:0 10px 30px rgba(0,0,0,.18);background:#111827;color:white;white-space:pre-wrap;';
      document.body.appendChild(box);
    }
    const palette = { info: '#111827', ok: '#176f3d', warn: '#9a5b00', error: '#b91c1c' };
    box.style.background = palette[type] || palette.info;
    box.textContent = message;
    clearTimeout(box._timer);
    box._timer = setTimeout(() => { box.remove(); }, type === 'error' ? 9000 : 5000);
  }

  async function apiFetch(path, options) {
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败：${res.status}`);
    return data;
  }

  function postJson(path, body) {
    return apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function readSku() {
    const productText = ($('#topbar-product') && $('#topbar-product').textContent) || '';
    const skuMatch = productText.match(/SKU[:：]\s*([^\s-]+)/i);
    if (skuMatch) return skuMatch[1];
    const input = $('.shopify-search input');
    return input ? input.value.trim() : '';
  }

  function readVideoPrompt() {
    return ($('#video-ai-prompt') && $('#video-ai-prompt').value.trim()) ||
      ($('#md-inline-text') && $('#md-inline-text').value.trim()) ||
      '生成一个电商广告视频，突出商品质感、空间氛围和购买动机。';
  }

  function currentRatio() {
    const el = $('#video-ratio');
    if (el) return el.value;
    const clipRatio = $all('select').find((s) => ['1:1', '9:16', '16:9', '4:5'].includes(s.value));
    return clipRatio ? clipRatio.value : '1:1';
  }

  function currentDuration() {
    const durationSelect = $('#video-duration');
    if (durationSelect && durationSelect.value === '自定义') {
      return Number(($('#custom-duration-input') && $('#custom-duration-input').value) || 5);
    }
    if (durationSelect) {
      const n = parseInt(durationSelect.value, 10);
      if (Number.isFinite(n)) return n;
    }
    const clip = $all('select').find((s) => /秒$/.test(s.value));
    return clip ? parseInt(clip.value, 10) : 5;
  }

  function updateProductUI(product) {
    stateBag.product = product;
    const title = product.title || '未命名商品';
    const sku = product.sku || '';
    const imageUrl = product.imageUrl;
    const top = $('#topbar-product');
    if (top) top.textContent = `SKU: ${sku} - ${title}`;

    const card = $('.product-card');
    if (card) {
      const thumb = $('.product-thumb', card);
      if (thumb) {
        thumb.innerHTML = imageUrl ? `<img alt="${title}" src="${imageUrl}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;">` : (title[0] || 'P');
      }
      const titleEl = $('.product-title', card);
      if (titleEl) titleEl.textContent = title;
      const meta = $('.product-meta', card);
      if (meta) {
        meta.innerHTML = `<span>SKU: ${sku || '-'}</span><span>变体: ${product.variantTitle || '-'}</span><span>价格: ${product.price || '-'}</span><span>店铺: ${product.shop || '-'}</span>`;
      }
    }
  }

  async function searchShopify(q) {
    if (!q) return toast('请输入 SKU 或商品关键词', 'warn');
    toast(`正在从 Shopify 查询：${q}`);
    const data = await apiFetch(`/api/shopify/search?q=${encodeURIComponent(q)}`);
    if (!data.products || !data.products.length) {
      toast(`Shopify 没有找到：${q}\n请检查 SKU 是否存在，或确认 Admin Token 有 read_products 权限。`, 'error');
      return null;
    }
    updateProductUI(data.products[0]);
    toast(`已找到 Shopify 商品：${data.products[0].title}`, 'ok');
    return data.products[0];
  }

  function ensureResultsScreen() {
    if (typeof window.showScreen === 'function') window.showScreen('04');
    else {
      const btn = document.querySelector('.nav-item[data-screen="04"]');
      if (btn) btn.click();
    }
  }

  function setCandidateLoading(job) {
    ensureResultsScreen();
    const banner = $('#generation-banner');
    if (banner) {
      banner.innerHTML = `<div class="banner processing"><div><div class="banner-title">真实视频生成中</div><div class="banner-body">已提交到后端任务 ${job.id}。正在调用 Runway，完成后会自动保存到 Google Drive。</div></div><div class="progress-bar"><span id="real-job-progress" style="width:5%;"></span></div></div>`;
    }
    const first = $('.video-result-card');
    if (first) {
      const preview = $('.vr-preview', first);
      if (preview) preview.innerHTML = '<div style="color:#fff;text-align:center;padding:18px;">真实生成中...<br><small>Runway 任务完成后这里会出现视频</small></div>';
    }
  }

  function updateCandidateWithJob(job) {
    const bar = $('#real-job-progress');
    if (bar) bar.style.width = `${job.progress || 0}%`;
    const banner = $('#generation-banner');
    if (banner) {
      const title = job.status === 'completed' ? '真实视频生成完成' : job.status === 'failed' ? '真实视频生成失败' : '真实视频生成中';
      const body = job.status === 'failed'
        ? (job.error || '未知错误')
        : `状态：${job.status} · 进度：${job.progress || 0}%`;
      banner.innerHTML = `<div class="banner ${job.status === 'failed' ? '' : 'processing'}"><div><div class="banner-title">${title}</div><div class="banner-body">${body}</div></div>${job.status === 'completed' && job.result && job.result.driveFile ? `<a class="btn btn-primary btn-sm" target="_blank" href="${job.result.driveFile.webViewLink}">打开 Drive 文件</a>` : `<div class="progress-bar"><span id="real-job-progress" style="width:${job.progress || 0}%;"></span></div>`}</div>`;
    }
    if (job.status === 'completed' && job.result) {
      stateBag.lastVideoUrl = job.result.videoUrl;
      stateBag.lastDriveFile = job.result.driveFile;
      const first = $('.video-result-card');
      if (first) {
        const preview = $('.vr-preview', first);
        if (preview && job.result.videoUrl) {
          preview.innerHTML = `<video controls playsinline src="${job.result.videoUrl}" style="width:100%;height:100%;object-fit:cover;background:#111;"></video>`;
        }
        const tag = $('.vr-title .tag', first);
        if (tag && job.result.driveFile) {
          tag.className = 'tag tag-success';
          tag.textContent = 'Drive 已保存';
        }
        const info = $('.summary-list', first);
        if (info) {
          info.innerHTML = `<div><strong>真实生成结果:</strong> Runway 视频已完成，并已保存到 Google Drive。</div>${job.result.driveFile ? `<div><strong>Drive:</strong> <a href="${job.result.driveFile.webViewLink}" target="_blank">${job.result.driveFile.name}</a></div>` : ''}`;
        }
      }
      toast('真实视频已生成并保存到 Google Drive', 'ok');
    }
    if (job.status === 'failed') toast(`生成失败：${job.error}`, 'error');
  }

  async function pollJob(jobId) {
    for (let i = 0; i < 140; i += 1) {
      const data = await apiFetch(`/api/jobs/${jobId}`);
      const job = data.job;
      stateBag.lastJob = job;
      updateCandidateWithJob(job);
      if (['completed', 'failed'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    toast('轮询超时：Runway 可能仍在生成，请稍后刷新页面或查看 Render 日志。', 'warn');
  }

  async function startRealVideoGeneration() {
    try {
      const sku = readSku();
      let product = stateBag.product;
      if (!product && sku) {
        try { product = await searchShopify(sku); } catch (err) { toast(`Shopify 查询失败，将尝试纯文本生成：${err.message}`, 'warn'); }
      }
      const payload = {
        sku,
        product,
        imageUrl: product && product.imageUrl,
        prompt: readVideoPrompt(),
        duration: currentDuration(),
        ratio: currentRatio()
      };
      toast('正在提交真实视频生成任务...');
      const data = await postJson('/api/agent/create-video', payload);
      stateBag.lastJob = data.job;
      setCandidateLoading(data.job);
      pollJob(data.job.id).catch((err) => toast(`轮询失败：${err.message}`, 'error'));
    } catch (err) {
      toast(`生成失败：${err.message}`, 'error');
    }
  }

  async function saveMetadataToDrive() {
    try {
      if (stateBag.lastDriveFile) {
        toast(`视频已经保存到 Drive：${stateBag.lastDriveFile.name}`, 'ok');
        window.open(stateBag.lastDriveFile.webViewLink, '_blank', 'noopener,noreferrer');
        return;
      }
      const payload = { product: stateBag.product, job: stateBag.lastJob, savedAt: new Date().toISOString() };
      const data = await postJson('/api/save-drive-json', { filename: `video-ad-agent-${Date.now()}.json`, data: payload });
      toast(`已保存元数据到 Drive：${data.file.name}`, 'ok');
      if (data.file.webViewLink) window.open(data.file.webViewLink, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast(`保存到 Drive 失败：${err.message}`, 'error');
    }
  }

  function install() {
    // SKU / Shopify 搜索：输入后回车或离开输入框。
    const shopifyInput = $('.shopify-search input');
    if (shopifyInput) {
      shopifyInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          searchShopify(shopifyInput.value.trim()).catch((err) => toast(`Shopify 查询失败：${err.message}`, 'error'));
        }
      });
      shopifyInput.addEventListener('change', () => {
        searchShopify(shopifyInput.value.trim()).catch((err) => toast(`Shopify 查询失败：${err.message}`, 'error'));
      });
    }

    // 捕获所有相关按钮，不依赖原 HTML 的 mock 逻辑。
    document.addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();

      if (text.includes('开始生成视频片段') || text === '重新生成' || text.includes('生成视频')) {
        event.preventDefault();
        event.stopPropagation();
        startRealVideoGeneration();
        return;
      }

      if (text.includes('保存到 Drive') || text.includes('保存到Drive')) {
        event.preventDefault();
        event.stopPropagation();
        saveMetadataToDrive();
        return;
      }

      if (text.includes('下载')) {
        if (stateBag.lastVideoUrl) {
          event.preventDefault();
          window.open(stateBag.lastVideoUrl, '_blank', 'noopener,noreferrer');
        } else {
          toast('还没有真实生成的视频可下载。请先完成生成。', 'warn');
        }
      }
    }, true);

    // 显示当前配置状态。
    apiFetch('/api/config/status').then((data) => {
      const missing = Object.entries(data.services).filter(([, ok]) => !ok).map(([k]) => k);
      if (missing.length) toast(`当前缺少配置：${missing.join(', ')}`, 'warn');
      else toast('后端配置已就绪：Shopify / Runway / Google Drive', 'ok');
    }).catch((err) => toast(`后端状态检查失败：${err.message}`, 'error'));
  }

  window.RealVideoAgent = { startRealVideoGeneration, searchShopify, saveMetadataToDrive, state: stateBag };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
