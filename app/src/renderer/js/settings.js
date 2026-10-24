'use strict';
window.Pages = window.Pages || {};

Pages.settings = async (main) => {
  const { h } = U;
  const [s, info, acc] = await Promise.all([U.call('getSettings'), U.call('appInfo'), U.call('accounts')]);
  const save = async (patch) => { try { Object.assign(s, await U.call('setSettings', patch)); } catch (e) { C.toast(e.message, 'err'); } };
  const toggle = (key, title, text) => h('div.toggle-row', h('div', h('b', title), h('small', text)),
    h('label.switch', h('input', { type: 'checkbox', checked: !!s[key], 'aria-label': title, on: { change: e => save({ [key]: e.target.checked }) } }), h('span')));
  const memOut = h('output', (s.memory / 1024).toFixed(1) + ' GB');

  const accounts = h('div', acc.list.length ? acc.list.map(a => h('div.acc-row', U.skinHead(a.skin, a.name), h('div.grow', h('b', a.name), h('small.muted', { style: { display: 'block' } }, a.id === acc.active ? 'Playing as this account' : 'Microsoft account')),
    a.id !== acc.active ? h('button.btn.small', { on: { click: async () => { await U.call('setActiveAccount', a.id); App.refreshAccount(); App.go('#settings'); } } }, 'Use') : null,
    h('button.btn.small.ghost', { on: { click: async () => { await U.call('removeAccount', a.id); App.refreshAccount(); App.go('#settings'); } } }, 'Sign out')))
    : h('p.muted', { style: { margin: '0 0 12px' } }, 'No account yet.'));

  main.append(h('div.page', h('div.page-head', h('div', { style: { flex: 1 } }, h('h1', 'Settings'), h('p', 'These apply to every instance unless an instance overrides them.'))),
    h('div.settings-wrap',
      h('div.section', h('h2', 'Accounts'), h('p', 'Sign in with the Microsoft account that owns Minecraft: Java Edition.'), accounts,
        h('button.btn.primary', { style: { marginTop: '10px' }, on: { click: async () => { await C.signIn(); App.go('#settings'); } } }, U.svg('user'), acc.list.length ? 'Add another account' : 'Sign in with Microsoft')),
      h('div.section', h('h2', 'While playing'), h('p', 'McLauncher steps out of the way so the game gets all the resources.'),
        toggle('closeOnLaunch', 'Close the launcher while the game runs', 'The launcher window closes once Minecraft is up and reopens on the game’s logs when you quit. Nothing is lost.'),
        toggle('gamemode', 'Use Feral GameMode', info.gamemode ? 'gamemoderun was found and will wrap the game.' : 'Install the gamemode package to use this (sudo pacman -S gamemode).')),
      h('div.section', h('h2', 'Java'), h('p', 'By default McLauncher downloads the Java version each Minecraft release needs.'),
        h('div.field', h('label', 'Default memory'), h('div.range-row', h('input', { type: 'range', min: 1024, max: 32768, step: 512, value: s.memory, on: { input: e => { memOut.textContent = (e.target.value / 1024).toFixed(1) + ' GB'; }, change: e => save({ memory: +e.target.value }) } }), memOut)),
        h('div.field', h('label', 'Java executable'), h('input.input', { value: s.javaPath, placeholder: 'Automatic', on: { change: e => save({ javaPath: e.target.value.trim() }) } }), h('span.hint', 'Leave empty unless you know you need a specific Java.')),
        h('div.field', h('label', 'Extra Java arguments'), h('input.input', { value: s.jvmArgs, placeholder: '-XX:+UseZGC', on: { change: e => save({ jvmArgs: e.target.value }) } }))),
      h('div.section', h('h2', 'CurseForge'), h('p', 'CurseForge browsing works out of the box through the curse.tools proxy. Add your own API key from console.curseforge.com to talk to CurseForge directly.'),
        h('div.field', h('label', 'API key (optional)'), h('input.input', { type: 'password', value: s.curseforgeKey, placeholder: 'Not set', on: { change: e => save({ curseforgeKey: e.target.value.trim() }) } }))),
      h('div.section', h('h2', 'About'), h('p', `McLauncher ${info.version}${info.wayland ? ', running on Wayland' : ''}${info.hyprland ? ' (Hyprland)' : ''}.`),
        h('div.row', h('button.btn', { on: { click: () => U.call('openDataDir') } }, U.svg('folder'), 'Open data folder'),
          h('button.btn', { on: { click: () => U.call('openExternal', 'https://github.com/ppcharcoal/McLauncher') } }, U.svg('external'), 'Project page'))))));
};
