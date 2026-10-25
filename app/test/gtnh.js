'use strict';
// CI: download the GT New Horizons Java 17+ Prism pack, import it and print the instance id.
const fs = require('fs');
const path = require('path');
if (!process.env.MCL_DATA_DIR) throw new Error('Set MCL_DATA_DIR');
const { download } = require('../src/main/net');
const packs = require('../src/main/packs');
const instances = require('../src/main/instances');
const URL = process.env.GTNH_URL || 'https://downloads.gtnewhorizons.com/Multi_mc_downloads/GT_New_Horizons_2.8.4_Java_17-25.zip';
(async () => {
  const file = path.join(process.env.MCL_DATA_DIR, 'gtnh.zip');
  let t = Date.now();
  await download(URL, file);
  console.log('downloaded', (fs.statSync(file).size / 1048576).toFixed(0), 'MB in', Math.round((Date.now() - t) / 1000), 's');
  t = Date.now();
  const r = await packs.importFile(file);
  const i = r.instance;
  console.log('imported in', Math.round((Date.now() - t) / 1000), 's:', JSON.stringify({ id: i.id, name: i.name, prism: i.prism, loader: i.loader, loaderVersion: i.loaderVersion, icon: i.iconFile, memory: i.memory, components: i.components }));
  if (!i.prism) throw new Error('GTNH Java 17 pack should use the Prism component engine');
  if (!i.iconFile) throw new Error('GTNH icon was not imported');
  instances.update(i.id, { memory: 6144 });
  fs.rmSync(file, { force: true });
  fs.writeFileSync(path.join(process.env.MCL_DATA_DIR, 'gtnh-id.txt'), i.id);
})().catch(e => { console.error(e); process.exit(1); });
