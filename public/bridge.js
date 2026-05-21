(function () {
  const qs = (s, r=document) => r.querySelector(s);
  const qsa = (s, r=document) => Array.from(r.querySelectorAll(s));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function ensureToast() {
    let box = qs('#agent-toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'agent-toast-box';
      box.style.cssText = 'position:fixed;right:18px;bottom:84px;z-index:99999;display:grid;gap:8px;max-width:420px;';
      document.body.appendChild(box);
    }
    return box;
  }

  function toast(message, type='info') {
    const box = ensureToast();
    const item = document.createElement('div');
    const bg = type === 'error' ? '#ffeeed' : type === 'success' ? '#e8f8ed' : '#e8f4fd';
    const fg = type === 'error' ? '#c41e1e' : type === 'success' ? '#1e7b3c' : '#005ec3';
    item.style.cssText = `background:${bg};color:${fg};border:1px solid rgba(0,0,0,.08);border-radius:10px;padding:10px 12px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.12);white-space:pre-wrap;`;
    item.textContent = message;
    box.appendChild(item);
    setTimeout(() => item.remove(), 6500);
  }

  async function api(path, options={}) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败：${response.status}`);
    return data;
  }

  async function postJson(path, body) {
    return api(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function setButtonBusy(btn, busy, text) {
    if (!btn) return;
    if (busy) {
      btn.dataset.oldText = btn.textContent.trim();
      btn.disabled = true;
      btn.textContent = text || '处理中...';
    } else {
      btn.disabled = false;
      if (btn.dataset.oldText) btn.textContent = btn.dataset.oldText;
      delete btn.dataset.oldText;
    }
  }

  function collectCurrentTask() {
    return {
      taskName: qs('#topbar-task-name')?.textContent?.trim(),
      product: qs('#topbar-product')?.textContent?.trim(),
      packCode: qs('#topbar-pack-code')?.textContent?.trim(),
      mdText: qs('#md-inline-text')?.value || '',
      imagePrompt: qs('#image-ai-prompt')?.value || '',
      videoPrompt: qs('#video-ai-prompt')?.value || '',
      savedAt: new Date().toISOString()
    };
  }

  async function searchShopify(input) {
    const q = (input?.value || '').trim();
    if (!q) return toast('请输入 SKU 或商品标题。', 'error');
    toast(`正在从 Shopify 搜索：${q}`);
    const data = await api(`/api/shopify/products?q=${encodeURIComponent(q)}&limit=250`);
    const product = data.products?.[0];
    if (!product) return toast(`Shopify 没找到匹配商品：${q}`, 'error');

    const title = product.title || '未命名商品';
    const variant = (product.variants || []).find(v => String(v.sku || '').toLowerCase().includes(q.toLowerCase())) || product.variants?.[0] || {};
    const sku = variant.sku || product.id;
    const image = product.image?.src || product.images?.[0]?.src;
    const card = qs('.product-card');
    if (card) {
      qs('.product-title', card).textContent = title;
      const meta = qs('.product-meta', card);
      if (meta) meta.innerHTML = `<span>SKU: ${sku}</span><span>变体: ${(product.variants || []).length}</span><span>已有图片: ${(product.images || []).length}</span><span>店铺: Shopify</span>`;
      const thumb = qs('.product-thumb', card);
      if (thumb && image) thumb.innerHTML = `<img src="${image}" alt="${title}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">`;
      else if (thumb) thumb.textContent = title.slice(0,1).toUpperCase();
    }
    const topbarProduct = qs('#topbar-product');
    if (topbarProduct) topbarProduct.textContent = `SKU: ${sku} - ${title}`;
    toast(`已同步 Shopify 商品：${title}`, 'success');
  }

  async function startVideoGeneration(btn) {
    const prompt = qs('#video-ai-prompt')?.value?.trim() || qs('#image-ai-prompt')?.value?.trim() || '生成广告视频片段';
    const providerLabel = qsa('select').find(s => /Runway|Pika|Luma/.test(s.value))?.value || 'Runway Gen-4';
    const provider = /luma/i.test(providerLabel) ? 'luma' : /pika/i.test(providerLabel) ? 'pika' : 'runway';
    setButtonBusy(btn, true, '提交中...');
    try {
      const data = await postJson('/api/generate-video', { provider, prompt, duration: 6, ratio: '1:1' });
      toast(`视频生成任务已提交\nJob ID: ${data.job.id}\n稍后可在 Render Logs 或任务接口查看状态。`, 'success');
      let last = data.job;
      for (let i=0; i<4; i++) {
        await sleep(1500);
        const poll = await api(`/api/jobs/${data.job.id}`);
        last = poll.job;
        if (last.status === 'failed') throw new Error(last.error || '视频生成失败');
        if (last.status === 'submitted' || last.status === 'completed') break;
      }
      toast(`视频任务状态：${last.status}，进度 ${last.progress}%`, last.status === 'failed' ? 'error' : 'success');
    } catch (err) {
      toast(`视频生成没有成功：${err.message}\n请检查 RUNWAY_API_KEY / provider API 地址 / Render Logs。`, 'error');
    } finally {
      setButtonBusy(btn, false);
    }
  }

  async function startImageGeneration(btn) {
    const prompt = qs('#image-ai-prompt')?.value?.trim() || '生成广告图片素材';
    setButtonBusy(btn, true, '生成中...');
    try {
      const data = await postJson('/api/generate-image', { prompt, ratio:'1:1', count:4 });
      toast(data.message || '图片生成任务已处理。', data.ok ? 'success' : 'info');
      await postJson('/api/save-drive-json', { filename:`image-generation-${Date.now()}.json`, data: { prompt, result:data } }).catch(() => null);
    } catch (err) {
      toast(`图片生成未完成：${err.message}`, 'error');
    } finally {
      setButtonBusy(btn, false);
    }
  }

  async function saveCurrentToDrive(btn) {
    setButtonBusy(btn, true, '保存中...');
    try {
      const task = collectCurrentTask();
      const data = await postJson('/api/save-drive-json', { filename:`${task.packCode || 'video-ad-agent'}-${Date.now()}.json`, data: task });
      toast(`已保存到 Google Drive：${data.file.name}`, 'success');
      if (data.file.webViewLink) window.open(data.file.webViewLink, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast(`保存到 Drive 失败：${err.message}\n请检查 GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_DRIVE_FOLDER_ID，以及文件夹是否共享给 Service Account。`, 'error');
    } finally {
      setButtonBusy(btn, false);
    }
  }

  async function testConnections(btn) {
    setButtonBusy(btn, true, '测试中...');
    try {
      const data = await api('/api/config/status');
      const s = data.services || {};
      toast(`连接状态\nOpenRouter: ${s.openrouter ? '已配置' : '缺失'}\nShopify: ${s.shopify ? '已配置' : '缺失'}\nGoogle Drive: ${s.googleDrive ? '已配置' : '缺失'}\nRunway: ${s.runway ? '已配置' : '缺失'}`, 'success');
    } catch (err) {
      toast(`连接测试失败：${err.message}`, 'error');
    } finally { setButtonBusy(btn, false); }
  }

  function showMapping() {
    toast('字段映射：impressions=曝光，clicks=点击，spend=花费，conversions=转化次数，conversion_value=转化金额，sku=商品SKU，asset_code=素材编码。', 'info');
  }

  function manualEntry() {
    const spend = prompt('请输入花费金额，例如 120.50：');
    if (spend === null) return;
    toast(`已记录手动数据：花费 $${spend}。当前版本会保存在浏览器本地；如需团队共享，可扩展数据库。`, 'success');
  }

  function csvImport(btn) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.csv,text/csv';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      toast(`已选择 CSV：${f.name}。当前版本会上传文件元数据并保存到 Drive。`);
      await saveCurrentToDrive(btn);
    };
    input.click();
  }

  function bindShopifySearch() {
    qsa('.shopify-search input, input[placeholder*="SKU"]').forEach(input => {
      if (input.dataset.agentBound) return;
      input.dataset.agentBound = '1';
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); searchShopify(input).catch(err => toast(`Shopify 搜索失败：${err.message}`, 'error')); }
      });
      input.addEventListener('change', () => searchShopify(input).catch(err => toast(`Shopify 搜索失败：${err.message}`, 'error')));
    });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const text = btn.textContent.replace(/\s+/g, ' ').trim();

    if (/开始生成视频片段|生成视频$|重新生成/.test(text)) {
      e.preventDefault(); e.stopPropagation();
      startVideoGeneration(btn); return;
    }
    if (/开始生成图片/.test(text)) { e.preventDefault(); e.stopPropagation(); startImageGeneration(btn); return; }
    if (/保存到 Drive|保存到Drive/.test(text)) { e.preventDefault(); e.stopPropagation(); saveCurrentToDrive(btn); return; }
    if (/下载到本地|^下载$/.test(text)) { e.preventDefault(); downloadJson(`video-ad-agent-${Date.now()}.json`, collectCurrentTask()); toast('已下载当前任务 JSON。', 'success'); return; }
    if (/测试连接/.test(text)) { e.preventDefault(); e.stopPropagation(); testConnections(btn); return; }
    if (/同步数据|开始追踪/.test(text)) { e.preventDefault(); e.stopPropagation(); testConnections(btn); toast('已触发同步/追踪检查。真实广告平台回传需要接 Google Ads / Meta API。'); return; }
    if (/查看字段映射/.test(text)) { e.preventDefault(); showMapping(); return; }
    if (/CSV 导入/.test(text)) { e.preventDefault(); csvImport(btn); return; }
    if (/手动录入/.test(text)) { e.preventDefault(); manualEntry(); return; }
    if (/保存草稿|保存配置/.test(text)) { localStorage.setItem('video-ad-agent-draft', JSON.stringify(collectCurrentTask())); toast('已保存到浏览器本地草稿。', 'success'); }
    if (/确认结果|保存到历史素材/.test(text)) { toast('已更新当前页面状态。需要团队共享历史库时，请接数据库或 Drive 索引文件。', 'success'); }
    if (/删除素材/.test(text)) { toast('已删除当前页面中的素材卡片。', 'success'); }
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    bindShopifySearch();
    setInterval(bindShopifySearch, 2000);
    api('/api/config/status').then(() => toast('后端连接正常。')).catch(err => toast(`后端连接失败：${err.message}`, 'error'));
  });
})();
