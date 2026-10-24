'use strict';
/* Applies light/dark theme and accent color. Loaded in <head> so the first paint is already themed. */
(function () {
  const ACCENTS = [
    ['Copper', '#5cc2a8'], ['Sky', '#5aa9f0'], ['Amethyst', '#a98ae6'], ['Grass', '#7cc25c'],
    ['Gold', '#e0b43c'], ['Redstone', '#e5584d'], ['Rose', '#e77fb3'], ['Slate', '#8c9bb0'],
  ];
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let current = { theme: 'system', accent: ACCENTS[0][1] };

  function ink(hex) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    return L > 0.36 ? '#10151b' : '#ffffff';
  }
  function resolved() { return current.theme === 'system' ? (media.matches ? 'dark' : 'light') : current.theme; }
  function apply(theme, accent) {
    if (theme) current.theme = theme;
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) current.accent = accent;
    const root = document.documentElement;
    root.dataset.theme = resolved();
    root.style.setProperty('--accent', current.accent);
    root.style.setProperty('--accent-ink', ink(current.accent));
  }
  media.addEventListener('change', () => { if (current.theme === 'system') apply(); });
  const q = new URLSearchParams(location.search);
  apply(q.get('theme') || 'system', q.get('accent') || ACCENTS[0][1]);
  window.Theme = { apply, ACCENTS, get: () => ({ ...current, resolved: resolved() }) };
})();
