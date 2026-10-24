'use strict';
window.Pages = window.Pages || {};

Pages.settings = async (main) => {
  const { h } = U;
  const [s, info, acc] = await Promise.all([U.call('getSettings'), U.call('appInfo'), U.call('accounts')]);
  const save = async (patch) => { try { Object.assign(s, await U.call('setSettings', patch)); } catch (e) { C.toast(e.message, 'err'); } };
  const toggle = (key, title, text) => h('div.toggle-row', h('div', h('b', title), h('small', text)),
    h('label.switch', h('input', { type: 'checkbox', checked: !!s[key], 'aria-label': title, on: { change: e => save({ [key]: e.target.checked }) } }), h('span')));
  const memOut = h('output', (s.memory / 1024).toFixed(1) + ' GB');

  // ---- appearance ----
  const themeCards = h('div.theme-cards');
  const preview = (bg, side, accentOn) => h('div.pv', { style: { background: bg } }, h('i', { style: { background: side } }), h('i', { style: { margin: '10px', borderRadius: '4px', background: accentOn } }));
  function drawThemes() {
    const opts = [
      ['system', 'Match system', 'linear-gradient(90deg, #181b22 50%, #eceff3 50%)', 'linear-gradient(180deg, #1f232c, #ffffff)'],
      ['dark', 'Dark', '#181b22', '#1f232c'],
      ['light', 'Light', '#eceff3', '#ffffff'],
    ];
    themeCards.replaceChildren(...opts.map(([k, label, bg, side]) => h('button.theme-card' + (s.theme === k ? '.on' : ''), { type: 'button', 'aria-pressed': String(s.theme === k), on: { click: async () => {
      await save({ theme: k }); Theme.apply(k, s.accent); drawThemes();
    } } }, preview(bg, side, s.accent), h('span', label))));
  }
  const swatches = h('div.swatches');
  function drawSwatches() {
    const isPreset = Theme.ACCENTS.some(([, c]) => c.toLowerCase() === s.accent.toLowerCase());
    const custom = h('input', { type: 'color', value: s.accent, 'aria-label': 'Custom accent color',
      on: { input: e => Theme.apply(null, e.target.value), change: async e => { await save({ accent: e.target.value }); drawSwatches(); drawThemes(); } } });
    swatches.replaceChildren(...Theme.ACCENTS.map(([name, c]) => h('button.swatch' + (s.accent.toLowerCase() === c ? '.on' : ''), { type: 'button', title: name, 'aria-label': `${name} accent`, style: { background: c },
      on: { click: async () => { await save({ accent: c }); Theme.apply(null, c); drawSwatches(); drawThemes(); } } })),
      h('label.swatch.custom' + (isPreset ? '' : '.on'), { title: 'Custom color' }, custom),
      h('span.faint', { style: { fontSize: '12.5px', marginLeft: '4px' } }, isPreset ? '' : s.accent.toUpperCase()));
  }
  drawThemes(); drawSwatches();

  // ---- font & text size ----
  const fontCards = h('div.font-cards');
  const customIn = h('input.input', { placeholder: 'Type an installed font name', value: s.fontCustom || '', list: 'mcl-font-list', 'aria-label': 'Custom font name',
    on: { change: async e => { await save({ font: 'custom', fontCustom: e.target.value.trim() }); Theme.applyFont('custom', s.fontCustom); drawFonts(); } } });
  const fontList = h('datalist#mcl-font-list');
  const customRow = h('div.field', { style: { marginTop: '10px', marginBottom: 0 } }, h('label', 'Custom font'), customIn, fontList, h('span.hint', 'Any font installed on this computer.'));
  function drawFonts() {
    fontCards.replaceChildren(...Theme.FONTS.map(([id, label, family]) => {
      if (family) Theme.loadFont(id);
      const fam = family ? `'${family}', sans-serif` : id === 'custom' && s.fontCustom ? `"${s.fontCustom}", sans-serif` : 'system-ui, sans-serif';
      return h('button.font-card' + (s.font === id ? '.on' : ''), { type: 'button', 'aria-pressed': String(s.font === id), on: { click: async () => {
        if (id === 'custom') { customRow.style.display = ''; customIn.focus(); if (!s.fontCustom) return; }
        await save({ font: id }); Theme.applyFont(id, s.fontCustom); drawFonts();
      } } }, h('b', { style: { fontFamily: fam } }, 'Aa'), h('span', label));
    }));
    customRow.style.display = s.font === 'custom' ? '' : 'none';
  }
  drawFonts();
  (async () => {
    let names = [];
    try { if (window.queryLocalFonts) names = [...new Set((await window.queryLocalFonts()).map(f => f.family))]; } catch {}
    if (!names.length) { try { names = await U.call('systemFonts'); } catch {} }
    fontList.replaceChildren(...names.slice(0, 2000).map(n => h('option', { value: n })));
  })();
  const SCALES = [[0.9, 'Smaller'], [1, 'Default'], [1.1, 'Larger'], [1.2, 'Largest']];
  const scaleSeg = h('div.segmented', SCALES.map(([v, label]) => h('button' + (Number(s.scale || 1) === v ? '.on' : ''), { type: 'button', on: { click: async (e) => {
    await save({ scale: v }); Theme.applyScale(v);
    [...scaleSeg.children].forEach(b => b.classList.toggle('on', b === e.currentTarget));
  } } }, label)));

  const accounts = h('div', acc.list.length ? acc.list.map(a => h('div.acc-row', U.skinHead(a.skin, a.name), h('div.grow', h('b', a.name), h('small.muted', { style: { display: 'block' } }, a.id === acc.active ? 'Playing as this account' : 'Microsoft account')),
    a.id !== acc.active ? h('button.btn.small', { on: { click: async () => { await U.call('setActiveAccount', a.id); App.refreshAccount(); App.go('#settings'); } } }, 'Use') : null,
    h('button.btn.small.ghost', { on: { click: async () => { await U.call('removeAccount', a.id); App.refreshAccount(); App.go('#settings'); } } }, 'Sign out')))
    : h('p.muted', { style: { margin: '0 0 12px' } }, 'No account yet.'));

  main.append(h('div.page', h('div.page-head', h('div', { style: { flex: 1 } }, h('h1', 'Settings'), h('p', 'These apply to every instance unless an instance overrides them.'))),
    h('div.settings-wrap',
      h('div.section', h('h2', 'Appearance'), h('p', 'Pick a theme and the color used for buttons and highlights.'),
        h('div.field', h('label', 'Theme'), themeCards),
        h('div.field', h('label', 'Accent color'), swatches),
        h('div.field', h('label', 'Font'), fontCards, customRow),
        h('div.field', { style: { marginBottom: 0 } }, h('label', 'Text size'), scaleSeg)),
      h('div.section', h('h2', 'Accounts'), h('p', 'Sign in with the Microsoft account that owns Minecraft: Java Edition.'), accounts,
        h('button.btn.primary', { style: { marginTop: '10px' }, on: { click: async () => { await C.signIn(); App.go('#settings'); } } }, U.svg('user'), acc.list.length ? 'Add another account' : 'Sign in with Microsoft')),
      h('div.section', h('h2', 'While playing'), h('p', 'McLauncher steps out of the way so the game gets all the resources.'),
        toggle('closeOnLaunch', 'Close the launcher while the game runs', 'The launcher window closes once Minecraft is up and reopens on the game’s logs when you quit. Nothing is lost.'),
        info.platform === 'linux' ? toggle('nativeWayland', 'Native Wayland game window', 'Runs Minecraft through your system GLFW instead of XWayland. Helps with crashes on Hyprland. Needs the glfw package (sudo pacman -S glfw). Instances can override this.') : null,
        info.platform === 'linux' ? toggle('gamemode', 'Use Feral GameMode', info.gamemode ? 'gamemoderun was found and will wrap the game.' : 'Install the gamemode package to use this (sudo pacman -S gamemode).') : null),
      h('div.section', h('h2', 'Java'), h('p', 'By default McLauncher downloads the Java version each Minecraft release needs.'),
        h('div.field', h('label', 'Default memory'), h('div.range-row', h('input', { type: 'range', min: 1024, max: 32768, step: 512, value: s.memory, on: { input: e => { memOut.textContent = (e.target.value / 1024).toFixed(1) + ' GB'; }, change: e => save({ memory: +e.target.value }) } }), memOut)),
        h('div.field', h('label', 'Java executable'), h('input.input', { value: s.javaPath, placeholder: 'Automatic', on: { change: e => save({ javaPath: e.target.value.trim() }) } }), h('span.hint', 'Leave empty unless you know you need a specific Java.')),
        h('div.field', h('label', 'Extra Java arguments'), h('input.input', { value: s.jvmArgs, placeholder: '-XX:+UseZGC', on: { change: e => save({ jvmArgs: e.target.value }) } }))),
      h('div.section', h('h2', 'CurseForge'), h('p', 'CurseForge browsing works out of the box through the curse.tools proxy. Add your own API key from console.curseforge.com to talk to CurseForge directly.'),
        h('div.field', h('label', 'API key (optional)'), h('input.input', { type: 'password', value: s.curseforgeKey, placeholder: 'Not set', on: { change: e => save({ curseforgeKey: e.target.value.trim() }) } }))),
      h('div.section', h('h2', 'About'), h('p', `McLauncher ${info.version} for ${info.platform === 'win32' ? 'Windows' : 'Linux'}${info.wayland ? ', running on Wayland' : ''}${info.hyprland ? ' (Hyprland)' : ''}.`),
        h('div.row', h('button.btn', { on: { click: () => U.call('openDataDir') } }, U.svg('folder'), 'Open data folder'),
          h('button.btn', { on: { click: () => U.call('openExternal', 'https://github.com/ppcharcoal/McLauncher') } }, U.svg('external'), 'Project page'))))));
};
