// Sestaví statický web do dist/ (to, co nasazuje Vercel):
//   app/public/*  +  library/index.json  +  library/<kniha>/{book.json, insights.json, transcript/*.json, cover.*}
// Zvuk se NEKOPÍRUJE – hraje se z úložiště zadaného v meta.json jako "audioBase".
//   node app/scripts/build_site.mjs
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookIds, coverExt, indexEntry, mergedInsights, publicBook, readJson } from '../lib/library.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(APP_DIR, '..');
const DIST = path.join(ROOT, 'dist');

await fsp.rm(DIST, { recursive: true, force: true });
await fsp.cp(path.join(APP_DIR, 'public'), DIST, { recursive: true });

const ids = await bookIds(ROOT);
const index = [];
for (const id of ids) {
  const src = path.join(ROOT, id), out = path.join(DIST, 'library', id);
  const raw = await readJson(path.join(src, 'book.json'));
  await fsp.mkdir(path.join(out, 'transcript'), { recursive: true });

  if (raw.cover) {
    try { await fsp.copyFile(path.join(src, raw.cover), path.join(out, `cover${coverExt(raw)}`)); }
    catch { console.warn(`[${id}] obálka ${raw.cover} nenalezena`); }
  }
  let t = 0;
  for (const f of await fsp.readdir(path.join(src, 'transcript')).catch(() => [])) {
    if (/^\d+\.json$/.test(f)) { await fsp.copyFile(path.join(src, 'transcript', f), path.join(out, 'transcript', f)); t++; }
  }
  const ins = await mergedInsights(ROOT, id);
  await fsp.writeFile(path.join(out, 'insights.json'), JSON.stringify(ins));
  await fsp.writeFile(path.join(out, 'book.json'), JSON.stringify(publicBook(raw)));
  index.push(await indexEntry(ROOT, id));
  console.log(`[${id}] přepisy: ${t}, shrnutí: ${Object.keys(ins.chapters).length}, audioBase: ${raw.audioBase || 'NENÍ NASTAVEN (zvuk na webu hrát nebude)'}`);
}
await fsp.mkdir(path.join(DIST, 'library'), { recursive: true });
await fsp.writeFile(path.join(DIST, 'library', 'index.json'), JSON.stringify(index));
console.log(`dist/ hotovo: ${ids.length} knih`);
