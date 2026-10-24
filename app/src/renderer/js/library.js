'use strict';
window.Pages = window.Pages || {};

Pages.play = async (inst) => {
  if (!App.account) {
    const ok = await C.confirm('Sign in to play', 'Minecraft needs the Microsoft account that owns the game. Sign in now?', { ok: 'Sign in with Microsoft' });
    if (!ok) return;
    await C.signIn();
    if (!App.account) return;
  }
  // Modpacks: make sure every file is in place before starting.
  try {
    const check = await U.call('packVerify', inst.id);
    if (check.missing.length && !(await C.missingFiles(inst.id, check.missing, { forLaunch: true }))) return;
  } catch {}
  try { await U.call('launch', inst.id); App.refreshInstances(); }
  catch (e) { C.toast(e.message, 'err'); App.refreshInstances(); }
};

Pages.newInstanceFlow = async (preset) => {
  const inst = await C.newInstance(preset);
  if (inst) { await App.refreshInstances(); App.go(`#instance/${inst.id}/mods`); }
};

Pages.importFlow = () => C.importDialog();

Pages.library = async (main) => {
  const { h } = U;
  const list = await App.refreshInstances();
  const head = h('div.page-head',
    h('div', { style: { flex: 1 } }, h('h1', 'Library'), h('p', list.length ? `${list.length} instance${list.length === 1 ? '' : 's'}` : 'Make an instance to start playing.')),
    h('button.btn', { on: { click: Pages.importFlow } }, U.svg('upload'), 'Import modpack'),
    h('button.btn', { on: { click: () => App.go('#discover/modpack') } }, U.svg('download'), 'Get a modpack'),
    h('button.btn.primary', { on: { click: () => Pages.newInstanceFlow() } }, U.svg('plus'), 'New instance'));

  let content;
  if (!list.length) {
    content = h('div.empty',
      h('h3', 'No instances yet'),
      h('p', 'An instance is its own Minecraft install with its own mods, worlds and settings.'),
      h('div.row', { style: { justifyContent: 'center', gap: '8px' } },
        h('button.btn.primary', { on: { click: () => Pages.newInstanceFlow() } }, U.svg('plus'), 'New instance'),
        h('button.btn', { on: { click: () => App.go('#discover/modpack') } }, 'Browse modpacks')));
  } else {
    content = h('div.lib-grid', list.map(i => {
      const running = i.session && ['running', 'starting', 'preparing'].includes(i.session.state);
      return h('div.tile', { tabindex: 0, on: { click: () => App.go(`#instance/${i.id}`), keydown: (e) => { if (e.key === 'Enter') App.go(`#instance/${i.id}`); } } },
        h('div.art', U.instPic(i),
          running ? h('span.status-pill.running', h('i.run-dot'), 'Playing') : null,
          h('button.play-overlay', { title: `Play ${i.name}`, 'aria-label': `Play ${i.name}`, on: { click: (e) => { e.stopPropagation(); Pages.play(i); } } }, U.svg('play'))),
        h('h3', i.name),
        h('p', `${U.loaderLabel(i)} ${i.mcVersion}`),
        h('p.faint', { style: { fontSize: '12px' } }, i.lastPlayed ? `Played ${U.ago(i.lastPlayed)}` : 'Not played yet'));
    }));
  }
  main.append(h('div.page', head, content, list.length ? h('p.drop-hint', 'Tip: drop a .mrpack or CurseForge .zip anywhere to import it.') : null));
};
