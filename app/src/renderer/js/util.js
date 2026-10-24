'use strict';
/* Small DOM + formatting helpers shared by every page. */
const U = {};

U.call = async (method, ...args) => {
  try { return await window.mcl.call(method, ...args); }
  catch (e) { throw new Error(String(e.message || e).replace(/^Error invoking remote method 'call': (Error: )?/, '')); }
};

/** h('div.cls#id', {attrs, on:{click}}, ...children) */
U.h = (sel, attrs, ...kids) => {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (k) => {
    if (k == null || k === false) return;
    if (Array.isArray(k)) return k.forEach(add);
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
};

U.svg = (name) => {
  const paths = U.ICONS[name] || '';
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${paths}</svg>`;
  return t.content.firstChild;
};
U.ICONS = {
  play: '<path d="M6 3.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2A.8.8 0 0 0 6 3.8z"/>',
  stop: '<rect x="5" y="5" width="10" height="10" rx="1.5"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  folder: '<path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2h6.6a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z"/>',
  file: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15"/>',
  trash: '<path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10.5h7.4L14.5 6"/>',
  search: '<circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/>',
  download: '<path d="M10 3v10M6 9l4 4 4-4M4 16.5h12"/>',
  upload: '<path d="M10 14V4M6 8l4-4 4 4M4 16.5h12"/>',
  more: '<circle cx="5" cy="10" r=".8"/><circle cx="10" cy="10" r=".8"/><circle cx="15" cy="10" r=".8"/>',
  refresh: '<path d="M15.5 8A6 6 0 0 0 4.6 6.5M4.5 12a6 6 0 0 0 10.9 1.5"/><path d="M15.8 3.5V8h-4.5M4.2 16.5V12h4.5"/>',
  external: '<path d="M11 3.5h5.5V9M16.5 3.5l-8 8M14 12v4.5H3.5V6H8"/>',
  copy: '<rect x="6.5" y="6.5" width="10" height="10" rx="1.5"/><path d="M13.5 6.5V4a.5.5 0 0 0-.5-.5H4a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h2.5"/>',
  cube: '<path d="M10 2.5l6.5 3.7v7.6L10 17.5l-6.5-3.7V6.2z"/><path d="M3.5 6.2L10 10l6.5-3.8M10 10v7.5"/>',
  image: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="M3.5 14l4-4 3 3 2-2 4 4"/>',
  globe: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2 2.2 2.8 4.5 2.8 7S12 14.8 10 17c-2-2.2-2.8-4.5-2.8-7S8 5.2 10 3z"/>',
  sparkle: '<path d="M10 3l1.6 4.2L16 9l-4.4 1.8L10 15l-1.6-4.2L4 9l4.4-1.8z"/>',
  back: '<path d="M12 4l-6 6 6 6"/>',
  check: '<path d="M4 10.5l4 4 8-9"/>',
  x: '<path d="M5 5l10 10M15 5L5 15"/>',
  user: '<circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/>',
  terminal: '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M6 8l2.5 2L6 12M10.5 12.5h3.5"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/>',
  layers: '<path d="M10 3l7 4-7 4-7-4z"/><path d="M3 10.5l7 4 7-4M3 13.5l7 4 7-4"/>',
  sun: '<circle cx="10" cy="10" r="3.4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"/>',
  map: '<path d="M3 5.5l4.5-2 5 2 4.5-2v11l-4.5 2-5-2-4.5 2z"/><path d="M7.5 3.5v11M12.5 5.5v11"/>',
};

U.esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
U.num = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n || 0);
U.size = (b) => b == null ? '' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
U.ago = (t) => {
  if (!t) return 'never';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString();
};
U.duration = (sec) => {
  if (!sec) return 'not played yet';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${m} min played` : `${Math.max(1, m)} min played`;
};
U.loaderLabel = (i) => ({ fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' })[i.loader] || 'Vanilla';
/** "Forge 47.3.0" style label for an instance's loader. */
U.loaderVersionLabel = (i) => {
  if (!i.loader || i.loader === 'vanilla') return 'Vanilla';
  let v = i.loaderVersion || 'latest';
  if (i.loader === 'forge' && v.startsWith(i.mcVersion + '-')) v = v.slice(i.mcVersion.length + 1).replace('-' + i.mcVersion, '');
  if (i.loader === 'neoforge') v = v.replace(/^1\.20\.1-/, '');
  return `${U.loaderLabel(i)} ${v}`;
};

U.hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

/** A small block-texture picture generated from a name, used when an instance has no picture. */
U.PALETTES = [
  ['#5d8f3a', '#6fa847', '#4f7a31', '#8a6a46', '#76593a'],   // grass
  ['#7d7f84', '#8e9095', '#6b6d72', '#9a9ca1', '#5d5f63'],   // stone
  ['#4f9e8a', '#5cc2a8', '#3f7f70', '#6fcfb6', '#356a5d'],   // oxidized copper
  ['#8b6ac9', '#a98ae6', '#6f52a8', '#c2a8f2', '#5a4189'],   // amethyst
  ['#d8c48d', '#e4d3a0', '#c7b179', '#ede0b6', '#b49d66'],   // sand
  ['#3d4250', '#474d5d', '#333845', '#545a6b', '#2b2f3a'],   // deepslate
  ['#b5523a', '#c9654a', '#9b4330', '#d77a5c', '#853826'],   // terracotta
  ['#c79a2a', '#e0b43c', '#a87f1e', '#f0c95a', '#8e6a17'],   // gold
];
U.blockArt = (seed, size = 8) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.classList.add('pixel');
  const ctx = c.getContext('2d');
  let h = U.hash(seed);
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; };
  const pal = U.PALETTES[U.hash(seed + '#') % U.PALETTES.length];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = rnd();
    ctx.fillStyle = pal[r < .45 ? 0 : r < .7 ? 1 : r < .85 ? 2 : r < .94 ? 3 : 4];
    ctx.fillRect(x, y, 1, 1);
  }
  return c;
};
U.instPic = (inst) => inst.iconUrl ? U.h('img', { src: inst.iconUrl, alt: '' }) : U.blockArt(inst.id || inst.name);

/** Draw the face (with hat layer) of a Minecraft skin into a canvas. */
U.skinHead = (url, name) => {
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const ctx = c.getContext('2d');
  if (!url) { const art = U.blockArt(name || 'steve'); ctx.drawImage(art, 0, 0); return c; }
  const img = new Image();
  img.onload = () => { ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8); ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8); };
  img.src = url;
  return c;
};

/** Safe, tiny markdown/HTML-to-HTML renderer for project descriptions. Everything is escaped first. */
U.renderMd = (src, isHtml) => {
  let t = String(src || '');
  t = t.replace(/<img[^>]*?src=["']([^"']+)["'][^>]*>/gi, (m, u) => `\n![](${u})\n`)
    .replace(/<a[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, u, txt) => `[${txt.replace(/<[^>]+>/g, '')}](${u})`)
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h([1-3])[^>]*>/gi, (m, n) => '\n' + '#'.repeat(+n) + ' ')
    .replace(/<(strong|b)>/gi, '**').replace(/<\/(strong|b)>/gi, '**')
    .replace(/<[^>]+>/g, '');
  if (isHtml) t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const safeUrl = (u) => /^https:\/\//.test(u) ? u : null;
  const inline = (s) => U.esc(s)
    .replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, (m, u) => { const s2 = safeUrl(u.replace(/&amp;/g, '&')); return s2 ? `<img src="${U.esc(s2)}" alt="" loading="lazy">` : ''; })
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, txt, u) => { const s2 = safeUrl(u.replace(/&amp;/g, '&')); return s2 ? `<a href="${U.esc(s2)}" target="_blank">${txt}</a>` : txt; })
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = false;
  for (const raw of t.split('\n')) {
    const line = raw.trimEnd();
    const hm = /^(#{1,3})\s+(.*)$/.exec(line.trim());
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (hm) out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`);
    else if (line.trim()) out.push(`<p>${inline(line.trim())}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
};

U.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
U.envBadge = (env, isLibrary) => {
  const out = [];
  const map = { client: ['client', 'Client'], server: ['server', 'Server'], both: ['both', 'Client & server'], either: ['both', 'Client or server'], '*': null };
  if (map[env]) out.push(U.h('span.badge.' + map[env][0], map[env][1]));
  if (isLibrary) out.push(U.h('span.badge.library', 'Library'));
  return out;
};
window.U = U;
