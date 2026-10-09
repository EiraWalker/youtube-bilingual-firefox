document.getElementById('open-settings').addEventListener('click', async () => {
  try { await browser.runtime.openOptionsPage(); window.close(); }
  catch { document.getElementById('status').textContent = '无法打开设置，请在 Firefox 扩展管理中打开本扩展选项。'; }
});
