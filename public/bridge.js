(function () {
  const root = document.documentElement;
  const stateBag = {
    product: null,
    lastJob: null,
    lastVideoUrl: null,
    lastDriveFile: null,
    lastImage: null,
    videoJobs: [],
    videoResults: [],
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
    return ['16:9', '9:16', '1:1', '4:5'].includes(raw) ? raw : '16:9';
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
    return ['720p', '1080p', '2k', '4k'].includes(raw) ? (raw === '2k' ? '2K' : raw === '4k' ? '4K' : raw) : '720p';
  }

  function currentVideoModel() {
    const select = $('#video-model-select-real');
    if (select && select.value) return select.value;
    return stateBag.modelConfig && stateBag.modelConfig.videoModels && stateBag.modelConfig.videoModels[0] && stateBag.modelConfig.videoModels[0].id;
  }


  function readImagePrompt() {
    return ($('#image-ai-prompt') && $('#image-ai-prompt').value.trim()) ||
      ($('#md-inline-text') && $('#md-inline-text').value.trim()) ||
      '生成一张适合电商广告使用的高质量商品场景图，突出材质、空间氛围和购买欲。';
  }

  function currentImageModel() {
    const select = $('#image-model-select-real');
    if (select && select.value) return select.value;
    return stateBag.modelConfig && stateBag.modelConfig.imageModels && stateBag.modelConfig.imageModels[0] && stateBag.modelConfig.imageModels[0].id;
  }

  function currentImageRatio() {
    const select = $('#image-ratio-select-real') || ($('#panel-image') && $('#panel-image').querySelector('select:nth-of-type(2)'));
    const raw = select ? select.value : '1:1';
    return ['1:1', '16:9', '9:16', '4:5', '5:4', '3:2', '2:3'].includes(raw) ? raw : '1:1';
  }

  function currentImageResolution() {
    const select = $('#image-resolution-select-real');
    if (select && select.value) return select.value;
    const panel = $('#panel-image');
    const maybe = panel ? $all('select', panel).find((s) => /1024|1080|2048|0\.5K|1K/i.test(s.value || s.textContent || '')) : null;
    return maybe ? maybe.value : '1024x1024';
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

      const panelImage = $('#panel-image');
      if (panelImage && !$('#image-model-select-real')) {
        const firstRow = panelImage.querySelector('.form-row.two');
        if (firstRow) {
          const wrap = document.createElement('div');
          wrap.innerHTML = `<label for="image-model-select-real">OpenRouter 图片模型</label><select id="image-model-select-real"></select><div class="form-hint">统一通过 OpenRouter 图片输出模型生成广告素材图。</div>`;
          firstRow.appendChild(wrap);
        }
      }
      replaceSelectOptions($('#image-model-select-real'), (data.imageModels || []).map((m) => ({ value: m.id, label: m.label })), data.imageModels && data.imageModels[0] && data.imageModels[0].id);

      // Give the original image controls stable IDs where possible.
      if (panelImage) {
        const selects = $all('select', panelImage);
        const ratioSel = selects.find((s) => ['1:1', '4:5', '16:9', '9:16'].includes(s.value));
        if (ratioSel && !ratioSel.id) ratioSel.id = 'image-ratio-select-real';
        const resSel = selects.find((s) => /1024|1080|2048|0\.5K|1K/i.test(s.value || s.textContent || ''));
        if (resSel && !resSel.id) resSel.id = 'image-resolution-select-real';
      }

      toast('OpenRouter 模型配置已加载：文本 / 图片 / 视频统一走 OpenRouter', 'ok');
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


  function productReferenceImages(product) {
    if (!product) return [];
    const urls = [];
    if (product.imageUrl) urls.push(product.imageUrl);
    if (Array.isArray(product.images)) {
      product.images.forEach((image) => {
        if (!image) return;
        if (typeof image === 'string') urls.push(image);
        else if (image.url) urls.push(image.url);
        else if (image.src) urls.push(image.src);
      });
    }
    return Array.from(new Set(urls.filter((url) => /^https:\/\//i.test(String(url || ''))))).slice(0, 3);
  }

  function ensureResultsScreen() {
    if (typeof window.showScreen === 'function') window.showScreen('04');
    else {
      const btn = document.querySelector('.nav-item[data-screen="04"]');
      if (btn) btn.click();
    }
  }


  function currentStyleChoice() {
    const style = $('#style-library-select') ? $('#style-library-select').value : '当前风格';
    const preset = $('#preset-style-select') ? $('#preset-style-select').value : '当前预设';
    return `${style} · ${preset}`;
  }

  function productTitleForDisplay() {
    if (stateBag.product && stateBag.product.title) return stateBag.product.title;
    const top = $('#topbar-product');
    if (!top) return '';
    return top.textContent.replace(/^SKU[:：]\s*[^-]+-\s*/i, '').trim();
  }

  function updateLabelValue(card, labelText, value) {
    if (!card || value === undefined || value === null) return;
    const nodes = Array.from(card.querySelectorAll('span, div, td'));
    const label = nodes.find((el) => (el.textContent || '').trim() === labelText);
    if (label && label.nextElementSibling) label.nextElementSibling.textContent = value;
  }

  function syncCandidateCardsWithCurrentChoices() {
    const duration = `${currentDuration()} 秒`;
    const ratio = currentRatio();
    const style = currentStyleChoice();
    const productTitle = productTitleForDisplay();
    const resolution = currentResolution();

    document.querySelectorAll('.video-result-card').forEach((card, index) => {
      updateLabelValue(card, '视频时长', duration);
      updateLabelValue(card, '主比例', ratio);
      updateLabelValue(card, '风格', style);
      if (productTitle) updateLabelValue(card, '主封面', index === 0 ? `${productTitle} · 主视觉` : `${productTitle} · 备选构图`);
      const code = card.querySelector('.vr-code');
      if (code && !code.dataset.realSynced) {
        code.dataset.realSynced = '1';
      }
      const summary = card.querySelector('.summary-list');
      if (summary && index === 0) {
        summary.innerHTML = `<div><strong>AI 生成说明:</strong> 将按当前选择生成 ${duration}、${ratio}、${resolution} 的广告视频；风格为 ${style}。</div>`;
      }
    });

    const top = $('#topbar-product');
    if (top && stateBag.product) top.textContent = `SKU: ${stateBag.product.sku || ''} - ${stateBag.product.title || ''}`;
  }

  function candidateCard(index) {
    return document.querySelectorAll('.video-result-card')[index] || null;
  }

  function variantLabel(index) {
    return ['主候选视频', '备选视频 2', '备选视频 3'][index] || `候选视频 ${index + 1}`;
  }

  function variantStrategy(index) {
    const productTitle = productTitleForDisplay() || '当前商品';
    const base = readVideoPrompt();
    const strategies = [
      `【候选A：产品主展示广告】以 Shopify 商品图片里的 ${productTitle} 为绝对主体，保持外观、颜色、材质和比例一致。镜头语言：先商品全貌，再细节特写，再回到完整场景。不要生成其它商品。`,
      `【候选B：生活方式/场景广告】以 Shopify 商品图片里的 ${productTitle} 为绝对主体，放入真实家居/使用场景中，强调空间氛围和使用价值。必须保持商品外观一致，不要替换成其它家具/灯具/纹理。`,
      `【候选C：社媒快节奏广告】以 Shopify 商品图片里的 ${productTitle} 为绝对主体，适合 Reels/TikTok/Pinterest 的广告节奏：开头抓眼、细节切换、结尾停留商品。必须保持商品外观一致，不要生成随机产品。`
    ];
    return `${strategies[index] || strategies[0]}\n\n【共同需求】${base}`;
  }

  function setCardMeta(index, statusText, tagClass = 'tag-info') {
    const card = candidateCard(index);
    if (!card) return;
    const title = card.querySelector('.vr-title strong');
    if (title) title.textContent = variantLabel(index);
    const code = card.querySelector('.vr-code');
    if (code) code.textContent = `${stateBag.product && stateBag.product.sku ? stateBag.product.sku : readSku() || 'SKU'} · ${currentRatio()} · ${currentDuration()} 秒`;
    const tag = card.querySelector('.vr-title .tag');
    if (tag) {
      tag.className = `tag ${tagClass}`;
      tag.textContent = statusText;
    }
    updateLabelValue(card, '视频时长', `${currentDuration()} 秒`);
    updateLabelValue(card, '主比例', currentRatio());
    updateLabelValue(card, '风格', `${currentStyleChoice()} · ${index === 0 ? '产品主展示' : index === 1 ? '生活方式场景' : '社媒快节奏'}`);
    updateLabelValue(card, '主封面', `${productTitleForDisplay() || '当前商品'} · ${index === 0 ? '主视觉' : index === 1 ? '场景构图' : '快切构图'}`);
  }

  function setCandidateLoading(jobs) {
    ensureResultsScreen();
    const jobList = Array.isArray(jobs) ? jobs : [jobs];
    const banner = $('#generation-banner');
    if (banner) {
      banner.innerHTML = `<div class="banner processing"><div><div class="banner-title">3 个真实候选视频生成中</div><div class="banner-body">已提交 ${jobList.length} 个 OpenRouter 任务。本次按你在前一步选择的 ${currentDuration()} 秒、${currentRatio()}、${currentResolution()} 生成；每个候选都会使用 Shopify 商品图作为参考图。</div></div><div class="progress-bar"><span id="real-job-progress" style="width:5%;"></span></div></div>`;
    }
    syncCandidateCardsWithCurrentChoices();
    for (let i = 0; i < 3; i += 1) {
      const card = candidateCard(i);
      if (!card) continue;
      setCardMeta(i, i < jobList.length ? '真实生成中' : '等待提交', i < jobList.length ? 'tag-warning' : 'tag-neutral');
      const preview = $('.vr-preview', card);
      if (preview) preview.innerHTML = `<div style="color:#fff;text-align:center;padding:18px;">${variantLabel(i)} 真实生成中...<br><small>OpenRouter 完成后这里会出现视频预览</small></div>`;
      const summary = card.querySelector('.summary-list');
      if (summary) summary.innerHTML = `<div><strong>AI 生成说明:</strong> ${variantStrategy(i).slice(0, 180)}...</div>`;
    }
  }

  function updateOverallBanner() {
    const jobs = stateBag.videoJobs || [];
    if (!jobs.length) return;
    const completed = jobs.filter((j) => j && j.status === 'completed').length;
    const failed = jobs.filter((j) => j && j.status === 'failed').length;
    const progress = Math.round(jobs.reduce((sum, j) => sum + (Number(j && j.progress) || 0), 0) / jobs.length);
    const banner = $('#generation-banner');
    if (!banner) return;
    const allDone = completed + failed === jobs.length;
    const title = allDone ? `真实候选视频完成：${completed} 个成功，${failed} 个失败` : `3 个真实候选视频生成中`;
    const driveErrors = jobs.filter((j) => j && j.result && j.result.driveError).length;
    const body = allDone
      ? `已生成 ${completed} 个可预览/下载的视频。${driveErrors ? `其中 ${driveErrors} 个 Drive 保存失败，但不影响本地预览。` : '已尝试保存到 Drive。'}`
      : `整体进度：${progress}% · 已完成 ${completed}/${jobs.length} · 失败 ${failed}/${jobs.length}`;
    const links = allDone ? jobs.map((j, i) => j && j.result && j.result.videoUrl ? `<a class="btn btn-primary btn-sm" target="_blank" href="${j.result.videoUrl}">打开${variantLabel(i)}</a>` : '').join('') : `<div class="progress-bar"><span id="real-job-progress" style="width:${progress}%;"></span></div>`;
    banner.innerHTML = `<div class="banner ${allDone ? 'info' : 'processing'}"><div><div class="banner-title">${title}</div><div class="banner-body">${body}</div></div><div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">${links}</div></div>`;
  }

  function updateCandidateWithJob(job, index = 0) {
    syncCandidateCardsWithCurrentChoices();
    stateBag.videoJobs[index] = job;
    const card = candidateCard(index);
    const statusText = job.status === 'completed' ? (job.result && job.result.driveFile ? 'Drive 已保存' : '视频已生成') : job.status === 'failed' ? '生成失败' : `生成中 ${job.progress || 0}%`;
    const statusClass = job.status === 'completed' ? (job.result && job.result.driveFile ? 'tag-success' : 'tag-warning') : job.status === 'failed' ? 'tag-error' : 'tag-warning';
    setCardMeta(index, statusText, statusClass);
    if (card) {
      const preview = $('.vr-preview', card);
      if (job.status === 'completed' && job.result && job.result.videoUrl) {
        if (preview) preview.innerHTML = `<video controls playsinline src="${job.result.videoUrl}" style="width:100%;height:100%;object-fit:cover;background:#111;"></video>`;
      } else if (job.status === 'failed') {
        if (preview) preview.innerHTML = `<div style="color:#fff;text-align:center;padding:18px;">${variantLabel(index)} 生成失败<br><small>${job.error || '未知错误'}</small></div>`;
      } else {
        if (preview) preview.innerHTML = `<div style="color:#fff;text-align:center;padding:18px;">${variantLabel(index)} 真实生成中...<br><small>状态：${job.status} · ${job.progress || 0}%</small></div>`;
      }
      const info = $('.summary-list', card);
      if (info) {
        if (job.status === 'completed' && job.result) {
          info.innerHTML = `<div><strong>真实生成结果:</strong> ${variantLabel(index)} 已完成，可以在上方预览。</div>${job.result.driveFile ? `<div><strong>Drive:</strong> <a href="${job.result.driveFile.webViewLink}" target="_blank">${job.result.driveFile.name}</a></div>` : ''}${job.result.driveError ? `<div><strong>Drive 保存失败:</strong> ${job.result.driveError}</div>` : ''}`;
        } else if (job.status === 'failed') {
          info.innerHTML = `<div><strong>生成失败:</strong> ${job.error || '未知错误'}</div>`;
        } else {
          info.innerHTML = `<div><strong>AI 生成说明:</strong> ${variantLabel(index)} 正在根据 Shopify 商品图、当前素材和需求文档生成真实广告视频。</div>`;
        }
      }
    }
    if (job.status === 'completed' && job.result) {
      stateBag.videoResults[index] = job.result;
      if (index === 0) {
        stateBag.lastVideoUrl = job.result.videoUrl;
        stateBag.lastDriveFile = job.result.driveFile;
        stateBag.lastJob = job;
      }
      toast(job.result.driveFile ? `${variantLabel(index)} 已生成并保存到 Drive` : `${variantLabel(index)} 已生成；Drive 保存失败但可预览/下载`, job.result.driveFile ? 'ok' : 'warn');
    }
    if (job.status === 'failed') toast(`${variantLabel(index)} 生成失败：${job.error}`, 'error');
    updateOverallBanner();
  }

  async function pollJob(jobId, index = 0) {
    for (let i = 0; i < 140; i += 1) {
      const data = await apiFetch(`/api/jobs/${jobId}`);
      const job = data.job;
      updateCandidateWithJob(job, index);
      if (['completed', 'failed'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    toast(`${variantLabel(index)} 轮询超时：OpenRouter 视频任务可能仍在生成，请稍后刷新页面或查看 Render 日志。`, 'warn');
  }

  function updateGeneratedImageUI(image) {
    stateBag.lastImage = image;
    const list = $('#generated-image-results');
    if (list) {
      const item = document.createElement('div');
      item.className = 'generated-result-item';
      item.innerHTML = `<img src="${image.imageUrl}" alt="AI 生成图片" style="width:100%;border-radius:10px;display:block;object-fit:cover;max-height:260px;background:#eee;">
        <div style="margin-top:10px;"><strong>OpenRouter 生成图片</strong><div class="generated-result-meta"><span>${image.model || currentImageModel() || 'OpenRouter Image'}</span><span>${image.mimeType || 'image/png'}</span><span>刚刚</span><span>${image.driveFile ? '已保存到 Drive' : image.driveError ? 'Drive 保存失败' : '已生成'}</span></div></div>
        <div class="generated-result-actions"><a class="btn btn-outline btn-sm" href="${image.imageUrl}" target="_blank">打开图片</a>${image.driveFile ? `<a class="btn btn-outline btn-sm" href="${image.driveFile.webViewLink}" target="_blank">打开 Drive</a>` : ''}</div>`;
      list.prepend(item);
    }
    toast(image.driveFile ? '图片已生成并保存到 Google Drive' : image.driveError ? `图片已生成；Drive 保存失败：${image.driveError}` : '图片已生成', image.driveFile ? 'ok' : image.driveError ? 'warn' : 'ok');
  }

  async function startRealImageGeneration() {
    try {
      const sku = readSku();
      let product = stateBag.product;
      if (!product && sku) {
        try { product = await searchShopify(sku); } catch (err) { toast(`Shopify 查询失败，将尝试纯文本生成图片：${err.message}`, 'warn'); }
      }
      const payload = {
        sku,
        product,
        prompt: readImagePrompt(),
        ratio: currentImageRatio(),
        resolution: currentImageResolution(),
        imageModel: currentImageModel()
      };
      toast('正在通过 OpenRouter 生成图片素材...');
      const data = await postJson('/api/agent/create-image', payload);
      updateGeneratedImageUI(data.image);
    } catch (err) {
      toast(`图片生成失败：${err.message}`, 'error');
    }
  }

  async function startRealVideoGeneration() {
    try {
      const sku = readSku();
      let product = stateBag.product;
      if (!product && sku) {
        try { product = await searchShopify(sku); } catch (err) { toast(`Shopify 查询失败，将尝试纯文本生成：${err.message}`, 'warn'); }
      }
      const refs = productReferenceImages(product);
      if (!product || !refs.length) {
        toast('请先在第 1 步选择 Shopify 商品，并确认该商品有可访问的商品图。否则视频模型无法锁定具体商品。', 'error');
        return;
      }
      syncCandidateCardsWithCurrentChoices();
      toast(`正在提交 3 个真实候选视频：${currentDuration()} 秒 · ${currentRatio()} · ${currentResolution()}`);

      const basePayload = {
        sku,
        product,
        imageUrl: product && product.imageUrl,
        referenceImages: refs,
        duration: currentDuration(),
        ratio: currentRatio(),
        resolution: currentResolution(),
        videoModel: currentVideoModel()
      };

      const submissions = [];
      for (let i = 0; i < 3; i += 1) {
        const payload = { ...basePayload, prompt: variantStrategy(i), variantIndex: i + 1, variantLabel: variantLabel(i) };
        submissions.push(postJson('/api/agent/create-video', payload).then((data) => ({ index: i, job: data.job })).catch((error) => ({ index: i, error })));
      }

      const submitted = await Promise.all(submissions);
      const jobs = submitted.map((item) => item.job).filter(Boolean);
      stateBag.videoJobs = [];
      stateBag.videoResults = [];
      if (!jobs.length) {
        const firstError = submitted.find((x) => x.error);
        throw firstError ? firstError.error : new Error('没有视频任务成功提交');
      }
      setCandidateLoading(jobs);
      submitted.forEach((item) => {
        if (item.error) {
          updateCandidateWithJob({ status: 'failed', progress: 100, error: item.error.message }, item.index);
        } else {
          stateBag.videoJobs[item.index] = item.job;
          updateCandidateWithJob(item.job, item.index);
          pollJob(item.job.id, item.index).catch((err) => toast(`${variantLabel(item.index)} 轮询失败：${err.message}`, 'error'));
        }
      });
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

      if (text.includes('开始生成图片')) {
        event.preventDefault();
        event.stopPropagation();
        startRealImageGeneration();
        return;
      }

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

  window.RealVideoAgent = { startRealVideoGeneration, startRealImageGeneration, searchShopify, saveMetadataToDrive, state: stateBag };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
