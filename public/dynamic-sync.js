(function () {
  const staticReplacements = [
    [/Arhaus 风扶手椅 - 深灰羊毛面料/g, '请先搜索 Shopify SKU'],
    [/Arhaus 风扶手椅/g, '当前 Shopify 商品'],
    [/Arhaus 风格/g, '品牌风格'],
    [/Arhaus/g, '品牌'],
    [/Povison/g, '竞品风格'],
    [/FL-3012-A/g, '待选择SKU'],
    [/arhaus-home\.myshopify\.com/g, '当前店铺'],
    [/2026 春季客厅单品视频投放/g, '视频广告生成任务'],
    [/羊毛面料/g, '商品材质'],
    [/客厅/g, '商品场景']
  ];

  let syncing = false;
  let observerStarted = false;
  let lastProductKey = '';

  function $(selector, base = document) { return base.querySelector(selector); }
  function $all(selector, base = document) { return Array.from(base.querySelectorAll(selector)); }

  function productFromRuntime() {
    return window.RealVideoAgent && window.RealVideoAgent.state && window.RealVideoAgent.state.product;
  }

  function productFromDom() {
    const top = $('#topbar-product');
    const text = top ? top.textContent : '';
    const m = text.match(/SKU[:：]\s*([^\s-]+)\s*-\s*(.+)$/i);
    const sku = m ? m[1] : (($('.shopify-search input') && $('.shopify-search input').value.trim()) || '');
    const title = m ? m[2].trim() : (($('.product-title') && $('.product-title').textContent.trim()) || '');
    if (!sku && !title) return null;
    return { sku, title, shop: '当前店铺' };
  }

  function currentProduct() {
    return productFromRuntime() || productFromDom() || null;
  }

  function getDurationLabel() {
    const select = $('#video-duration');
    if (!select) return '30 秒';
    if (select.value === '自定义') {
      const custom = $('#custom-duration-input');
      return `${custom && custom.value ? custom.value : 30} 秒`;
    }
    return select.value || '30 秒';
  }

  function getRatio() { return ($('#video-ratio') && $('#video-ratio').value) || '16:9'; }
  function getResolution() { return ($('#video-resolution') && $('#video-resolution').value) || '1080p'; }
  function getStyle() {
    const style = ($('#style-library-select') && $('#style-library-select').value) || '品牌风格';
    const preset = ($('#preset-style-select') && $('#preset-style-select').value) || '广告主视觉';
    return `${style} · ${preset}`;
  }

  function replaceStaticInString(value, product) {
    if (!value || typeof value !== 'string') return value;
    let next = value;
    for (const [pattern, replacement] of staticReplacements) next = next.replace(pattern, replacement);
    if (product) {
      const title = product.title || '当前商品';
      const sku = product.sku || '当前SKU';
      const shop = product.shop || '当前店铺';
      next = next
        .replace(/待选择SKU/g, sku)
        .replace(/请先搜索 Shopify SKU/g, title)
        .replace(/当前 Shopify 商品/g, title)
        .replace(/当前店铺/g, shop)
        .replace(/当前商品/g, title);
    }
    return next;
  }

  function scrubStaticText(product) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !/(Arhaus|Povison|FL-3012-A|arhaus-home|羊毛|客厅单品)/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || ['SCRIPT', 'STYLE'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => { node.nodeValue = replaceStaticInString(node.nodeValue, product); });

    $all('input, textarea').forEach((el) => {
      if (!el.value || !/(Arhaus|Povison|FL-3012-A|arhaus-home|羊毛|客厅单品)/.test(el.value)) return;
      el.value = replaceStaticInString(el.value, product);
    });
  }

  function normalizeSelectOptions() {
    const styleSelect = $('#style-library-select');
    if (styleSelect && !styleSelect.dataset.dynamicNormalized) {
      styleSelect.dataset.dynamicNormalized = '1';
      styleSelect.innerHTML = [
        '<option selected>品牌风格</option>',
        '<option>竞品风格</option>',
        '<option>极简高端风格</option>',
        '<option>UGC 真实测评风格</option>',
        '<option>AI 总结竞品风格</option>',
        '<option>自定义风格</option>'
      ].join('');
    }
    const presetSelect = $('#preset-style-select');
    if (presetSelect && !presetSelect.dataset.dynamicNormalized) {
      presetSelect.dataset.dynamicNormalized = '1';
      presetSelect.innerHTML = [
        '<option selected>产品场景广告</option>',
        '<option>带人物互动场景</option>',
        '<option>空镜展示</option>',
        '<option>产品细节特写</option>',
        '<option>UGC 混剪</option>',
        '<option>自定义预设</option>'
      ].join('');
    }
  }

  function updateProductAreas(product) {
    if (!product) return;
    const title = product.title || '当前商品';
    const sku = product.sku || '当前SKU';
    const shop = product.shop || '当前店铺';
    const imageUrl = product.imageUrl || (product.images && product.images[0] && product.images[0].url);
    const topProduct = $('#topbar-product');
    if (topProduct) topProduct.textContent = `SKU: ${sku} - ${title}`;
    const task = $('#topbar-task-name');
    if (task) task.textContent = `${title} 视频广告生成`;
    const pack = $('#topbar-pack-code');
    if (pack) pack.textContent = `VP-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${sku || 'SKU'}`;

    const card = $('.product-card');
    if (card) {
      const thumb = $('.product-thumb', card);
      if (thumb) thumb.innerHTML = imageUrl ? `<img src="${imageUrl}" alt="${title}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;">` : (title[0] || 'P');
      const titleEl = $('.product-title', card);
      if (titleEl) titleEl.textContent = title;
      const meta = $('.product-meta', card);
      if (meta) meta.innerHTML = `<span>SKU: ${sku}</span><span>变体: ${product.variantTitle || '-'}</span><span>价格: ${product.price || '-'}</span><span>店铺: ${shop}</span>`;
    }

    const shopifyInput = $('.shopify-search input');
    if (shopifyInput && !shopifyInput.matches(':focus')) shopifyInput.value = sku;
  }

  function updateAssetCards(product) {
    if (!product) return;
    const sku = product.sku || 'SKU';
    const title = product.title || '当前商品';
    const images = (product.images && product.images.length ? product.images : (product.imageUrl ? [{ url: product.imageUrl, altText: product.imageAlt || title }] : []));
    const cards = $all('#asset-grid-shopify .asset-option');
    cards.forEach((option, index) => {
      const code = `${sku}-IMG-${String(index + 1).padStart(2, '0')}`;
      const image = images[index % Math.max(images.length, 1)];
      const checkbox = $('.asset-checkbox', option);
      if (checkbox) checkbox.dataset.assetCode = code;
      const thumb = $('.asset-thumb', option);
      if (thumb) {
        thumb.innerHTML = image && image.url
          ? `<img src="${image.url}" alt="${image.altText || title}" style="width:100%;height:100%;object-fit:cover;"><span class="asset-type-badge">图片</span>`
          : `<span>${title}</span><span class="asset-type-badge">图片</span>`;
      }
      const name = $('.asset-title', option);
      if (name) name.textContent = index === 0 ? `${title} 主图` : `${title} 素材 ${index + 1}`;
      const codeEl = $('.asset-code', option);
      if (codeEl) codeEl.textContent = code;
      const meta = $('.asset-meta', option);
      if (meta) meta.innerHTML = `<span class="tag tag-neutral">Shopify</span><span class="tag tag-info">${sku}</span><span class="tag tag-neutral">真实商品素材</span>`;
    });

    const assetSearch = $('.asset-search input');
    if (assetSearch && !assetSearch.matches(':focus')) assetSearch.value = `${sku} ${title}`;
  }

  function setLabelValue(card, label, value) {
    if (!card) return;
    const all = $all('span, div', card);
    const labelNode = all.find((el) => (el.textContent || '').trim() === label);
    if (labelNode && labelNode.nextElementSibling) labelNode.nextElementSibling.textContent = value;
  }

  function updateCandidateCards(product) {
    const title = product && product.title ? product.title : '当前商品';
    const sku = product && product.sku ? product.sku : '当前SKU';
    const duration = getDurationLabel();
    const ratio = getRatio();
    const resolution = getResolution();
    const style = getStyle();
    $all('.video-result-card').forEach((card, index) => {
      const heading = card.querySelector('.vr-title strong');
      if (heading) heading.textContent = index === 0 ? '主候选视频' : `备选视频 ${index + 1}`;
      const code = $('.vr-code', card);
      if (code) code.textContent = `${sku} · ${ratio} · ${duration}`;
      setLabelValue(card, '风格', style);
      setLabelValue(card, '主比例', ratio);
      setLabelValue(card, '视频时长', duration);
      setLabelValue(card, '主封面', `${title} · ${index === 0 ? '主视觉' : '备选构图'}`);
      const summary = $('.summary-list', card);
      if (summary && !summary.querySelector('a')) {
        summary.innerHTML = `<div><strong>AI 生成说明:</strong> 根据 ${title}、当前素材与需求文档，生成 ${duration} ${ratio} ${resolution} 的广告视频。</div>`;
      }
    });
  }

  function updatePrompts(product) {
    if (!product) return;
    const title = product.title || '当前商品';
    const desc = product.description ? product.description.replace(/<[^>]+>/g, '').slice(0, 120) : '';
    const imagePrompt = $('#image-ai-prompt');
    if (imagePrompt && (!imagePrompt.dataset.userEdited || /Arhaus|扶手椅|羊毛|客厅/.test(imagePrompt.value))) {
      imagePrompt.value = `${title} 的高质量电商广告场景图，突出产品外观、材质细节和真实使用场景，画面干净、有品牌质感。${desc ? '商品信息：' + desc : ''}`;
    }
    const videoPrompt = $('#video-ai-prompt');
    if (videoPrompt && (!videoPrompt.dataset.userEdited || /椅背|羊毛|扶手|Arhaus/.test(videoPrompt.value))) {
      videoPrompt.value = `${title} 的 ${getDurationLabel()} 广告视频：开场展示商品整体和使用场景，中段突出材质/功能/卖点，结尾保留清晰 CTA 和商品记忆点。${desc ? '商品信息：' + desc : ''}`;
    }
  }

  function updateSummaryPanel(product) {
    const title = product && product.title ? product.title : '当前商品';
    const sku = product && product.sku ? product.sku : '当前SKU';
    const panel = $('#right-panel-content');
    if (!panel) return;
    panel.innerHTML = `<div class="rp-section">
      <div class="rp-row"><span class="rp-label">任务名称</span><span class="rp-value">${title} 视频广告生成</span></div>
      <div class="rp-row"><span class="rp-label">Shopify 商品</span><span class="rp-value mono">${sku}</span></div>
      <div class="rp-row"><span class="rp-label">已选风格</span><span class="rp-value">${getStyle()}</span></div>
      <div class="rp-row"><span class="rp-label">视频参数</span><span class="rp-value">${getDurationLabel()} · ${getRatio()} · ${getResolution()}</span></div>
    </div>
    <div class="rp-section">
      <div class="rp-row"><span class="rp-label">生成模型</span><span class="rp-value">OpenRouter</span></div>
      <div class="rp-row"><span class="rp-label">商品来源</span><span class="rp-value">Shopify 实时查询</span></div>
      <div class="rp-row"><span class="rp-label">输出</span><span class="rp-value">视频预览 + Drive 保存</span></div>
    </div>`;
  }

  function markUserEdited() {
    ['#image-ai-prompt', '#video-ai-prompt', '#md-inline-text'].forEach((selector) => {
      const el = $(selector);
      if (el && !el.dataset.dynamicEditBound) {
        el.dataset.dynamicEditBound = '1';
        el.addEventListener('input', () => { el.dataset.userEdited = '1'; });
      }
    });
  }

  function syncAll() {
    if (syncing) return;
    syncing = true;
    try {
      normalizeSelectOptions();
      markUserEdited();
      const product = currentProduct();
      scrubStaticText(product);
      if (product) {
        updateProductAreas(product);
        updateAssetCards(product);
        updatePrompts(product);
        updateSummaryPanel(product);
      }
      updateCandidateCards(product);
      const key = product ? `${product.sku}|${product.title}` : '';
      if (key !== lastProductKey) lastProductKey = key;
    } finally {
      syncing = false;
    }
  }

  function scheduleSync() {
    clearTimeout(scheduleSync.timer);
    scheduleSync.timer = setTimeout(syncAll, 60);
  }

  function startObserver() {
    if (observerStarted || !document.body) return;
    observerStarted = true;
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('change', scheduleSync, true);
    document.addEventListener('click', scheduleSync, true);
    document.addEventListener('input', scheduleSync, true);
    syncAll();
    setTimeout(syncAll, 500);
    setTimeout(syncAll, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver);
  else startObserver();
  window.DynamicAgentSync = { syncAll };
})();
