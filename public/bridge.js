(function () {
  const root = document.documentElement;
  const stateBag = {
    product: null,
    lastJob: null,
    lastVideoUrl: null,
    lastDriveFile: null,
    modelConfig: null
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
    const raw = el ? el.value : (($all('select').find((s) => ['16:9', '9:16'].includes(s.value)) || {}).value || '16:9');
    return ['16:9', '9:16'].includes(raw) ? raw : '16:9';
  }

  function currentDuration() {
    const durationSelect = $('#video-duration');
    if (!durationSelect) return 30;
    if (durationSelect.value === '自定义') {
      const custom = $('#custom-duration-input');
      const n = custom ? parseInt(custom.value, 10) : 30;
      return Number.isFinite(n) ? Math.max(5, Math.min(n, 120)) : 30;
    }
    const raw = parseInt(durationSelect.value, 10);
    return Number.isFinite(raw) ? raw : 30;
  }

  function currentResolution() {
    const el = $('#video-resolution');
    const raw = el ? String(el.value).toLowerCase() : '720p';
    return ['720p', '1080p'].includes(raw) ? raw : '720p';
  }

  function currentVideoModel() {
    const select = $('#video-model-select-real');
    if (select && select.value) return select.value;
    return stateBag.modelConfig && stateBag.modelConfig.videoModels && stateBag.modelConfig.videoModels[0] && stateBag.modelConfig.videoModels[0].id;
  }

  function replaceSelectOptions(select, options, selectedValue) {
    if (!select || !options || !options.length) return;
    select.innerHTML = options.map((item) => `<option value="${item.value || item.id}">${item.label || item.value || item.id}</option>`).join('');
    if (selectedValue) select.value = selectedValue;
  }

  async function configureOpenRouterSelectors() {
    try {
      const data = await apiFetch('/api/openrouter/model-config');
      stateBag.modelConfig = data;

      const textSelect = $('#text-model');
      replaceSelectOptions(textSelect, (data.textModels || []).map((m) => ({ value: m.id, label: m.label })), data.textModels && data.textModels[0] && data.textModels[0].id);

      const durationSelect = $('#video-duration');
      replaceSelectOptions(durationSelect, [
        { value: '15 秒', label: '15 秒' },
        { value: '30 秒', label: '30 秒（广告推荐）' },
        { value: '45 秒', label: '45 秒' },
        { value: '60 秒', label: '60 秒' },
        { value: '自定义', label: '自定义' }
      ], `${(data.safeVideoDefaults && data.safeVideoDefaults.duration) || 30} 秒`);

      const ratioSelect = $('#video-ratio');
      replaceSelectOptions(ratioSelect, [
        { value: '16:9', label: '16:9' },
        { value: '9:16', label: '9:16' },
        { value: '1:1', label: '1:1' },
        { value: '4:5', label: '4:5' }
      ], (data.safeVideoDefaults && data.safeVideoDefaults.aspectRatio) || '16:9');

      const resolutionSelect = $('#video-resolution');
      replaceSelectOptions(resolutionSelect, [
        { value: '720p', label: '720p' },
        { value: '1080p', label: '1080p' },
        { value: '2K', label: '2K' },
        { value: '4K', label: '4K' }
      ], (data.safeVideoDefaults && data.safeVideoDefaults.resolution) || '1080p');

      const panelVideo = $('#panel-video');
      if (panelVideo && !$('#video-model-select-real')) {
        const firstRow = panelVideo.querySelector('.form-row.two');
        if (firstRow) {
          const wrap = document.createElement('div');
          wrap.innerHTML = `<label for="video-model-select-real">OpenRouter 视频模型</label><select id="video-model-select-real"></select><div class="form-hint">统一通过 OpenRouter /api/v1/videos 提交异步视频任务。</div>`;
          firstRow.appendChild(wrap);
          replaceSelectOptions($('#video-model-select-real'), (data.videoModels || []).map((m) => ({ value: m.id, label: m.label })), data.videoModels && data.videoModels[0] && data.videoModels[0].id);
        }
      } else {
        replaceSelectOptions($('#video-model-select-real'), (data.videoModels || []).map((m) => ({ value: m.id, label: m.label })), data.videoModels && data.videoModels[0] && data.videoModels[0].id);
      }

      toast('OpenRouter 模型配置已加载：文本 / 视频统一走 OpenRouter', 'ok');
    } catch (err) {
      toast(`OpenRouter 模型配置加载失败：${err.message}`, 'warn');
    }
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
      banner.innerHTML = `<div class="banner processing"><div><div class="banner-title">真实视频生成中</div><div class="banner-body">已提交到后端任务 ${job.id}。默认生成 30 秒广告成片；若模型不支持单次 30 秒，后端会自动分段生成并合成后保存到 Google Drive。</div></div><div class="progress-bar"><span id="real-job-progress" style="width:5%;"></span></div></div>`;
    }
    const first = $('.video-result-card');
    if (first) {
      const preview = $('.vr-preview', first);
      if (preview) preview.innerHTML = '<div style="color:#fff;text-align:center;padding:18px;">真实生成中...<br><small>OpenRouter 视频任务完成后这里会出现视频</small></div>';
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
          info.innerHTML = `<div><strong>真实生成结果:</strong> OpenRouter 视频已完成，并已保存到 Google Drive。</div>${job.result.driveFile ? `<div><strong>Drive:</strong> <a href="${job.result.driveFile.webViewLink}" target="_blank">${job.result.driveFile.name}</a></div>` : ''}`;
        }
      }
      toast('真实广告视频已生成并保存到 Google Drive', 'ok');
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
    toast('轮询超时：OpenRouter 视频任务可能仍在生成，请稍后刷新页面或查看 Render 日志。', 'warn');
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
        ratio: currentRatio(),
        resolution: currentResolution(),
        videoModel: currentVideoModel()
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
    configureOpenRouterSelectors();
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
      else toast('后端配置已就绪：Shopify / OpenRouter / Google Drive', 'ok');
    }).catch((err) => toast(`后端状态检查失败：${err.message}`, 'error'));
  }

  window.RealVideoAgent = { startRealVideoGeneration, searchShopify, saveMetadataToDrive, state: stateBag };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
