(function () {
  async function apiFetch(path, options) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Request failed: ${response.status}`);
    }
    return data;
  }

  async function postJson(path, body) {
    return apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  async function uploadToDrive(file, extraFields) {
    const form = new FormData();
    form.append('file', file);
    Object.entries(extraFields || {}).forEach(([key, value]) => form.append(key, value));
    return apiFetch('/api/save-drive', { method: 'POST', body: form });
  }

  window.VideoAdAgentAPI = {
    status: () => apiFetch('/api/config/status'),
    analyzeMd: (payload) => postJson('/api/analyze-md', payload),
    syncShopifyProducts: () => apiFetch('/api/shopify/products?limit=50'),
    generateVideo: (payload) => postJson('/api/generate-video', payload),
    generateImage: (payload) => postJson('/api/generate-image', payload),
    getJob: (id) => apiFetch(`/api/jobs/${id}`),
    saveDriveJson: (filename, data) => postJson('/api/save-drive-json', { filename, data }),
    uploadToDrive
  };

  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const status = await window.VideoAdAgentAPI.status();
      console.log('[VideoAdAgentAPI] config status', status);
    } catch (error) {
      console.warn('[VideoAdAgentAPI] status failed', error);
    }
  });
})();
