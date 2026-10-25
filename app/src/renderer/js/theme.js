'use strict';
/* Applies the style (look + font), light/dark mode and accent color. Loaded in <head> so the first paint is already themed. */
(function () {
  const ACCENTS = [
    ['Copper', '#5cc2a8'], ['Sky', '#5aa9f0'], ['Amethyst', '#a98ae6'], ['Grass', '#7cc25c'],
    ['Gold', '#e0b43c'], ['Redstone', '#e5584d'], ['Rose', '#e77fb3'], ['Slate', '#8c9bb0'],
  ];
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let current = { theme: 'system', accent: ACCENTS[0][1], style: 'minimal' };

  // Styles change the whole look and the typeface. Some have their own light/dark character.
  const STYLES = [
    { id: 'minimal', name: 'Minimal', desc: 'Calm, flat and quiet.', font: ['onest', 'Onest'], mode: null },
    { id: 'glass', name: 'Modern Glass', desc: 'Frosted panels over a soft glow.', font: ['inter', 'Inter'], mode: null },
    { id: 'aero', name: 'Frutiger Aero', desc: 'Glossy, sky-blue and bubbly.', font: ['nunito', 'Nunito'], mode: 'light' },
    { id: 'darkmatter', name: 'Dark Matter', desc: 'Deep space with a neon edge.', font: ['space-grotesk', 'Space Grotesk'], mode: 'dark' },
  ];
  const styleOf = (id) => STYLES.find(x => x.id === id) || STYLES[0];

  function ink(hex) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    return L > 0.36 ? '#10151b' : '#ffffff';
  }
  function resolved() {
    const forced = styleOf(current.style).mode;
    if (forced) return forced;
    return current.theme === 'system' ? (media.matches ? 'dark' : 'light') : current.theme;
  }
  function apply(theme, accent) {
    if (theme) current.theme = theme;
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) current.accent = accent;
    const root = document.documentElement;
    root.dataset.theme = resolved();
    root.style.setProperty('--accent', current.accent);
    root.style.setProperty('--accent-ink', ink(current.accent));
  }
  media.addEventListener('change', () => { if (current.theme === 'system') apply(); });

  // ---- fonts ----
  const FALLBACK = "'Noto Sans', 'DejaVu Sans', 'Segoe UI', Cantarell, Arial, Helvetica, sans-serif";
  const RANGES = {
    latin: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    'latin-ext': 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
  };
  const loaded = {};
  /** Load a bundled font; if the file URL can't be read, ask the main process for the bytes instead. */
  function loadBundled(id, family) {
    if (loaded[id]) return loaded[id];
    loaded[id] = Promise.all(Object.entries(RANGES).map(async ([sub, range]) => {
      const file = `${id}-${sub}-wght-normal.woff2`;
      const desc = { weight: '100 900', style: 'normal', unicodeRange: range, display: 'swap' };
      let face;
      try { face = await new FontFace(family, `url("fonts/${file}")`, desc).load(); }
      catch (e) {
        try { face = await new FontFace(family, await window.mcl.call('fontData', file), desc).load(); }
        catch (e2) { window.mcl && window.mcl.call('rendererLog', `font ${file} failed: ${e.message} / ${e2.message}`); return; }
      }
      document.fonts.add(face);
    }));
    return loaded[id];
  }
  let switchTimer;
  function applyStyle(id) {
    const st = styleOf(id);
    const root = document.documentElement;
    if (root.dataset.style && root.dataset.style !== st.id && current.motion) {
      // Crossfade colours when switching styles.
      root.classList.add('style-switching');
      clearTimeout(switchTimer);
      switchTimer = setTimeout(() => root.classList.remove('style-switching'), 500);
    }
    current.style = st.id;
    document.documentElement.dataset.style = st.id;
    loadBundled(st.font[0], st.font[1]);
    document.documentElement.style.setProperty('--font', `'${st.font[1]}', ${FALLBACK}`);
    apply();
  }
  function applyMotion(on) {
    current.motion = on !== false && on !== 'false' && on !== '0';
    document.documentElement.dataset.motion = current.motion ? 'on' : 'off';
  }
  function applyScale(scale) {
    const v = Number(scale) || 1;
    current.scale = v;
    try { window.mcl.setZoom(v); } catch {}
  }

  const q = new URLSearchParams(location.search);
  apply(q.get('theme') || 'system', q.get('accent') || ACCENTS[0][1]);
  applyMotion(q.get('motion') ?? true);
  applyStyle(q.get('style') || 'minimal');
  applyScale(q.get('scale') || 1);
  const loadFont = (id) => { const st = styleOf(id); return loadBundled(st.font[0], st.font[1]); };
  window.Theme = { apply, applyStyle, applyScale, applyMotion, get motion() { return current.motion; }, loadFont, ACCENTS, STYLES, get: () => ({ ...current, resolved: resolved(), forcedMode: styleOf(current.style).mode }) };
})();
