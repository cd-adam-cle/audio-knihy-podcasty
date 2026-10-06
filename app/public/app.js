// Audioknihy – přehrávač s přepisem, orientací v knize a poznatky
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad2 = (n) => String(n).padStart(2, '0');

const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
};
const fmtHM = (s) => { s = Math.floor(s / 60); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
const human = (s) => {
  const mins = Math.round(s / 60), h = Math.floor(mins / 60), m = mins % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
};
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const chId = (n) => pad2(n);

const audio = $('#audio');
const S = {
  books: [], book: null, ch: 1, t: 0, speed: 1, loading: false,
  insights: { chapters: {}, book: null }, transcripts: new Map(),
  viewCh: 1, follow: true, activeSeg: -1, open: new Set(), bookmarks: [],
  sleep: null, lastPersist: 0, lastRecap: 0, recapKey: '', tab: null,
};

// ------------------------------------------------------------------ API
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};
const getTranscript = (ch) => {
  const key = `${S.book.id}/${ch}`;
  if (!S.transcripts.has(key)) {
    const p = api(`/library/${S.book.id}/transcript/${chId(ch)}.json`).catch(() => null);
    S.transcripts.set(key, p);
    p.then((d) => { if (!d) S.transcripts.delete(key); });
  }
  return S.transcripts.get(key);
};

// ------------------------------------------------------------------ pozice
const LS = (id) => `audioknihy:${id}`;
function persist(force = false) {
  if (!S.book) return;
  const now = Date.now();
  if (!force && now - S.lastPersist < 5000) return;
  S.lastPersist = now;
  const rec = { ch: S.ch, t: Math.round(S.t * 10) / 10, speed: S.speed };
  try { localStorage.setItem(LS(S.book.id), JSON.stringify({ ...rec, updated: now })); } catch {}
  fetch('/api/progress', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [S.book.id]: rec }), keepalive: true,
  }).catch(() => {});
}
function saveBookmarks() {
  try { localStorage.setItem(LS(S.book.id) + ':marks', JSON.stringify(S.bookmarks)); } catch {}
  fetch('/api/progress', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [S.book.id]: { bookmarks: S.bookmarks } }), keepalive: true,
  }).catch(() => {});
}

// ------------------------------------------------------------------ pomocné k datům
const chapter = (n = S.ch) => S.book.chapters[n - 1];
const insightsOf = (n) => S.insights.chapters[chId(n)] || null;
const sectionsOf = (n) => insightsOf(n)?.sections || [];
function secIdx(n, t) {
  const s = sectionsOf(n); let i = -1;
  for (let k = 0; k < s.length; k++) { if (s[k].start <= t + 0.5) i = k; else break; }
  return i;
}
const gpos = () => chapter().offset + S.t;
// Zvuk: lokálně z disku (/files/<kniha>/), na webu z úložiště zadaného v book.json jako audioBase.
// Pokud je `file` celá URL (např. epizoda podcastu), hraje se rovnou z ní a nic se nikam nenahrává.
const audioUrl = (c) => (/^https?:\/\//.test(c.file) ? c.file : `${S.book.audioBase || `/files/${S.book.id}/`}${encodeURI(c.file)}`);

// ------------------------------------------------------------------ přehrávání
// Jediný posluchač metadat: nastaví pozici a případně spustí přehrávání podle POSLEDNÍ žádosti
// (rychlé přepínání kapitol tak nemůže použít zastaralé nastavení).
audio.addEventListener('loadedmetadata', () => {
  audio.currentTime = clamp(S.t, 0, Math.max(0, (audio.duration || chapter().duration) - 0.5));
  S.loading = false;
  if (S.wantPlay) audio.play().catch(() => {});
  S.wantPlay = false;
  tick(true);
});

function setChapter(n, t = 0, play = false, { save = true } = {}) {
  const c = S.book.chapters[n - 1];
  if (!c) return;
  t = clamp(t, 0, Math.max(0, c.duration - 0.5));
  const changed = S.ch !== n || !audio.getAttribute('src');
  S.t = t;
  if (changed) {
    S.ch = n; S.loading = true; S.activeSeg = -1; S.wantPlay = play;
    audio.src = audioUrl(c);
    audio.playbackRate = S.speed;
    if (S.viewCh !== n && S.follow) S.viewCh = n;
    S.open.add(n);
    onChapterChanged();
  } else if (S.loading) {
    S.wantPlay = S.wantPlay || play;
  } else {
    audio.currentTime = t;
    if (play) audio.play().catch(() => {});
  }
  tick(true);
  if (save) persist(true);
}
const seekBy = (d) => {
  const c = chapter(), target = S.t + d;
  if (target < 0 && S.ch > 1) return setChapter(S.ch - 1, chapter(S.ch - 1).duration + target, !audio.paused);
  if (target >= c.duration && S.ch < S.book.chapters.length) return setChapter(S.ch + 1, target - c.duration, !audio.paused);
  setChapter(S.ch, target, !audio.paused);
};
const seekGlobal = (sec, play) => {
  sec = clamp(sec, 0, S.book.duration - 1);
  const c = S.book.chapters.findLast((x) => x.offset <= sec) || S.book.chapters[0];
  setChapter(c.index, sec - c.offset, play ?? !audio.paused);
};
const togglePlay = () => (audio.paused ? audio.play().catch(() => {}) : audio.pause());
const prevChapter = () => (S.t > 5 || S.ch === 1 ? setChapter(S.ch, 0, !audio.paused) : setChapter(S.ch - 1, 0, !audio.paused));
const nextChapter = () => S.ch < S.book.chapters.length && setChapter(S.ch + 1, 0, !audio.paused);
function setSpeed(v) {
  S.speed = v; audio.playbackRate = v; audio.preservesPitch = true;
  $('#b-speed').textContent = `${v}×`;
  persist(true);
}

audio.addEventListener('play', () => { updatePlayBtn(); persist(true); });
audio.addEventListener('pause', () => { updatePlayBtn(); persist(true); renderRecap(true); audio.volume = 1; });
audio.addEventListener('ended', () => {
  if (S.sleep?.end) return clearSleep(true);
  if (S.ch < S.book.chapters.length) setChapter(S.ch + 1, 0, true);
  else updatePlayBtn();
});
audio.addEventListener('error', () => {
  if (audio.getAttribute('src')) toast(S.book?.audioBase ? 'Zvuk se nepodařilo načíst z úložiště.' : 'Zvuk není dostupný: kniha nemá nastavené úložiště zvuku (audioBase).');
});
audio.addEventListener('timeupdate', () => { if (!S.loading) { S.t = audio.currentTime; tick(); } });
audio.addEventListener('ratechange', () => { if (audio.playbackRate !== S.speed) audio.playbackRate = S.speed; });
addEventListener('pagehide', () => persist(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) persist(true); else loadInsights(); });

function updatePlayBtn() {
  const playing = !audio.paused;
  $('#b-play use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#b-play').setAttribute('aria-label', playing ? 'Pozastavit' : 'Přehrát');
  const rp = $('#recap-play');
  if (rp) rp.textContent = playing ? 'Pozastavit' : 'Pokračovat v poslechu';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

// ------------------------------------------------------------------ Media Session (zamčená obrazovka, sluchátka)
function onChapterChanged() {
  const c = chapter(), b = S.book;
  $('#ptitle').textContent = c.title;
  $('#pcover').src = b.cover || '';
  $('#pcover').style.visibility = b.cover ? 'visible' : 'hidden';
  document.title = `${c.title} · ${b.title}`;
  renderOrient();
  renderTextHeader();
  loadViewTranscript();
  renderRecap(true);
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: c.title, artist: b.author, album: b.title,
    artwork: b.cover ? [{ src: b.cover, sizes: '512x512', type: 'image/jpeg' }] : [],
  });
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  h('play', () => audio.play()); h('pause', () => audio.pause());
  h('seekbackward', (d) => seekBy(-(d.seekOffset || 15))); h('seekforward', (d) => seekBy(d.seekOffset || 30));
  h('previoustrack', prevChapter); h('nexttrack', nextChapter);
  h('seekto', (d) => setChapter(S.ch, d.seekTime, !audio.paused));
}

// ------------------------------------------------------------------ tick (UI každých ~250 ms)
let lastMS = 0;
function tick(force = false) {
  if (!S.book) return;
  const c = chapter(), dur = c.duration;
  if (!scrubbing) {
    $('#scrub').value = S.t; $('#scrub').max = dur;
    $('#scrub').style.setProperty('--p', `${(S.t / dur) * 100}%`);
    $('#tcur').textContent = fmt(S.t);
    $('#tleft').textContent = `-${fmt(Math.max(0, dur - S.t))}`;
  }
  const g = gpos(), total = S.book.duration;
  $('#w-left').innerHTML = `Kapitola <b>${c.index}/${S.book.chapters.length}</b> · ${esc(c.title)}`;
  $('#w-right').innerHTML = `${fmt(g)} / ${fmt(total)}<span class="rem"> · zbývá ${human(total - g)}</span>`;
  $$('.gseg').forEach((el, i) => {
    const n = i + 1, p = n < S.ch ? 100 : n === S.ch ? (S.t / dur) * 100 : 0;
    el.style.setProperty('--p', `${p}%`); el.classList.toggle('cur', n === S.ch);
  });
  const row = $(`.ch[data-ch="${S.ch}"]`);
  $$('.ch').forEach((el) => {
    const n = Number(el.dataset.ch);
    el.classList.toggle('done', n < S.ch); el.classList.toggle('cur', n === S.ch);
    el.querySelector('.ch-bar i').style.setProperty('--p', `${n < S.ch ? 100 : n === S.ch ? (S.t / dur) * 100 : 0}%`);
  });
  if (row) {
    const si = secIdx(S.ch, S.t);
    $$('.secs li', row).forEach((li, k) => li.classList.toggle('on', k === si));
  }
  highlightSegment(force);
  const now = Date.now();
  if (!audio.paused) {
    persist();
    if (now - S.lastRecap > 15000) renderRecap();
    if (now - lastMS > 1000 && 'mediaSession' in navigator) {
      lastMS = now;
      try { navigator.mediaSession.setPositionState({ duration: dur, position: clamp(S.t, 0, dur), playbackRate: S.speed }); } catch {}
    }
  }
  if (force) renderRecap(true);
  else {
    const key = `${S.ch}:${secIdx(S.ch, S.t)}`;
    if (key !== S.recapKey) renderRecap(true);
  }
}

// ------------------------------------------------------------------ globální časová osa v přehrávači
function buildGlobalBar() {
  const bar = $('#gbar');
  bar.innerHTML = S.book.chapters.map((c) =>
    `<div class="gseg" style="--d:${c.duration}" title="${esc(`${c.index}. ${c.title} · začíná v ${fmtHM(c.offset)}`)}"><i></i></div>`).join('');
}
function gbarSeek(ev) {
  const segs = $$('.gseg');
  const x = ev.clientX;
  let i = segs.findIndex((s) => { const r = s.getBoundingClientRect(); return x <= r.right + 1.5; });
  if (i < 0) i = segs.length - 1;
  const r = segs[i].getBoundingClientRect();
  const c = S.book.chapters[i];
  setChapter(c.index, clamp((x - r.left) / r.width, 0, 1) * c.duration, !audio.paused);
}
$('#gwrap').addEventListener('click', gbarSeek);

// scrubber kapitoly
let scrubbing = false;
const scrub = $('#scrub');
scrub.addEventListener('pointerdown', () => { scrubbing = true; });
scrub.addEventListener('input', () => {
  const v = Number(scrub.value), dur = chapter().duration;
  scrub.style.setProperty('--p', `${(v / dur) * 100}%`);
  $('#tcur').textContent = fmt(v); $('#tleft').textContent = `-${fmt(dur - v)}`;
});
scrub.addEventListener('change', () => { scrubbing = false; setChapter(S.ch, Number(scrub.value), !audio.paused); });
scrub.addEventListener('pointerup', () => { scrubbing = false; });

// ------------------------------------------------------------------ Orientace (levý panel)
function renderOrient() {
  const b = S.book, el = $('#p-orient');
  const books = S.books.length > 1
    ? `<select id="book-sel" aria-label="Kniha">${S.books.map((x) => `<option value="${esc(x.id)}" ${x.id === b.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select>` : '';
  el.innerHTML = `
    <div class="book-head">
      ${b.cover ? `<img src="${esc(b.cover)}" alt="">` : ''}
      <div><h1>${esc(b.title)}</h1><p>${esc(b.author)} · čte ${esc(b.narrator || '')}</p>${books}</div>
    </div>
    <div class="card recap" id="recap"></div>
    <div class="sect-title"><h2>Celá kniha</h2><span class="mono eyebrow">${human(b.duration)}</span></div>
    <div class="rail">${b.chapters.map(chapterRow).join('')}</div>`;
  $('#book-sel')?.addEventListener('change', (e) => loadBook(e.target.value));
  S.recapKey = '';
  renderRecap(true);
}
function chapterRow(c) {
  const ins = insightsOf(c.index), secs = ins?.sections || [];
  const open = S.open.has(c.index);
  return `<article class="ch ${open ? 'open' : ''}" data-ch="${c.index}">
    <div class="ch-time mono" title="Začátek kapitoly v čase celé knihy">${fmtHM(c.offset)}</div>
    <div class="ch-body">
      <button class="ch-main" data-play="${c.index}"><span class="ch-num">${chId(c.index)}</span><span class="ch-title">${esc(c.title)}</span><span class="ch-dur">${human(c.duration)}</span></button>
      ${ins?.oneLiner ? `<p class="ch-one">${esc(ins.oneLiner)}</p>` : ''}
      <div class="ch-bar"><i></i></div>
      ${secs.length ? `<button class="ch-toggle" data-toggle="${c.index}">${secs.length} částí<svg><use href="#i-chev"/></svg></button>
      <ul class="secs">${secs.map((s) => `<li data-ch="${c.index}" data-t="${s.start}"><span class="st">${fmt(s.start)}</span><span>${esc(s.title)}</span></li>`).join('')}</ul>` : ''}
    </div></article>`;
}
$('#p-orient').addEventListener('click', (e) => {
  const play = e.target.closest('[data-play]'), tog = e.target.closest('[data-toggle]'), li = e.target.closest('.secs li');
  if (li) return setChapter(Number(li.dataset.ch), Number(li.dataset.t), true);
  if (play) return setChapter(Number(play.dataset.play), 0, true);
  if (tog) { const n = Number(tog.dataset.toggle); S.open.has(n) ? S.open.delete(n) : S.open.add(n); tog.closest('.ch').classList.toggle('open'); }
  if (e.target.closest('#recap-play')) togglePlay();
  if (e.target.closest('#recap-back')) seekBy(-120);
  if (e.target.closest('#recap-sec')) { const i = secIdx(S.ch, S.t); if (i >= 0) setChapter(S.ch, sectionsOf(S.ch)[i].start, true); }
});

async function renderRecap(force = false) {
  const el = $('#recap');
  if (!el || !S.book) return;
  S.lastRecap = Date.now();
  const n = S.ch, c = chapter(), secs = sectionsOf(n), ins = insightsOf(n), i = secIdx(n, S.t);
  S.recapKey = `${n}:${i}`;
  const atStart = n === 1 && S.t < 5;
  const rows = [];
  if (ins) {
    if (i < 2 && n > 1) { const p = insightsOf(n - 1); if (p?.oneLiner) rows.push(['Z minulé kapitoly', chapter(n - 1).title, p.oneLiner, false]); }
    if (i >= 0) {
      for (const k of [i - 2, i - 1].filter((k) => k >= 0)) rows.push(['Předtím', secs[k].title, secs[k].summary, false]);
      rows.push(['Právě se řešilo', secs[i].title, secs[i].summary, true]);
    } else if (ins.summary) rows.push(['Kapitola', c.title, ins.summary, true]);
  }
  let quote = '';
  const tr = await getTranscript(n);
  if (tr && S.ch === n && S.t > 3) {
    const before = tr.segments.filter((s) => s.e <= S.t + 0.3 && s.s >= S.t - 90);
    quote = before.slice(-3).map((s) => s.t).join(' ');
  }
  if (S.ch !== n) return;
  el.innerHTML = `
    <div class="eyebrow">${atStart ? 'Začátek knihy' : 'Kde jsi skončil'}</div>
    <h2>${atStart ? esc(S.book.title) : `Kapitola ${n}: ${esc(c.title)}`}</h2>
    <div class="pos">${atStart ? esc(S.book.subtitle || '') : `<b class="mono">${fmt(S.t)}</b> z ${fmt(c.duration)} · v celé knize ${Math.round((gpos() / S.book.duration) * 100)} %, zbývá ${human(S.book.duration - gpos())}`}</div>
    ${rows.length ? `<ul class="recap-list">${rows.map(([k, t, x, now]) => `<li class="${now ? 'is-now' : ''}"><div class="k">${k}</div><div class="tt">${esc(t)}</div><div class="tx" title="${esc(x)}">${esc(x)}</div></li>`).join('')}</ul>`
      : atStart ? `<p class="tx" style="margin:0">${esc(S.book.description || '')}</p>` : (!ins ? `<p class="tx" style="margin:0;color:var(--muted)">Shrnutí této kapitoly se ještě připravuje.</p>` : '')}
    ${quote ? `<blockquote><span>Poslední věty, které jsi slyšel</span>${esc(quote)}</blockquote>` : ''}
    <div class="recap-actions">
      <button class="btn primary" id="recap-play">${audio.paused ? 'Pokračovat v poslechu' : 'Pozastavit'}</button>
      ${S.t > 20 ? `<button class="btn" id="recap-back">Vrátit o 2 min</button>` : ''}
      ${i > 0 || (i === 0 && S.t - secs[0].start > 20) ? `<button class="btn" id="recap-sec">Od začátku části</button>` : ''}
    </div>`;
}

// ------------------------------------------------------------------ Přepis
function renderTextHeader() {
  const el = $('#p-text');
  if (!$('#tsel', el)) {
    el.innerHTML = `<div class="tbar"><select id="tsel" aria-label="Kapitola"></select><button class="follow" id="tfollow">Sledovat přehrávání</button></div><div class="tscroll" id="tscroll"></div>`;
    $('#tsel').addEventListener('change', (e) => { S.viewCh = Number(e.target.value); S.follow = S.viewCh === S.ch; loadViewTranscript(); });
    $('#tfollow').addEventListener('click', () => { S.follow = true; if (S.viewCh !== S.ch) { S.viewCh = S.ch; loadViewTranscript(); } else scrollToActive(true); updateFollowBtn(); });
    const stop = () => { S.follow = false; updateFollowBtn(); };
    ['wheel', 'touchmove'].forEach((ev) => $('#tscroll').addEventListener(ev, stop, { passive: true }));
    $('#tscroll').addEventListener('click', (e) => {
      const seg = e.target.closest('.seg'); if (!seg) return;
      setChapter(S.viewCh, Number(seg.dataset.s), true); S.follow = true; updateFollowBtn();
    });
  }
  $('#tsel').innerHTML = S.book.chapters.map((c) => `<option value="${c.index}" ${c.index === S.viewCh ? 'selected' : ''}>${c.index}. ${esc(c.title)}</option>`).join('');
  updateFollowBtn();
}
const updateFollowBtn = () => $('#tfollow')?.classList.toggle('show', !S.follow || S.viewCh !== S.ch);

let viewToken = 0, retryTimer = null;
async function loadViewTranscript() {
  const box = $('#tscroll'); if (!box) return;
  const token = ++viewToken, n = S.viewCh;
  clearTimeout(retryTimer);
  $('#tsel').value = n;
  const tr = await getTranscript(n);
  if (token !== viewToken) return;
  S.activeSeg = -1;
  if (!tr) {
    box.innerHTML = `<div class="empty"><h3>Přepis této kapitoly se ještě zpracovává</h3><p>Počítá se lokálně na tomhle Macu. Stránka se sama obnoví, jakmile bude hotový.</p></div>`;
    retryTimer = setTimeout(loadViewTranscript, 15000);
    return;
  }
  const paras = []; let cur = [], len = 0;
  tr.segments.forEach((s, i) => {
    const prev = tr.segments[i - 1];
    if (cur.length && ((prev && s.s - prev.e > 1.1) || cur.length >= 6 || len > 520)) { paras.push(cur); cur = []; len = 0; }
    cur.push(i); len += s.t.length;
  });
  if (cur.length) paras.push(cur);
  box.innerHTML = paras.map((p) => `<p class="tpara"><span class="tp-t">${fmt(tr.segments[p[0]].s)}</span>${p.map((i) => `<span class="seg" data-i="${i}" data-s="${tr.segments[i].s}">${esc(tr.segments[i].t)}</span>`).join(' ')}</p>`).join('');
  box.scrollTop = 0;
  highlightSegment(true);
  updateFollowBtn();
}

function highlightSegment(force = false) {
  if (S.viewCh !== S.ch) return;
  const tr = S.transcripts.get(`${S.book.id}/${S.ch}`);
  if (!tr) return;
  tr.then((d) => {
    if (!d || S.viewCh !== S.ch) return;
    const segs = d.segments; let lo = 0, hi = segs.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].s <= S.t + 0.15) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx === S.activeSeg && !force) return;
    $('#tscroll .seg.on')?.classList.remove('on');
    S.activeSeg = idx;
    const el = idx >= 0 ? $(`#tscroll .seg[data-i="${idx}"]`) : null;
    el?.classList.add('on');
    if (el && S.follow) scrollToActive(force);
  });
}
function scrollToActive(force) {
  const box = $('#tscroll'), el = $('#tscroll .seg.on');
  if (!box || !el) return;
  const top = el.offsetTop - box.clientHeight * 0.35;
  box.scrollTo({ top, behavior: force || Math.abs(box.scrollTop - top) > box.clientHeight ? 'auto' : 'smooth' });
}

// ------------------------------------------------------------------ Poznatky
async function loadInsights() {
  if (!S.book) return;
  try {
    const d = await api(`/library/${S.book.id}/insights.json`);
    const changed = JSON.stringify(Object.keys(d.chapters)) !== JSON.stringify(Object.keys(S.insights.chapters)) || JSON.stringify(d.book) !== JSON.stringify(S.insights.book);
    S.insights = d;
    if (changed) { renderOrient(); renderInsights(); }
  } catch {}
}
function renderInsights() {
  const el = $('#p-insights'), b = S.book, bi = S.insights.book;
  const done = Object.keys(S.insights.chapters).length;
  const marks = S.bookmarks.length ? `
    <section><h2>Moje záložky</h2><ul class="marks">${S.bookmarks.map((m, i) => `<li data-ch="${m.ch}" data-t="${m.t}"><span class="st">${m.ch}. kap. ${fmt(m.t)}</span><span>${esc(m.text)}</span><button class="del" data-del="${i}" aria-label="Smazat záložku"><svg><use href="#i-x"/></svg></button></li>`).join('')}</ul></section>` : '';
  const bookPart = bi ? `<section><h2>Kniha ve zkratce</h2>${bi.summary ? `<p class="lead">${esc(bi.summary)}</p>` : ''}
    ${bi.keyIdeas?.length ? `<ul class="tk">${bi.keyIdeas.map((k) => `<li>${k.title ? `<b style="color:var(--ink);font-weight:500">${esc(k.title)}.</b> ` : ''}${esc(k.text)}</li>`).join('')}</ul>` : ''}</section>` : '';
  const chapters = b.chapters.map((c) => {
    const ins = insightsOf(c.index);
    if (!ins) return `<details><summary><span class="n">${chId(c.index)}</span><span class="tt">${esc(c.title)}</span><span class="tag pending">připravuje se</span></summary></details>`;
    return `<details ${c.index === S.ch ? 'open' : ''}><summary><span class="n">${chId(c.index)}</span><span class="tt">${esc(c.title)}</span><svg><use href="#i-chev"/></svg></summary>
      <div class="body">
        ${ins.summary ? `<p class="lead">${esc(ins.summary)}</p>` : ''}
        ${ins.takeaways?.length ? `<h4>Poznatky</h4><ul class="tk">${ins.takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        ${ins.sections?.length ? `<h4>Průvodce kapitolou</h4><ul class="secs" style="display:block">${ins.sections.map((s) => `<li data-ch="${c.index}" data-t="${s.start}"><span class="st">${fmt(s.start)}</span><span><b style="color:var(--ink);font-weight:500">${esc(s.title)}</b><br>${esc(s.summary || '')}</span></li>`).join('')}</ul>` : ''}
        ${ins.terms?.length ? `<h4>Pojmy</h4><dl class="terms">${ins.terms.map((t) => `<div><dt>${esc(t.term)}</dt><dd>${esc(t.def)}</dd></div>`).join('')}</dl>` : ''}
      </div></details>`;
  }).join('');
  el.innerHTML = `<div class="ins">${marks}${bookPart}<section><h2>Kapitoly</h2>${done < b.chapters.length ? `<p class="empty" style="margin:0 0 14px">Shrnutí hotové pro ${done} z ${b.chapters.length} kapitol.</p>` : ''}${chapters}</section></div>`;
}
$('#p-insights').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); S.bookmarks.splice(Number(del.dataset.del), 1); saveBookmarks(); return renderInsights(); }
  const li = e.target.closest('li[data-t]');
  if (li) setChapter(Number(li.dataset.ch), Number(li.dataset.t), true);
});

async function addBookmark() {
  const tr = await getTranscript(S.ch);
  let text = '';
  if (tr) { const s = [...tr.segments].reverse().find((x) => x.s <= S.t); text = s?.t || ''; }
  if (!text) { const i = secIdx(S.ch, S.t); text = i >= 0 ? sectionsOf(S.ch)[i].title : chapter().title; }
  S.bookmarks.push({ ch: S.ch, t: Math.floor(S.t), text, created: Date.now() });
  S.bookmarks.sort((a, b) => chapter(a.ch).offset + a.t - (chapter(b.ch).offset + b.t));
  saveBookmarks(); renderInsights(); toast(`Záložka uložena na ${fmt(S.t)}`);
}

// ------------------------------------------------------------------ Hledání
// Přepisy se při prvním hledání stáhnou všechny (stovky kB) a prohledává se přímo v prohlížeči.
async function searchBook(q, limit = 60) {
  const needle = fold(q.trim());
  if (needle.length < 2) return [];
  const all = await Promise.all(S.book.chapters.map((c) => getTranscript(c.index)));
  const hits = [];
  for (let k = 0; k < all.length; k++) {
    const segs = all[k]?.segments || [];
    for (const sg of segs) {
      if (fold(sg.t).includes(needle)) {
        hits.push({ chapter: k + 1, time: sg.s, text: sg.t });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}
function renderSearch() {
  const el = $('#p-search');
  el.innerHTML = `<div class="sbox"><svg><use href="#i-search"/></svg><input id="q" type="search" placeholder="Hledat v celé knize, například „zrcadlení“" autocomplete="off" aria-label="Hledat v přepisu"></div><ul class="hits" id="hits"></ul><p class="empty" id="hits-info" style="margin-top:14px"></p>`;
  let timer, token = 0;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    timer = setTimeout(async () => {
      const my = ++token;
      if (q.length < 2) { $('#hits').innerHTML = ''; $('#hits-info').textContent = ''; return; }
      const hits = await searchBook(q);
      if (my !== token) return;
      const fq = fold(q);
      $('#hits-info').textContent = hits.length ? (hits.length >= 60 ? 'Zobrazeno prvních 60 výsledků.' : '') : 'Nic nenalezeno. Přepisy poslední kapitol se možná ještě zpracovávají.';
      $('#hits').innerHTML = hits.map((h) => {
        const i = fold(h.text).indexOf(fq);
        const t = i >= 0 ? `${esc(h.text.slice(0, i))}<mark>${esc(h.text.slice(i, i + fq.length))}</mark>${esc(h.text.slice(i + fq.length))}` : esc(h.text);
        return `<li data-ch="${h.chapter}" data-t="${h.time}"><span class="loc">${h.chapter}. kap. · ${fmt(h.time)}</span><span class="tx">${t}</span></li>`;
      }).join('');
    }, 250);
  });
  $('#hits').addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (li) setChapter(Number(li.dataset.ch), Math.max(0, Number(li.dataset.t) - 1), true);
  });
}

// ------------------------------------------------------------------ záložky v hlavním rozvržení
const tabs = $('#tabs');
function showTab(name) {
  S.tab = name;
  $$('button', tabs).forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `p-${name}`));
  if (name === 'insights') loadInsights();
  if (name === 'search') $('#q')?.focus({ preventScroll: true });
  if (name === 'text') requestAnimationFrame(() => scrollToActive(true));
}
tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
const mq = matchMedia('(max-width: 899px)');
mq.addEventListener('change', () => { if (S.tab === 'orient' && !mq.matches) showTab('text'); });

// ------------------------------------------------------------------ menu (rychlost, spánek) a toast
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; }
function openMenu(anchor, items) {
  closeMenu();
  menuEl = document.createElement('div'); menuEl.className = 'menu'; menuEl.setAttribute('role', 'menu');
  menuEl.innerHTML = items.map((it, i) => `<button role="menuitem" data-i="${i}" class="${it.on ? 'on' : ''}">${esc(it.label)}${it.on ? '<svg><use href="#i-check"/></svg>' : ''}</button>`).join('');
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect(), w = menuEl.offsetWidth;
  menuEl.style.bottom = `${innerHeight - r.top + 8}px`;
  menuEl.style.left = `${clamp(r.right - w, 8, innerWidth - w - 8)}px`;
  menuEl.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { items[Number(b.dataset.i)].run(); closeMenu(); } });
  setTimeout(() => document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, { once: true }), 0);
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
$('#b-speed').addEventListener('click', (e) => openMenu(e.currentTarget, SPEEDS.map((v) => ({ label: `${v}×`, on: v === S.speed, run: () => setSpeed(v) }))));

function setSleep(opt) {
  clearSleep();
  if (opt === 'end') S.sleep = { end: true };
  else if (opt) S.sleep = { until: Date.now() + opt * 60000 };
  updateSleepLabel();
}
function clearSleep(fire = false) {
  if (fire) { audio.pause(); toast('Časovač: přehrávání zastaveno'); }
  S.sleep = null; audio.volume = 1; updateSleepLabel();
}
function updateSleepLabel() {
  const l = $('#sleep-l');
  l.textContent = !S.sleep ? '' : S.sleep.end ? 'kap.' : `${Math.max(1, Math.ceil((S.sleep.until - Date.now()) / 60000))}m`;
}
setInterval(() => {
  if (!S.sleep?.until) return;
  const left = S.sleep.until - Date.now();
  if (left <= 0) return clearSleep(true);
  if (left < 10000) audio.volume = clamp(left / 10000, 0, 1);
  updateSleepLabel();
}, 1000);
$('#b-sleep').addEventListener('click', (e) => openMenu(e.currentTarget, [
  { label: 'Vypnuto', on: !S.sleep, run: () => setSleep(null) },
  ...[15, 30, 45, 60].map((m) => ({ label: `${m} min`, run: () => setSleep(m) })),
  { label: 'Na konci kapitoly', on: !!S.sleep?.end, run: () => setSleep('end') },
]));

$('#b-play').addEventListener('click', togglePlay);
$('#b-back').addEventListener('click', () => seekBy(-15));
$('#b-fwd').addEventListener('click', () => seekBy(30));
$('#b-prev').addEventListener('click', prevChapter);
$('#b-next').addEventListener('click', nextChapter);
$('#b-mark').addEventListener('click', addBookmark);

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range') return;
  if (e.target.closest?.('button') && e.code === 'Space') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); seekBy(-15); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); seekBy(30); }
  else if (e.key === 'b') addBookmark();
});

// výška přehrávače → odsazení obsahu
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--player-h', `${Math.ceil(e.target.getBoundingClientRect().height)}px`)).observe($('#player'));

// ------------------------------------------------------------------ start
async function loadBook(id) {
  audio.pause();
  const [book, ins, progress] = await Promise.all([
    api(`/library/${id}/book.json`), api(`/library/${id}/insights.json`).catch(() => ({ chapters: {}, book: null })), api('/api/progress').catch(() => ({})),
  ]);
  S.book = book; S.insights = ins; S.transcripts.clear();
  let rec = progress[id] || {};
  try { const l = JSON.parse(localStorage.getItem(LS(id)) || 'null'); if (l && (l.updated || 0) > (rec.updated || 0)) rec = { ...rec, ...l }; } catch {}
  try { const m = JSON.parse(localStorage.getItem(LS(id) + ':marks') || 'null'); S.bookmarks = rec.bookmarks || m || []; } catch { S.bookmarks = rec.bookmarks || []; }
  S.speed = rec.speed || 1; $('#b-speed').textContent = `${S.speed}×`;
  const ch = clamp(rec.ch || 1, 1, book.chapters.length);
  S.viewCh = ch; S.follow = true; S.open = new Set([ch]);
  buildGlobalBar();
  audio.removeAttribute('src');
  renderTextHeader(); renderInsights();
  setChapter(ch, rec.t || 0, false, { save: false });
  updatePlayBtn();
}
async function init() {
  S.books = await api('/library/index.json');
  if (!S.books.length) { $('#p-orient').innerHTML = '<p class="empty">V knihovně zatím není žádná kniha.</p>'; return; }
  const progress = await api('/api/progress').catch(() => ({}));
  const last = [...S.books].sort((a, b) => (progress[b.id]?.updated || 0) - (progress[a.id]?.updated || 0))[0];
  renderSearch(); setupMediaSession();
  showTab(mq.matches ? 'orient' : 'text');
  await loadBook(last.id);
  setInterval(loadInsights, 60000);
}
init().catch((e) => { console.error(e); $('#p-orient').innerHTML = `<p class="empty">Nepodařilo se načíst knihovnu: ${esc(e.message)}</p>`; });
