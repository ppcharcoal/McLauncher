'use strict';
const path = require('path');
const { P, readJson, writeJson } = require('./paths');
const { fetchJson } = require('./net');

const META = 'https://meta.fabricmc.net/v2';

async function gameVersions() {
  return fetchJson(`${META}/versions/game`);
}

/** Loader versions that work with a Minecraft version, newest first. */
async function loaderVersions(gameVersion) {
  const list = await fetchJson(`${META}/versions/loader/${encodeURIComponent(gameVersion)}`);
  return list.map(x => ({ version: x.loader.version, stable: !!x.loader.stable }));
}

async function getProfile(gameVersion, loaderVersion) {
  const id = `fabric-loader-${loaderVersion}-${gameVersion}`;
  const file = path.join(P.versions, id, `${id}.json`);
  const existing = readJson(file, null);
  if (existing) return existing;
  const json = await fetchJson(`${META}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`);
  writeJson(file, json);
  return json;
}

module.exports = { gameVersions, loaderVersions, getProfile };
