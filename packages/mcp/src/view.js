// The MCP Apps view of render_document (ui://claimseed/preview): a page a host that supports MCP Apps (ChatGPT,
// Claude, VS Code and others) shows in the conversation in place of the raw result. It draws the page images and the
// injected errors from the tool result the host hands it. It loads nothing, sends nothing but the MCP Apps messages
// to its host, and puts every value on the page as text (never as markup). Hosts without MCP Apps show the same
// result's text and images themselves.
export const VIEW_URI = 'ui://claimseed/preview';
export const VIEW_MIME = 'text/html;profile=mcp-app';

const SCRIPT = String.raw`
(() => {
  const PROTOCOL = '2026-01-26';
  const root = document.getElementById('app');
  let nextId = 1; const pending = new Map();
  const post = (m) => window.parent.postMessage({ jsonrpc: '2.0', ...m }, '*');
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); post({ id, method, params }); });
  const notify = (method, params) => post({ method, params });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; };

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme === 'dark' || ctx.theme === 'light') document.documentElement.dataset.theme = ctx.theme;
    const vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === 'object') for (const [k, v] of Object.entries(vars)) if (HOST_VARS.includes(k) && safeValue(v)) document.documentElement.style.setProperty(k, v);
  }
  // Only the host variables the style sheet reads, and only colours and font names: no url(), image() or any other
  // function that could make the page load something (the page's CSP refuses such loads as well).
  const HOST_VARS = ['--color-background-primary', '--color-text-primary', '--color-text-secondary', '--color-border-primary', '--font-sans'];
  function safeValue(v) {
    if (typeof v !== 'string' || v.length > 200 || !/^[A-Za-z0-9 #%.,'"()+_-]*$/.test(v)) return false;
    for (const m of v.matchAll(/([A-Za-z-]*)\s*\(/g)) if (!/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/i.test(m[1])) return false;
    return true;
  }
  function money(v) { return typeof v === 'number' ? '$' + v.toFixed(2) : v; }
  function show(result) {
    root.replaceChildren();
    if (!result || typeof result !== 'object') return;
    const sc = result.structuredContent || {};
    const head = el('header');
    head.append(el('div', 'tag', 'SYNTHETIC SPECIMEN'));
    head.append(el('h1', null, [sc.type, sc.scenario, sc.seed && 'seed ' + sc.seed].filter(Boolean).join(' / ') || 'claimseed document'));
    const facts = [];
    if (sc.pages) facts.push(sc.pages + (sc.pages === 1 ? ' page' : ' pages'));
    if (sc.sha256) facts.push('SHA-256 ' + String(sc.sha256).slice(0, 12) + '…');
    if (sc.pdf) facts.push('saved as ' + sc.pdf);
    if (facts.length) head.append(el('p', 'facts', facts.join(' · ')));
    root.append(head);
    if (result.isError) { const t = (result.content || []).find((c) => c && c.type === 'text'); root.append(el('p', 'error', t ? t.text : 'The render failed.')); return; }
    const errors = (sc.groundTruth && Array.isArray(sc.groundTruth.errors)) ? sc.groundTruth.errors : [];
    const sec = el('section', 'errors');
    sec.append(el('h2', null, errors.length ? 'Injected errors (' + errors.length + ')' : 'No injected errors: a clean control'));
    if (errors.length) {
      const table = el('table'); const tr = el('tr');
      for (const h of ['Kind', 'Severity', 'Where', 'Expected', 'Printed']) tr.append(el('th', null, h));
      table.append(tr);
      for (const e of errors) {
        const row = el('tr');
        for (const v of [e.kind, e.severity, e.fieldRef || e.lineRef || 'document', money(e.expected), money(e.actual)]) row.append(el('td', null, v === null || v === undefined ? '' : v));
        table.append(row);
      }
      sec.append(table);
    }
    root.append(sec);
    const images = (result.content || []).filter((c) => c && c.type === 'image' && /^image\/(png|jpeg)$/.test(c.mimeType) && typeof c.data === 'string' && /^[A-Za-z0-9+/=]+$/.test(c.data));
    const shown = (sc.preview && Array.isArray(sc.preview.pages)) ? sc.preview.pages : images.map((_, i) => i + 1);
    images.forEach((c, i) => {
      const fig = el('figure');
      const img = el('img'); img.alt = 'Page ' + (shown[i] || i + 1) + ' of the specimen document'; img.src = 'data:' + c.mimeType + ';base64,' + c.data;
      fig.append(img, el('figcaption', null, 'Page ' + (shown[i] || i + 1) + (sc.pages ? ' of ' + sc.pages : '')));
      root.append(fig);
    });
    if (sc.preview && sc.preview.omitted) root.append(el('p', 'note', sc.preview.omitted + ' more page(s) not shown here: ' + (sc.preview.next ? 'render again with from_page ' + sc.preview.next + ' to see them.' : 'render again to see them.')));
    if (!images.length && !(sc.preview && sc.preview.omitted)) root.append(el('p', 'note', 'No page images in this result.'));
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window.parent) return;
    const m = ev.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && !m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(m.error); else p.resolve(m.result); return; }
    if (m.method === 'ui/notifications/tool-result') show(m.params);
    else if (m.method === 'ui/notifications/host-context-changed') applyContext(m.params);
    else if (m.method === 'ui/resource-teardown' && m.id !== undefined) post({ id: m.id, result: {} });
    else if (m.id !== undefined && m.method) post({ id: m.id, error: { code: -32601, message: 'method not found' } });
  });

  let last = ''; let ready = false;
  const report = () => {
    if (!ready) return;
    const width = Math.ceil(document.documentElement.scrollWidth); const height = Math.ceil(document.documentElement.scrollHeight);
    const key = width + 'x' + height; if (key === last) return; last = key;
    notify('ui/notifications/size-changed', { width, height });
  };
  new ResizeObserver(report).observe(document.documentElement);
  document.addEventListener('load', report, true);

  const info = { name: 'claimseed-preview', version: '1' };
  request('ui/initialize', { protocolVersion: PROTOCOL, appInfo: info, clientInfo: info, appCapabilities: { availableDisplayModes: ['inline'] } })
    .then((r) => { applyContext(r && r.hostContext); notify('ui/notifications/initialized', {}); ready = true; report(); })
    .catch(() => {});
})();
`;

const STYLE = `
:root { color-scheme: light dark; --cs-bg: var(--color-background-primary, #ffffff); --cs-fg: var(--color-text-primary, #1f2328);
  --cs-muted: var(--color-text-secondary, #59636e); --cs-line: var(--color-border-primary, #d1d9e0); --cs-accent: #9a4a1a;
  --cs-font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --cs-bg: var(--color-background-primary, #1c1c1e); --cs-fg: var(--color-text-primary, #e6e6e6);
  --cs-muted: var(--color-text-secondary, #a0a0a0); --cs-line: var(--color-border-primary, #3a3a3c); --cs-accent: #e09060; } }
:root[data-theme="dark"] { --cs-bg: var(--color-background-primary, #1c1c1e); --cs-fg: var(--color-text-primary, #e6e6e6);
  --cs-muted: var(--color-text-secondary, #a0a0a0); --cs-line: var(--color-border-primary, #3a3a3c); --cs-accent: #e09060; }
html, body { margin: 0; background: var(--cs-bg); color: var(--cs-fg); font: 14px/1.45 var(--cs-font); }
#app { padding: 12px 16px 16px; max-width: 980px; margin: 0 auto; }
header h1 { font-size: 16px; margin: 4px 0 2px; overflow-wrap: anywhere; }
.tag { display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: .06em; color: var(--cs-accent); border: 1px solid currentColor; border-radius: 4px; padding: 1px 6px; }
.facts, .note { color: var(--cs-muted); font-size: 12px; margin: 2px 0 10px; overflow-wrap: anywhere; }
.error { color: #c62828; }
h2 { font-size: 14px; margin: 12px 0 6px; }
.errors { overflow-x: auto; }
table { border-collapse: collapse; font-size: 12px; min-width: 100%; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--cs-line); vertical-align: top; white-space: nowrap; }
th { color: var(--cs-muted); font-weight: 600; }
figure { margin: 14px 0 0; }
figure img { display: block; width: 100%; height: auto; border: 1px solid var(--cs-line); border-radius: 4px; background: #fff; }
figcaption { color: var(--cs-muted); font-size: 12px; margin-top: 4px; }
`;

export const VIEW_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>claimseed specimen</title><style>${STYLE}</style></head>
<body><main id="app"><p class="note">Waiting for the rendered document…</p></main>
<script>${SCRIPT}</script></body></html>
`;
