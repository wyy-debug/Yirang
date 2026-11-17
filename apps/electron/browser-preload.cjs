const { ipcRenderer } = require('electron');

// Private, read-only capture in the isolated preload world. No API is exposed
// to website scripts, and no source code or selectors arrive over this channel.
ipcRenderer.on('yirang:browser-capture', (_event, id) => {
  if (typeof id !== 'string' || id.length > 80) return;
  try {
    if (!document.body || document.readyState === 'loading')
      throw Error('网页正文尚未就绪，请稍后再试');
    const links = [],
      seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const url = new URL(a.href, location.href);
        if (
          !['https:', 'http:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          seen.has(url.href) ||
          url.href.length > 4096
        )
          continue;
        seen.add(url.href);
        links.push({
          url: url.href,
          text: (a.innerText || a.textContent || '').trim().slice(0, 500),
        });
        if (links.length >= 100) break;
      } catch {}
    }
    ipcRenderer.send('yirang:browser-captured', id, {
      url: location.href,
      title: document.title.slice(0, 300),
      text: (document.body.innerText || '').slice(0, 60000),
      links,
      fields: [],
      selection: String(getSelection() || '').slice(0, 6000),
    });
  } catch {
    ipcRenderer.send('yirang:browser-captured', id, null, '网页正文暂时无法读取，请稍后重试');
  }
});
