'use strict';
const fs = require('fs');
const { P } = require('./paths');
const { rawFetch, fetchJson } = require('./net');

const CLIENT_ID = '00000000402b5328';
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
const SCOPE = 'XboxLive.signin offline_access';

let safeStorage = null;
function init(electron) { safeStorage = electron.safeStorage; }

// ---------- storage ----------
function loadAccounts() {
  try {
    const buf = fs.readFileSync(P.accounts);
    const text = buf.subarray(0, 4).toString() === 'ENC1'
      ? safeStorage.decryptString(buf.subarray(4))
      : buf.toString('utf8');
    return JSON.parse(text);
  } catch { return { active: null, list: [] }; }
}
function saveAccounts(data) {
  const text = JSON.stringify(data);
  let buf;
  if (safeStorage && safeStorage.isEncryptionAvailable()) buf = Buffer.concat([Buffer.from('ENC1'), safeStorage.encryptString(text)]);
  else buf = Buffer.from(text, 'utf8');
  fs.writeFileSync(P.accounts, buf, { mode: 0o600 });
}
function publicAccounts() {
  const d = loadAccounts();
  // Mojang returns http:// texture URLs; the page only loads https images.
  const https = (u) => (u ? u.replace(/^http:\/\//, 'https://') : null);
  return { active: d.active, list: d.list.map(a => ({ id: a.id, name: a.name, skin: https(a.skin), offline: !!a.offline })) };
}

// ---------- Microsoft OAuth (in a small login window) ----------
function interactiveLogin(BrowserWindow, parent) {
  const url = 'https://login.live.com/oauth20_authorize.srf?' + new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPE, prompt: 'select_account',
  });
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520, height: 680, parent, modal: !!parent, title: 'Sign in with Microsoft', autoHideMenuBar: true,
      backgroundColor: '#ffffff', webPreferences: { partition: 'persist:mslogin', sandbox: true },
    });
    let finished = false;
    const check = (u) => {
      if (!u || !u.startsWith(REDIRECT)) return;
      const q = new URL(u).searchParams;
      finished = true;
      win.close();
      if (q.get('code')) resolve(q.get('code'));
      else reject(new Error(q.get('error_description') || q.get('error') || 'Sign-in was cancelled.'));
    };
    win.webContents.on('will-redirect', (_e, u) => check(u));
    win.webContents.on('did-navigate', (_e, u) => check(u));
    win.webContents.on('will-navigate', (_e, u) => check(u));
    win.on('closed', () => { if (!finished) reject(new Error('Sign-in window was closed.')); });
    win.loadURL(url);
  });
}

async function msToken(params) {
  const res = await rawFetch('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE, ...params }).toString(),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error('Microsoft sign-in failed: ' + (j.error_description || j.error || res.status));
  return j;
}

const XERR = {
  2148916233: 'This Microsoft account has no Xbox profile. Sign in once at minecraft.net to create one.',
  2148916235: 'Xbox Live is not available in your country.',
  2148916236: 'This account needs adult verification on xbox.com.',
  2148916237: 'This account needs adult verification on xbox.com.',
  2148916238: 'This is a child account — an adult must add it to a Microsoft family first.',
};

async function minecraftFromMs(msAccess) {
  const json = (url, body) => rawFetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
  });
  const xblRes = await json('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msAccess },
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
  });
  if (!xblRes.ok) throw new Error('Xbox Live sign-in failed (' + xblRes.status + ').');
  const xbl = await xblRes.json();
  const xstsRes = await json('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
  });
  const xsts = await xstsRes.json().catch(() => ({}));
  if (!xstsRes.ok) throw new Error(XERR[xsts.XErr] || 'Xbox authorization failed (' + (xsts.XErr || xstsRes.status) + ').');
  const uhs = xsts.DisplayClaims.xui[0].uhs;
  const mcRes = await json('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
  });
  if (!mcRes.ok) throw new Error('Minecraft services refused the sign-in (' + mcRes.status + ').');
  const mc = await mcRes.json();
  const profRes = await rawFetch('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: 'Bearer ' + mc.access_token } });
  if (profRes.status === 404) throw new Error('This account does not own Minecraft: Java Edition.');
  if (!profRes.ok) throw new Error('Could not load the Minecraft profile (' + profRes.status + ').');
  const prof = await profRes.json();
  const skin = (prof.skins || []).find(s => s.state === 'ACTIVE') || (prof.skins || [])[0];
  return {
    id: prof.id, name: prof.name, skin: skin ? skin.url : null,
    mcToken: mc.access_token, mcExpires: Date.now() + (mc.expires_in || 86400) * 1000 - 60e3,
    xuid: (xbl.DisplayClaims && xbl.DisplayClaims.xui[0] && xbl.DisplayClaims.xui[0].xid) || '',
  };
}

async function addAccount(BrowserWindow, parent) {
  const code = await interactiveLogin(BrowserWindow, parent);
  const tok = await msToken({ grant_type: 'authorization_code', code });
  const acc = await minecraftFromMs(tok.access_token);
  acc.msRefresh = tok.refresh_token;
  const d = loadAccounts();
  d.list = d.list.filter(a => a.id !== acc.id);
  d.list.push(acc);
  d.active = acc.id;
  saveAccounts(d);
  return publicAccounts();
}

/** Returns a launch-ready account, refreshing tokens when needed. */
async function getLaunchAccount() {
  if (process.env.MCL_TEST_OFFLINE) {
    return { id: '00000000000000000000000000000000', name: process.env.MCL_TEST_OFFLINE, mcToken: '0', xuid: '', offline: true };
  }
  const d = loadAccounts();
  const acc = d.list.find(a => a.id === d.active);
  if (!acc) throw new Error('Sign in with your Microsoft account to play.');
  if (Date.now() < acc.mcExpires) return acc;
  const tok = await msToken({ grant_type: 'refresh_token', refresh_token: acc.msRefresh });
  const fresh = await minecraftFromMs(tok.access_token);
  Object.assign(acc, fresh, { msRefresh: tok.refresh_token || acc.msRefresh });
  saveAccounts(d);
  return acc;
}

function setActive(id) { const d = loadAccounts(); if (d.list.some(a => a.id === id)) { d.active = id; saveAccounts(d); } return publicAccounts(); }
function removeAccount(id) {
  const d = loadAccounts();
  d.list = d.list.filter(a => a.id !== id);
  if (d.active === id) d.active = d.list[0] ? d.list[0].id : null;
  saveAccounts(d);
  return publicAccounts();
}

module.exports = { init, addAccount, getLaunchAccount, publicAccounts, setActive, removeAccount };
