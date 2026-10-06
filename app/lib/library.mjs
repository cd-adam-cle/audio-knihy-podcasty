// Společná logika knihovny – používá ji lokální server i build statického webu (Vercel).
import fsp from 'node:fs/promises';
import path from 'node:path';

export const bookIdOk = (id) => /^[a-z0-9][a-z0-9._-]*$/i.test(id);

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

export async function bookIds(root) {
  const out = [];
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    if (e.isDirectory() && bookIdOk(e.name) && (await readJson(path.join(root, e.name, 'book.json')))) out.push(e.name);
  }
  return out.sort();
}

export const coverExt = (book) => (book.cover ? path.extname(book.cover).toLowerCase() : '');

// Tvar, v jakém knihu vidí prohlížeč (stejný lokálně i na webu).
export function publicBook(book, { audioBase } = {}) {
  return {
    ...book,
    cover: book.cover ? `/library/${book.id}/cover${coverExt(book)}` : null,
    audioBase: audioBase ?? book.audioBase ?? null,
  };
}

async function jsonNames(dir) {
  return (await fsp.readdir(dir).catch(() => [])).filter((f) => /^\d+\.json$/.test(f)).sort();
}

export async function mergedInsights(root, id) {
  const dir = path.join(root, id, 'insights');
  const chapters = {};
  for (const f of await jsonNames(dir)) {
    const d = await readJson(path.join(dir, f));
    if (d) chapters[f.replace('.json', '')] = d;
  }
  return { chapters, book: await readJson(path.join(dir, 'book.json')) };
}

export async function indexEntry(root, id, opts) {
  const raw = await readJson(path.join(root, id, 'book.json'));
  const b = publicBook(raw, opts);
  return {
    id: b.id, title: b.title, subtitle: b.subtitle, author: b.author, narrator: b.narrator,
    duration: b.duration, chapters: b.chapters.length, cover: b.cover,
    transcripts: (await jsonNames(path.join(root, id, 'transcript'))).length,
    insights: (await jsonNames(path.join(root, id, 'insights'))).length,
  };
}
