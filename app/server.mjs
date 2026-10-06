// Audioknihy – lokální server bez závislostí (stejné URL jako statický web na Vercelu).
//   node server.mjs                 → http://localhost:4321 (jen tento Mac)
//   HOST=0.0.0.0 node server.mjs    → dostupné i z mobilu v domácí Wi-Fi
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bookIdOk, bookIds, coverExt, indexEntry, mergedInsights, publicBook, readJson } from './lib/library.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY = process.env.LIBRARY || path.resolve(APP_DIR, '..');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(APP_DIR, 'public');
const DATA = path.join(APP_DIR, 'data');
const PROGRESS_FILE = path.join(DATA, 'progress.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.m4b': 'audio/mp4',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const notFound = (res) => json(res, 404, { error: 'not found' });
const bookDir = (id) => path.join(LIBRARY, id);
const hasLocalAudio = (id) => fs.existsSync(path.join(bookDir(id), 'audio'));
// Lokálně se vždy hraje z disku, ať je v book.json nastavený jakýkoli audioBase.
const localOpts = (id) => (hasLocalAudio(id) ? { audioBase: `/files/${id}/` } : {});

// ---- pozice poslechu --------------------------------------------------------
let progressWrite = Promise.resolve();
async function saveProgress(patch) {
  progressWrite = progressWrite.then(async () => {
    const all = (await readJson(PROGRESS_FILE, {})) || {};
    for (const [id, v] of Object.entries(patch)) all[id] = { ...(all[id] || {}), ...v, updated: Date.now() };
    await fsp.mkdir(DATA, { recursive: true });
    const tmp = PROGRESS_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(all, null, 2));
    await fsp.rename(tmp, PROGRESS_FILE);
    return all;
  });
  return progressWrite;
}

const readBody = (req, max = 64 * 1024) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

// ---- soubory s podporou Range (nutné pro přetáčení zvuku) --------------------
function sendFile(req, res, file, { cache = 'no-cache' } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      const start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
      const end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
}

// z knihovny se smí číst jen audio, přepisy a obálka – nic jiného.
const FILE_ALLOW = /^audio\/[^/]+\.(mp3|m4a|m4b)$/i;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = decodeURIComponent(url.pathname);
    const seg = p.split('/').filter(Boolean);

    if (p === '/api/progress') {
      if (req.method === 'GET') return json(res, 200, (await readJson(PROGRESS_FILE, {})) || {});
      if (req.method === 'PUT' || req.method === 'POST') {
        const patch = JSON.parse(await readBody(req));
        for (const id of Object.keys(patch)) if (!bookIdOk(id)) return json(res, 400, { error: 'bad id' });
        return json(res, 200, await saveProgress(patch));
      }
    }

    if (seg[0] === 'library') {
      if (p === '/library/index.json') {
        const ids = await bookIds(LIBRARY);
        return json(res, 200, await Promise.all(ids.map((id) => indexEntry(LIBRARY, id, localOpts(id)))));
      }
      const id = seg[1];
      if (!id || !bookIdOk(id)) return notFound(res);
      const raw = await readJson(path.join(bookDir(id), 'book.json'));
      if (!raw) return notFound(res);
      if (seg[2] === 'book.json') return json(res, 200, publicBook(raw, localOpts(id)));
      if (seg[2] === 'insights.json') return json(res, 200, await mergedInsights(LIBRARY, id));
      if (seg[2] === 'transcript' && /^\d+\.json$/.test(seg[3] || '')) return sendFile(req, res, path.join(bookDir(id), 'transcript', seg[3]));
      if (seg[2] && /^cover\.(jpe?g|png)$/.test(seg[2]) && raw.cover && seg[2].endsWith(coverExt(raw).slice(1))) {
        return sendFile(req, res, path.join(bookDir(id), raw.cover), { cache: 'public, max-age=86400' });
      }
      return notFound(res);
    }

    if (seg[0] === 'files' && seg[1] && bookIdOk(seg[1])) {
      const rel = seg.slice(2).join('/');
      if (!FILE_ALLOW.test(rel) || rel.includes('..')) return notFound(res);
      return sendFile(req, res, path.join(bookDir(seg[1]), rel), { cache: 'public, max-age=86400' });
    }

    // statický frontend
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return notFound(res);
    return sendFile(req, res, file);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Audioknihy běží:  http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    for (const addrs of Object.values(os.networkInterfaces()))
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  z mobilu v Wi-Fi: http://${a.address}:${PORT}`);
  }
  console.log(`Knihovna: ${LIBRARY}`);
});
