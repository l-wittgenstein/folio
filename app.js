import * as pdfjsLib from './pdf.min.mjs';
import { store, takeInbox, saveSoon, flushSaves } from './store.js';
import { Reflower, blocksToHTML, guessLang } from './reflow.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
const CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const PDF_OPTS = {
  cMapUrl: CDN + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: CDN + 'standard_fonts/',
  isEvalSupported: false,
};

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICON_MORE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/* ---------------- Settings ---------------- */
const DEFAULTS = {
  theme: 'auto', bright: 100, awake: true, full: false, anim: true,
  size: 18, font: 'serif', lh: 1.55, scroll: false, status: 0, sort: 'recent',
  hintTaps: false, hintText: false,
};
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('folio.settings') || '{}')); } catch {}
function saveSettings() {
  try { localStorage.setItem('folio.settings', JSON.stringify(settings)); } catch {}
}
const SIZES = [14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28, 32];

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------------- Back-button layers ---------------- */
// Each open layer (reader, sheet) gets a history entry so Android's back gesture closes it.
const layers = [];
function pushLayer(close) {
  layers.push(close);
  history.pushState({ folio: layers.length }, '');
}
function popLayer() {
  if (layers.length) history.back();
}
addEventListener('popstate', () => {
  const close = layers.pop();
  if (close) close();
});

/* ---------------- Theme ---------------- */
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function readerTheme() {
  return settings.theme === 'auto' ? (darkMQ.matches ? 'night' : 'paper') : settings.theme;
}
function applyTheme() {
  if (R.book) document.body.dataset.r = readerTheme();
  else delete document.body.dataset.r;
  const v = getComputedStyle(document.body).getPropertyValue(R.book ? '--r-bg' : '--bg').trim();
  if (v) $('themeColor').setAttribute('content', v);
}
darkMQ.addEventListener('change', applyTheme);

/* ================================================================
   Library
   ================================================================ */
let books = [];
const coverURLs = new Map();
function coverURL(b) {
  if (!b.cover) return null;
  if (!coverURLs.has(b.id)) coverURLs.set(b.id, URL.createObjectURL(b.cover));
  return coverURLs.get(b.id);
}
function progressOf(b) {
  if (!b.pages) return 0;
  if (b.finished) return 1;
  if (b.pages <= 1) return clamp(b.frac || 0, 0, 1);
  return clamp(((b.page || 1) - 1 + (b.frac || 0)) / (b.pages - 1), 0, 1);
}

async function refreshLibrary() {
  try { books = await store.allBooks(); } catch { books = []; }
  renderLibrary();
}

function renderLibrary() {
  const has = books.length > 0;
  $('empty').hidden = has;
  $('shelfSection').hidden = !has;

  const recent = books.filter((b) => b.openedAt && !b.finished).sort((a, b) => b.openedAt - a.openedAt)[0];
  const cont = $('continue');
  if (recent) {
    const p = Math.round(progressOf(recent) * 100);
    const url = coverURL(recent);
    cont.hidden = false;
    cont.innerHTML = `
      <button type="button" class="continue-card" data-id="${esc(recent.id)}">
        <div class="cover">${url ? `<img src="${url}" alt="">` : `<div class="placeholder">${esc(recent.title)}</div>`}</div>
        <div class="continue-body">
          <span class="eyebrow">Continue reading</span>
          <h2 class="continue-title">${esc(recent.title)}</h2>
          ${recent.author ? `<span class="continue-author">${esc(recent.author)}</span>` : ''}
          <div class="continue-progress">
            <div class="bar" style="--p:${p}%"><i></i></div>
            <span class="continue-meta">${p}% · Page ${recent.page} of ${recent.pages}</span>
          </div>
        </div>
      </button>`;
  } else {
    cont.hidden = true;
    cont.innerHTML = '';
  }

  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
  const byRecent = (a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt);
  const sorted = [...books].sort(settings.sort === 'title' ? byTitle : byRecent);
  $('sortBtn').textContent = settings.sort === 'title' ? 'Title' : 'Recent';
  $('shelf').innerHTML = sorted.map((b) => {
    const p = progressOf(b);
    const url = coverURL(b);
    const label = b.finished ? 'Finished' : !b.openedAt ? 'New' : `${Math.max(1, Math.round(p * 100))}%`;
    return `
      <li class="book" data-id="${esc(b.id)}">
        <button type="button" class="book-open">
          <div class="cover" style="--p:${b.openedAt ? Math.round(p * 100) : 0}%">
            ${url ? `<img src="${url}" alt="" loading="lazy">` : `<div class="placeholder">${esc(b.title)}</div>`}
            <span class="strip"></span>
          </div>
          <div class="book-title">${esc(b.title)}</div>
        </button>
        <div class="book-meta">
          <span class="${b.finished ? 'done' : ''}">${label}</span>
          <button type="button" class="more-btn" aria-label="Options for ${esc(b.title)}">${ICON_MORE}</button>
        </div>
      </li>`;
  }).join('');
}

$('continue').addEventListener('click', (e) => {
  const card = e.target.closest('.continue-card');
  if (card) openBook(card.dataset.id);
});
$('shelf').addEventListener('click', (e) => {
  const li = e.target.closest('.book');
  if (!li) return;
  if (e.target.closest('.more-btn')) openBookSheet(li.dataset.id);
  else if (e.target.closest('.book-open')) openBook(li.dataset.id);
});
$('shelf').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('.book');
  if (!li) return;
  e.preventDefault();
  openBookSheet(li.dataset.id);
});
$('sortBtn').addEventListener('click', () => {
  settings.sort = settings.sort === 'title' ? 'recent' : 'title';
  saveSettings();
  renderLibrary();
});

/* ---------------- Book details sheet ---------------- */
function openBookSheet(id) {
  const b = books.find((x) => x.id === id);
  if (!b) return;
  const body = $('bookSheetBody');
  const added = new Date(b.addedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const mb = (b.size / 1048576).toFixed(b.size > 10485760 ? 0 : 1);
  const actions = () => `
    <h3 class="book-sheet-title">${esc(b.title)}</h3>
    <p class="book-sheet-meta">${b.author ? esc(b.author) + ' · ' : ''}${b.pages} pages · ${mb} MB · Added ${esc(added)}</p>
    <button type="button" class="action" data-act="open">Open</button>
    ${b.openedAt ? '<button type="button" class="action" data-act="restart">Start from the beginning</button>' : ''}
    <button type="button" class="action danger" data-act="remove">Remove from library</button>`;
  body.innerHTML = actions();
  body.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'open') {
      popLayer();
      setTimeout(() => openBook(b.id), 60);
    } else if (act === 'restart') {
      Object.assign(b, { page: 1, frac: 0, finished: false });
      await store.putBook(b);
      popLayer();
      renderLibrary();
      toast('Back to page 1');
    } else if (act === 'remove') {
      body.querySelectorAll('.action').forEach((el) => { el.hidden = true; });
      body.insertAdjacentHTML('beforeend', `
        <div class="confirm">
          <p>Remove “${esc(b.title)}”? Its file, bookmarks and reading position will be deleted from Folio.</p>
          <div class="confirm-row">
            <button type="button" class="cancel" data-act="cancel">Keep</button>
            <button type="button" class="remove" data-act="confirm">Remove</button>
          </div>
        </div>`);
    } else if (act === 'cancel') {
      body.innerHTML = actions();
    } else if (act === 'confirm') {
      await store.removeBook(b.id);
      const url = coverURLs.get(b.id);
      if (url) { URL.revokeObjectURL(url); coverURLs.delete(b.id); }
      popLayer();
      await refreshLibrary();
      toast('Removed');
    }
  };
  openSheet('bookSheet');
}

/* ---------------- Sheets ---------------- */
function openSheet(id, onClose) {
  const el = $(id);
  el.hidden = false;
  el.style.transform = '';
  $('scrim').hidden = false;
  pushLayer(() => {
    el.hidden = true;
    $('scrim').hidden = true;
    onClose?.();
  });
}
$('scrim').addEventListener('click', popLayer);

// Drag a sheet down to dismiss it.
for (const sheet of document.querySelectorAll('.sheet')) {
  let y0 = null;
  let dy = 0;
  sheet.addEventListener('touchstart', (e) => {
    const body = sheet.querySelector('.sheet-body');
    const onHandle = !e.target.closest('.sheet-body') || body.scrollTop <= 0;
    const onControl = e.target.closest('input[type="range"]');
    y0 = onHandle && !onControl ? e.touches[0].clientY : null;
    dy = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    if (dy > 90) popLayer();
    else sheet.style.transform = '';
  });
}

/* ---------------- Importing ---------------- */
function cleanTitle(t) {
  t = (t || '').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 160) return null;
  if (/^(untitled|microsoft (word|powerpoint)|document\d*|title|unknown|none|pdf|print)\b/i.test(t)) return null;
  if (/\.(docx?|pdf|indd|tex|dvi|ps|rtf|odt|pages|qxd|pptx?)$/i.test(t)) return null;
  if (/^[\w-]+\.\w{2,4}$/.test(t) || /^[\d\W_]+$/.test(t)) return null;
  return t;
}
function cleanAuthor(a) {
  a = (a || '').replace(/\s+/g, ' ').trim();
  if (a.length < 2 || a.length > 100 || /^(user|admin|owner|unknown|author)$/i.test(a)) return null;
  return a;
}
function titleFromName(name) {
  return (name || 'Untitled').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}
async function fingerprint(buf) {
  try {
    const head = buf.slice(0, 4 * 1024 * 1024);
    const sizeBytes = new TextEncoder().encode(':' + buf.byteLength);
    const merged = new Uint8Array(head.byteLength + sizeBytes.byteLength);
    merged.set(new Uint8Array(head), 0);
    merged.set(sizeBytes, head.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', merged);
    return [...new Uint8Array(digest)].slice(0, 12).map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'b' + buf.byteLength.toString(36) + Date.now().toString(36);
  }
}
async function renderCover(pdf) {
  const page = await pdf.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 320 / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.84));
}
function importError(e, name) {
  if (e?.name === 'PasswordException') return `“${name}” is password-protected. Folio can't open it yet.`;
  if (e?.name === 'InvalidPDFException') return `“${name}” doesn't look like a valid PDF.`;
  return `Couldn't add “${name}”. ${e?.message || ''}`.trim();
}

async function importOne(file) {
  const buf = await file.arrayBuffer();
  const id = await fingerprint(buf);
  if (await store.getBook(id)) return id;
  const name = file.name || 'Document.pdf';
  toast(`Adding “${titleFromName(name)}”…`, 20000);
  const pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(buf.slice(0)) }).promise;
  try {
    let title = null;
    let author = null;
    try {
      const meta = await pdf.getMetadata();
      title = cleanTitle(meta?.info?.Title);
      author = cleanAuthor(meta?.info?.Author);
    } catch {}
    const cover = await renderCover(pdf).catch(() => null);
    const book = {
      id, title: title || titleFromName(name), author, name, size: buf.byteLength,
      pages: pdf.numPages, addedAt: Date.now(), openedAt: 0, page: 1, frac: 0,
      view: null, trim: true, bookmarks: [], spp: null, samples: 0, cover, crop: null,
      finished: false, lang: null,
    };
    await store.putFile(id, new Blob([buf], { type: 'application/pdf' }));
    await store.putBook(book);
    navigator.storage?.persist?.().catch(() => {});
    $('toast').hidden = true;
    return id;
  } finally {
    pdf.destroy();
  }
}

async function importFiles(files, { open = false } = {}) {
  let lastId = null;
  let added = 0;
  for (const f of files) {
    if (!f) continue;
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
    if (!isPdf) { toast(`“${f.name}” isn't a PDF.`); continue; }
    try {
      lastId = await importOne(f);
      added++;
    } catch (e) {
      console.error(e);
      toast(importError(e, f.name || 'This file'), 5000);
    }
  }
  await refreshLibrary();
  if (open && lastId && added === 1) openBook(lastId);
  else if (added > 1) toast(`Added ${added} books`);
  return lastId;
}

const picker = $('picker');
const pick = () => picker.click();
$('addBtn').addEventListener('click', pick);
$('emptyAdd').addEventListener('click', pick);
picker.addEventListener('change', () => {
  const files = [...picker.files];
  picker.value = '';
  if (files.length) importFiles(files, { open: files.length === 1 });
});

/* ================================================================
   Reader
   ================================================================ */
const R = {
  book: null, pdf: null, reflow: null, token: 0,
  n: 1, k: 0, screens: 1, view: 'page', zoom: 1,
  frac: 0, atEnd: false, sFirst: 1, sLast: 1, sgen: 0, marks: [],
  cache: new Map(), boxes: new Map(),
  toc: [], chapters: [], jumpFrom: null, shownAt: 0, busy: false, hasText: true,
};
const reader = $('reader');
const stage = $('stage');
const pageWrap = $('pageWrap');
const textWrap = $('textWrap');
const flow = $('flow');
const N = () => R.pdf?.numPages || 1;
const PAD_X = 12;
const PAD_Y = 12;

function setLoading(on) { $('loading').hidden = !on; }

async function openBook(id) {
  if (R.book) return;
  const book = await store.getBook(id);
  const blob = await store.getFile(id);
  if (!book || !blob) {
    toast("This book's file is missing. Remove it and add the PDF again.", 4000);
    return;
  }
  const token = ++R.token;
  Object.assign(R, {
    book, n: clamp(book.page || 1, 1, book.pages || 1), k: 0, screens: 1, zoom: 1,
    frac: book.frac || 0, atEnd: false, marks: [], sgen: R.sgen + 1,
    // Busy until the first screen is shown, so stray scroll events can't move the saved position.
    cache: new Map(), boxes: new Map(), toc: [], chapters: [], jumpFrom: null, busy: true,
  });
  const startFrac = book.frac || 0;
  R.view = book.view || 'page';
  reader.dataset.view = R.view;
  reader.classList.remove('chrome-on');
  pageWrap.replaceChildren();
  pageWrap.classList.remove('zoomed');
  flow.innerHTML = '';
  $('library').hidden = true;
  reader.hidden = false;
  document.body.classList.add('reading');
  applyTheme();
  applyBright();
  applyTextStyle();
  pushLayer(closeReader);
  if (settings.full) document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  requestWake();
  setLoading(true);
  updateStatus();

  try {
    R.pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  } catch (e) {
    console.error(e);
    if (token === R.token) {
      toast(importError(e, book.title), 4000);
      popLayer();
    }
    return;
  }
  if (token !== R.token) { R.pdf?.destroy(); return; }
  R.reflow = new Reflower(R.pdf);
  book.pages = R.pdf.numPages;
  R.n = clamp(book.page || 1, 1, book.pages);

  loadOutline(token);
  await inspectText(token);
  if (token !== R.token) return;
  if (book.trim !== false && !book.crop) book.crop = await computeCrop();
  if (token !== R.token) return;

  let hinted = false;
  if (!book.view) {
    book.view = await chooseView();
    if (book.view === 'text' && !settings.hintText) {
      hinted = true;
      settings.hintText = true;
      saveSettings();
      setTimeout(() => toast('Showing Text view for larger type. Switch to Page view under Display.', 5000), 600);
    }
  }
  R.view = book.view;
  reader.dataset.view = R.view;
  book.openedAt = Date.now();
  saveSoon(book);

  try { await document.fonts.load(`${settings.size}px Literata`); } catch {}
  if (scrollMode()) await showScroll(R.n, startFrac);
  else if (R.view === 'text') await showText(R.n, { frac: startFrac });
  else await showPage(R.n, 0);
  if (token !== R.token) return;
  R.busy = false;
  setLoading(false);
  afterMove();

  if (!settings.hintTaps) {
    settings.hintTaps = true;
    saveSettings();
    const wait = hinted ? 6200 : 0;
    setTimeout(() => { if (R.book) toast('Tap the right edge to turn the page, the middle for controls.', 4500); }, wait);
  }
}

function closeReader() {
  R.token++;
  if (R.book) flushSaves(R.book);
  releaseWake();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  R.pdf?.destroy();
  Object.assign(R, { book: null, pdf: null, reflow: null, cache: new Map(), boxes: new Map(), marks: [], sgen: R.sgen + 1 });
  pageWrap.replaceChildren();
  flow.innerHTML = '';
  reader.hidden = true;
  reader.classList.remove('chrome-on');
  $('library').hidden = false;
  document.body.classList.remove('reading');
  setLoading(false);
  applyTheme();
  refreshLibrary();
}

/* ---------------- Text detection & view choice ---------------- */
async function inspectText(token) {
  const n = Math.max(1, Math.ceil(N() / 2));
  try {
    const raw = await R.reflow.rawPage(n);
    if (token !== R.token) return;
    const text = raw.runs.map((r) => r.str).join(' ');
    R.hasText = text.replace(/\s/g, '').length > 80;
    if (!R.book.lang) R.book.lang = guessLang(text);
    flow.lang = R.book.lang || navigator.language || 'en';
  } catch {
    R.hasText = false;
  }
}

async function chooseView() {
  if (!R.hasText) return 'page';
  const n = N();
  const picks = [...new Set([0.3, 0.5, 0.7].map((f) => clamp(Math.round(n * f), 1, n)))];
  let chars = 0;
  const sizes = [];
  for (const p of picks) {
    const raw = await R.reflow.rawPage(p);
    for (const r of raw.runs) {
      chars += r.str.length;
      if (r.str.trim().length > 3) sizes.push(r.size);
    }
  }
  if (chars / picks.length < 700) return 'page';
  sizes.sort((a, b) => a - b);
  const bodyPt = sizes[Math.floor(sizes.length / 2)] || 10;
  const page = await R.pdf.getPage(picks[0]);
  const vp = page.getViewport({ scale: 1 });
  const crop = await cropFor(picks[0]);
  const { w, h } = stageSize();
  const fit = Math.min((w - 2 * PAD_X) / (vp.width * (crop.x1 - crop.x0)), (h - 2 * PAD_Y) / (vp.height * (crop.y1 - crop.y0)));
  return bodyPt * fit < 11.5 ? 'text' : 'page';
}

/* ---------------- Margin trimming ---------------- */
function scanBox(data, w, h) {
  const rows = new Uint16Array(h);
  const cols = new Uint16Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11 < 215) { rows[y]++; cols[x]++; }
    }
  }
  let y0 = 0; while (y0 < h && rows[y0] === 0) y0++;
  if (y0 >= h) return null;
  let y1 = h - 1; while (y1 > y0 && rows[y1] === 0) y1--;
  let x0 = 0; while (x0 < w && cols[x0] === 0) x0++;
  let x1 = w - 1; while (x1 > x0 && cols[x1] === 0) x1--;
  return { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h, rows };
}

function pageBox(n) {
  if (!R.boxes.has(n)) {
    R.boxes.set(n, (async () => {
      const page = await R.pdf.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 150 / vp1.width });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return scanBox(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    })().catch(() => null));
  }
  return R.boxes.get(n);
}

// A typical text block for odd and even pages, so every page keeps the same scale.
async function computeCrop() {
  const n = N();
  if (n < 1) return null;
  const first = n > 3 ? 2 : 1;
  const count = Math.min(14, n - first + 1);
  const picks = [...new Set(Array.from({ length: count }, (_, i) => Math.round(first + (i * (n - first)) / Math.max(1, count - 1))))];
  const odd = [];
  const even = [];
  for (const p of picks) {
    const b = await pageBox(p);
    if (b && (b.x1 - b.x0) > 0.2 && (b.y1 - b.y0) > 0.2) (p % 2 ? odd : even).push(b);
  }
  const q = (arr, key, p) => {
    const s = arr.map((b) => b[key]).sort((a, b) => a - b);
    return s[Math.round((s.length - 1) * p)];
  };
  const combine = (arr) => (arr.length ? { x0: q(arr, 'x0', 0.15), y0: q(arr, 'y0', 0.15), x1: q(arr, 'x1', 0.85), y1: q(arr, 'y1', 0.85) } : null);
  const all = combine([...odd, ...even]);
  if (!all) return null;
  return { odd: odd.length >= 2 ? combine(odd) : all, even: even.length >= 2 ? combine(even) : all };
}

async function cropFor(n) {
  const full = { x0: 0, y0: 0, x1: 1, y1: 1 };
  if (R.book.trim === false || !R.book.crop) return full;
  const g = R.book.crop[n % 2 ? 'odd' : 'even'] || full;
  const b = await pageBox(n);
  const u = b ? { x0: Math.min(g.x0, b.x0), y0: Math.min(g.y0, b.y0), x1: Math.max(g.x1, b.x1), y1: Math.max(g.y1, b.y1) } : g;
  const pad = 0.018;
  return { x0: Math.max(0, u.x0 - pad), y0: Math.max(0, u.y0 - pad), x1: Math.min(1, u.x1 + pad), y1: Math.min(1, u.y1 + pad) };
}

/* ---------------- Page rendering ---------------- */
function stageSize() {
  const r = stage.getBoundingClientRect();
  return { w: r.width || innerWidth, h: r.height || innerHeight };
}

// For a page image inside scrolling text: the usual trimmed width, but only the inked height,
// leaving out a running header or page number set apart in the top or bottom 9% of the page.
async function tightCrop(n) {
  const c = await cropFor(n);
  const b = await pageBox(n);
  if (!b) throw new Error('blank');
  const rows = b.rows;
  const h = rows.length;
  const runs = [];
  for (let y = 0; y < h; y++) {
    if (!rows[y]) continue;
    const last = runs[runs.length - 1];
    if (last && y - last[1] <= 1) last[1] = y; else runs.push([y, y]);
  }
  const gap = h * 0.03;
  while (runs.length > 1 && runs[0][1] < h * 0.09 && runs[1][0] - runs[0][1] > gap) runs.shift();
  while (runs.length > 1 && runs[runs.length - 1][0] > h * 0.91 && runs.at(-1)[0] - runs.at(-2)[1] > gap) runs.pop();
  if (runs.length === 1 && (runs[0][1] < h * 0.09 || runs[0][0] > h * 0.91)) throw new Error('blank');
  return { ...c, y0: Math.max(0, runs[0][0] / h - 0.02), y1: Math.min(1, (runs.at(-1)[1] + 1) / h + 0.02) };
}

function pageCanvas(n, { zoom = 1, area = null, tight = false } = {}) {
  const box = area || (() => { const s = stageSize(); return { w: s.w - 2 * PAD_X, h: s.h - 2 * PAD_Y }; })();
  const key = [n, zoom.toFixed(2), Math.round(box.w), Math.round(box.h), R.book.trim !== false, tight].join('|');
  if (R.cache.has(key)) return R.cache.get(key);
  const book = R.book;
  const job = (async () => {
    const page = await R.pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const crop = tight ? await tightCrop(n) : await cropFor(n);
    const cw = vp1.width * (crop.x1 - crop.x0);
    const ch = vp1.height * (crop.y1 - crop.y0);
    const fit = Math.min(box.w / cw, box.h / ch);
    const css = fit * zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = css * dpr;
    const maxPx = zoom > 1 ? 9e6 : 7e6;
    if (cw * ch * scale * scale > maxPx) scale = Math.sqrt(maxPx / (cw * ch));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdfc';
    canvas.width = Math.max(1, Math.round(cw * scale));
    canvas.height = Math.max(1, Math.round(ch * scale));
    canvas.style.width = `${(cw * css).toFixed(2)}px`;
    canvas.style.height = `${(ch * css).toFixed(2)}px`;
    await page.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport: vp,
      transform: [1, 0, 0, 1, -crop.x0 * vp.width, -crop.y0 * vp.height],
    }).promise;
    if (book !== R.book) throw new Error('closed');
    return { canvas, css };
  })();
  R.cache.set(key, job);
  job.catch(() => R.cache.delete(key));
  pruneCache();
  return job;
}

function pruneCache() {
  for (const key of R.cache.keys()) {
    const n = parseInt(key, 10);
    if (n < R.n - 2 || n > R.n + 3) R.cache.delete(key);
  }
}

async function showPage(n, dir) {
  const token = R.token;
  let res;
  try { res = await pageCanvas(n, { zoom: R.zoom }); } catch { return; }
  if (token !== R.token || R.n !== n || R.view !== 'page') return;
  const c = res.canvas;
  c.classList.remove('turn-next', 'turn-prev');
  pageWrap.replaceChildren(c);
  if (R.zoom > 1) { pageWrap.scrollTop = 0; }
  if (dir && settings.anim) {
    void c.offsetWidth;
    c.classList.add(dir > 0 ? 'turn-next' : 'turn-prev');
  }
}

/* ---------------- Text view ---------------- */
function textLayout() {
  const { w, h } = stageSize();
  const padX = w < 480 ? 22 : Math.round(Math.max(36, (w - 640) / 2));
  const padT = 26;
  const padB = 8;
  return { padX, padT, colW: Math.floor(w - padX * 2), colH: Math.floor(h - padT - padB), gap: padX * 2 };
}

function applyTextStyle() {
  reader.style.setProperty('--rsize', `${settings.size}px`);
  reader.style.setProperty('--rlh', String(settings.lh));
  reader.style.setProperty('--rfont', settings.font === 'sans' ? 'var(--sans)' : 'var(--serif)');
  // A narrow phone column justifies badly at large sizes, so switch to a ragged right edge.
  reader.style.setProperty('--ralign', settings.size <= 20 ? 'justify' : 'left');
  reader.classList.toggle('scroll', !!settings.scroll);
}

function applyK(animate) {
  const L = textLayout();
  flow.classList.toggle('no-anim', !(animate && settings.anim));
  flow.style.transform = `translateX(${-R.k * (L.colW + L.gap)}px)`;
}

async function showText(n, { frac = null, last = false, dir = 0 } = {}) {
  const token = R.token;
  R.busy = true;
  try {
    const res = await R.reflow.page(n);
    if (token !== R.token || R.n !== n || R.view !== 'text' || settings.scroll) return;
    const L = textLayout();
    flow.classList.add('no-anim');
    flow.classList.remove('turn-next', 'turn-prev');
    flow.removeAttribute('style');
    textWrap.scrollTop = 0;
    Object.assign(flow.style, {
      left: `${L.padX}px`, top: `${L.padT}px`, width: `${L.colW}px`, height: `${L.colH}px`,
      columnWidth: `${L.colW}px`, columnGap: `${L.gap}px`, transform: 'none',
    });
    if (res.blocks.length) {
      flow.innerHTML = blocksToHTML(res.blocks);
    } else {
      // Scanned page, figure or title page: show the page itself.
      flow.innerHTML = '';
      const img = await pageCanvas(n, { area: { w: L.colW, h: L.colH } }).catch(() => null);
      if (token !== R.token || R.n !== n || R.view !== 'text' || settings.scroll) return;
      const fig = document.createElement('figure');
      if (img) {
        fig.appendChild(img.canvas);
        img.canvas.classList.remove('turn-next', 'turn-prev');
      }
      flow.appendChild(fig);
    }
    R.screens = Math.max(1, Math.round((flow.scrollWidth + L.gap) / (L.colW + L.gap)));
    R.k = last ? R.screens - 1 : frac != null ? clamp(Math.round(frac * R.screens), 0, R.screens - 1) : 0;
    applyK(false);
    if (dir && settings.anim) {
      void flow.offsetWidth;
      flow.classList.add(dir > 0 ? 'turn-next' : 'turn-prev');
    }
  } finally {
    R.busy = false;
  }
}

/* ---------------- Text view, scrolling ---------------- */
// One long column. PDF pages are added above and below as you scroll, and an
// empty marker span at the start of each page tracks which page you're on.
const scrollMode = () => R.view === 'text' && !!settings.scroll;
const live = (gen) => gen === R.sgen && !!R.book && scrollMode();
const contentY = (el) => el.getBoundingClientRect().top - textWrap.getBoundingClientRect().top + textWrap.scrollTop;

// How far through the current PDF page the reader is, from 0 to 1.
function within() {
  if (R.view !== 'text') return 0;
  return settings.scroll ? R.frac : R.k / R.screens;
}
function atLastScreen() {
  if (R.view !== 'text') return true;
  return settings.scroll ? R.atEnd : R.k === R.screens - 1;
}

// The blocks of one PDF page, with its page marker at the front.
async function pageNodes(n) {
  const res = await R.reflow.page(n);
  const tpl = document.createElement('template');
  if (res.blocks.length) {
    tpl.innerHTML = blocksToHTML(res.blocks);
    for (const p of tpl.content.querySelectorAll('p.first')) p.classList.remove('first');
  } else {
    // Scanned page, figure or title page: show the inked part of the page. Blank pages take no space.
    const img = await pageCanvas(n, { area: { w: textLayout().colW, h: 1e5 }, tight: true }).catch(() => null);
    const el = document.createElement(img ? 'figure' : 'div');
    if (img) {
      el.className = 'pfig';
      el.dataset.n = n;
      img.canvas.classList.remove('turn-next', 'turn-prev');
      el.appendChild(img.canvas);
    }
    tpl.content.appendChild(el);
  }
  const els = [...tpl.content.children];
  const pm = document.createElement('span');
  pm.className = 'pm';
  pm.dataset.n = n;
  els[0].prepend(pm);
  return els;
}

// A page that starts mid-sentence carries on the paragraph that ended the page before.
function canJoin(a, b) {
  return a?.tagName === 'P' && b?.tagName === 'P' && b.classList.contains('cont') &&
    a.classList.contains('note') === b.classList.contains('note');
}
function joinParas(a, b) {
  const tail = a.lastChild?.nodeType === Node.TEXT_NODE ? a.lastChild : null;
  if (tail && /[A-Za-zÀ-ÿ]-$/.test(tail.data) && /^[a-zà-ÿ]/.test(b.textContent)) tail.data = tail.data.slice(0, -1);
  else if (tail && /­$/.test(tail.data)) tail.data = tail.data.slice(0, -1);
  else a.append(' ');
  a.append(...b.childNodes);
  b.remove();
}

function placePage(n, els, atTop) {
  if (atTop) {
    const first = flow.firstElementChild;
    if (canJoin(els[els.length - 1], first)) joinParas(els[els.length - 1], first);
    flow.prepend(...els);
    R.sFirst = n;
  } else {
    const last = flow.lastElementChild;
    if (canJoin(last, els[0])) joinParas(last, els.shift());
    flow.append(...els);
    R.sLast = n;
    if (n === N()) flow.insertAdjacentHTML('beforeend', '<div class="flow-end" aria-hidden="true">End</div>');
  }
  R.marks = [...flow.querySelectorAll('.pm')];
}

// Where marker i starts and where its page ends, in scroll coordinates.
function markSpan(i) {
  const m = R.marks;
  const top = contentY(m[i]);
  const lastEl = flow.lastElementChild;
  const end = i + 1 < m.length ? contentY(m[i + 1]) : contentY(lastEl) + lastEl.offsetHeight;
  return [top, Math.max(end, top + 1)];
}

// The page at the top reading line, and how far through it.
function scrollSpot() {
  const m = R.marks;
  if (!m.length) return { n: R.n, frac: 0, atEnd: false };
  const y = textWrap.scrollTop + textLayout().padT + 2;
  let lo = 0;
  let hi = m.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (contentY(m[mid]) <= y) lo = mid; else hi = mid - 1;
  }
  const [top, end] = markSpan(lo);
  const atEnd = R.sLast === N() && textWrap.scrollTop + textWrap.clientHeight >= textWrap.scrollHeight - 4;
  // A short last page never reaches the top line, so the bottom of the book counts as reaching it.
  if (atEnd) return { n: N(), frac: 0.999, atEnd };
  return { n: +m[lo].dataset.n, frac: clamp((y - top) / (end - top), 0, 0.999), atEnd };
}

async function appendPage(n, gen) {
  const els = await pageNodes(n);
  if (live(gen) && R.sLast === n - 1) placePage(n, els, false);
}

async function prependPage(n, gen) {
  const els = await pageNodes(n);
  if (!live(gen) || R.sFirst !== n + 1) return;
  // Measure something below the insertion and scroll by however far it moves, so the text on
  // screen stays still. The first paragraph may merge with the new page and re-wrap, so when it
  // is on screen use the marker at the join instead.
  const first = flow.firstElementChild;
  const viewTop = textWrap.getBoundingClientRect().top;
  const anchor = first.getBoundingClientRect().bottom > viewTop || !first.nextElementSibling
    ? first.querySelector('.pm') || first
    : first.nextElementSibling;
  const y0 = anchor.getBoundingClientRect().top;
  placePage(n, els, true);
  if (anchor.isConnected) textWrap.scrollTop += anchor.getBoundingClientRect().top - y0;
}

// Keep about two screens of text loaded above and below the reading position.
async function fillScroll() {
  const gen = R.sgen;
  if (R.filling === gen || !live(gen) || R.busy) return;
  R.filling = gen;
  try {
    for (let i = 0; i < 24 && live(gen); i++) {
      const h = textWrap.clientHeight;
      const top = textWrap.scrollTop;
      if (textWrap.scrollHeight - top - h < h * 2 && R.sLast < N()) await appendPage(R.sLast + 1, gen);
      else if (top < h * 2 && R.sFirst > 1) await prependPage(R.sFirst - 1, gen);
      else break;
    }
  } finally {
    if (R.filling === gen) R.filling = 0;
  }
}

// Page images far from the reading position give their memory back, keeping their space.
function pruneFigs() {
  const gen = R.sgen;
  const area = { w: textLayout().colW, h: 1e5 };
  for (const fig of flow.querySelectorAll('figure.pfig')) {
    const n = +fig.dataset.n;
    const c = fig.querySelector('canvas');
    if (Math.abs(n - R.n) > 3) {
      if (c) { fig.style.height = `${fig.offsetHeight}px`; c.remove(); }
    } else if (!c && !fig.dataset.busy) {
      fig.dataset.busy = '1';
      pageCanvas(n, { area, tight: true }).then((img) => {
        if (gen !== R.sgen || !fig.isConnected) return;
        fig.appendChild(img.canvas);
        fig.style.height = '';
      }).catch(() => {}).finally(() => { delete fig.dataset.busy; });
    }
  }
}

async function showScroll(n, frac = 0) {
  const gen = ++R.sgen;
  R.busy = true;
  try {
    const nums = [n - 1, n, n + 1].filter((k) => k >= 1 && k <= N());
    const pages = await Promise.all(nums.map((k) => pageNodes(k)));
    if (!live(gen)) return;
    const L = textLayout();
    flow.className = 'flow';
    flow.removeAttribute('style');
    Object.assign(flow.style, { width: `${L.colW}px`, paddingTop: `${L.padT}px`, paddingBottom: `${L.padT * 2}px` });
    flow.replaceChildren();
    const at = nums.indexOf(n);
    R.sFirst = n;
    R.sLast = n - 1;
    for (let i = at; i < nums.length; i++) placePage(nums[i], pages[i], false);
    if (at > 0) placePage(n - 1, pages[0], true);

    const target = () => {
      const [top, end] = markSpan(R.marks.findIndex((el) => +el.dataset.n === n));
      return top + frac * (end - top) - L.padT;
    };
    // Load a screen and a half below the target first, or the browser would clamp the scroll.
    while (R.sLast < N() && textWrap.scrollHeight - target() < textWrap.clientHeight * 1.5) {
      const els = await pageNodes(R.sLast + 1);
      if (!live(gen)) return;
      placePage(R.sLast + 1, els, false);
    }
    textWrap.scrollTop = target();
    R.n = n;
    R.frac = frac;
    R.atEnd = scrollSpot().atEnd;
  } finally {
    if (gen === R.sgen) R.busy = false;
  }
  if (live(gen)) {
    pruneFigs();
    fillScroll();
  }
}

function onScroll() {
  R.scrollRaf = 0;
  if (!R.book || !scrollMode() || R.busy || !R.marks.length) return;
  const spot = scrollSpot();
  R.frac = spot.frac;
  R.atEnd = spot.atEnd;
  if (spot.n !== R.n) {
    R.n = spot.n;
    afterMove();
    pruneFigs();
  } else {
    savePosition();
    updateStatus();
  }
  fillScroll();
}
textWrap.addEventListener('scroll', () => {
  R.scrolledAt = performance.now();
  if (!R.scrollRaf) R.scrollRaf = requestAnimationFrame(onScroll);
}, { passive: true });

// Tapping the edges moves a screen at a time, keeping a line and a half for context.
function scrollStep(dir) {
  if (R.busy) return;
  const h = textWrap.clientHeight;
  const line = settings.size * settings.lh;
  if (dir > 0 && R.sLast === N() && textWrap.scrollTop + h >= textWrap.scrollHeight - 4) {
    toast('You’ve reached the end');
    return;
  }
  R.steppedAt = performance.now();
  textWrap.scrollBy({ top: dir * Math.max(line, h - line * 1.5), behavior: settings.anim ? 'smooth' : 'auto' });
}

/* ---------------- Navigation ---------------- */
function next() {
  if (!R.pdf) return;
  if (scrollMode()) { scrollStep(1); return; }
  if (R.view === 'text') {
    if (R.busy) return;
    if (R.k < R.screens - 1) { R.k++; applyK(true); afterMove(); return; }
  }
  if (R.n >= N()) { toast('You’ve reached the end'); return; }
  go(R.n + 1, { dir: 1 });
}
function prev() {
  if (!R.pdf) return;
  if (scrollMode()) { scrollStep(-1); return; }
  if (R.view === 'text') {
    if (R.busy) return;
    if (R.k > 0) { R.k--; applyK(true); afterMove(); return; }
  }
  if (R.n <= 1) return;
  go(R.n - 1, { dir: -1, last: true });
}
async function go(n, { dir = 0, last = false, frac = null } = {}) {
  R.n = clamp(n, 1, N());
  R.k = 0;
  if (scrollMode()) await showScroll(R.n, frac ?? (last ? 0.999 : 0));
  else if (R.view === 'text') await showText(R.n, { dir, last, frac });
  else await showPage(R.n, dir);
  afterMove();
}
function jumpTo(n, frac = null) {
  if (n === R.n && frac === null) return;
  R.jumpFrom = { n: R.n, frac: within() };
  go(n, { frac });
}

function afterMove() {
  if (!R.book) return;
  const b = R.book;
  const now = performance.now();
  // Reading speed: time spent per PDF page, only for steady forward reading.
  if (R.lastPage && R.n === R.lastPage + 1 && R.pageStartedAt) {
    const dt = (now - R.pageStartedAt) / 1000;
    if (dt > 4 && dt < 600) {
      b.spp = b.spp ? b.spp * 0.85 + dt * 0.15 : dt;
      b.samples = (b.samples || 0) + 1;
    }
  }
  if (R.n !== R.lastPage) { R.lastPage = R.n; R.pageStartedAt = now; }
  R.shownAt = now;

  savePosition();
  updateStatus();
  updateChrome();
  prefetch();
}

function savePosition() {
  const b = R.book;
  b.page = R.n;
  b.frac = within();
  b.finished = R.n === N() && atLastScreen() && N() > 1;
  b.openedAt = Date.now();
  saveSoon(b);
}

function prefetch() {
  clearTimeout(R.pf);
  R.pf = setTimeout(async () => {
    const token = R.token;
    const n = R.n;
    const list = R.view === 'page' ? (R.zoom > 1 ? [n + 1] : [n + 1, n - 1, n + 2]) : [n + 1, n - 1];
    for (const k of list) {
      if (token !== R.token || n !== R.n || k < 1 || k > N()) continue;
      try {
        if (R.view === 'page') await pageCanvas(k, { zoom: R.zoom });
        else await R.reflow.page(k);
      } catch {}
    }
  }, 150);
}

/* ---------------- Outline & chapters ---------------- */
async function resolveDest(dest) {
  try {
    if (typeof dest === 'string') dest = await R.pdf.getDestination(dest);
    if (!Array.isArray(dest)) return null;
    const ref = dest[0];
    if (ref && typeof ref === 'object') return (await R.pdf.getPageIndex(ref)) + 1;
    if (Number.isInteger(ref)) return ref + 1;
  } catch {}
  return null;
}

async function loadOutline(token) {
  let outline = null;
  try { outline = await R.pdf.getOutline(); } catch {}
  if (token !== R.token || !outline) return;
  const items = [];
  const walk = async (list, level) => {
    for (const it of list || []) {
      const page = await resolveDest(it.dest);
      const title = (it.title || '').replace(/\s+/g, ' ').trim();
      if (page && title) items.push({ title, page, level });
      if (level < 2 && it.items?.length) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 0);
  if (token !== R.token) return;
  R.toc = items;
  // Chapters: top level, unless the outline is wrapped in a single root entry.
  let top = outline;
  let lvl = 0;
  while (top.length === 1 && top[0].items?.length && lvl < 2) { top = top[0].items; lvl++; }
  const seen = new Set();
  R.chapters = items.filter((i) => i.level === lvl && !seen.has(i.page) && seen.add(i.page)).sort((a, b) => a.page - b.page);
  if (R.chapters.length < 2) R.chapters = [];
  updateStatus();
  updateChrome();
}

function chapterAt(n) {
  let cur = null;
  let idx = -1;
  R.chapters.forEach((c, i) => { if (c.page <= n) { cur = c; idx = i; } });
  if (!cur) return null;
  const end = idx + 1 < R.chapters.length ? R.chapters[idx + 1].page - 1 : N();
  return { ...cur, end: Math.max(end, cur.page) };
}

/* ---------------- Status line ---------------- */
function fmtTime(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return 'Under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
function statusModes() {
  return R.chapters.length ? ['page', 'chapter', 'book'] : ['page', 'book'];
}
function updateStatus() {
  const b = R.book;
  if (!b) return;
  const total = N();
  const w = within();
  const p = R.pdf ? progressOf({ ...b, page: R.n, frac: w, finished: false, pages: total }) : progressOf(b);
  $('statusRight').textContent = `${Math.round(p * 100)}%`;
  const modes = statusModes();
  const mode = modes[settings.status % modes.length];
  let text;
  if (mode === 'page' || !R.pdf) {
    text = `Page ${R.n} of ${total}`;
  } else if ((b.samples || 0) < 3 || !b.spp) {
    text = 'Learning your reading speed';
  } else if (mode === 'chapter') {
    const ch = chapterAt(R.n);
    text = ch ? `${fmtTime((ch.end - R.n + 1 - w) * b.spp)} left in chapter` : `Page ${R.n} of ${total}`;
  } else {
    text = `${fmtTime((total - R.n + 1 - w) * b.spp)} left in book`;
  }
  $('statusLeft').textContent = text;
  $('ribbon').hidden = !b.bookmarks?.includes(R.n);
}
$('statusLeft').addEventListener('click', () => {
  settings.status = (settings.status + 1) % statusModes().length;
  saveSettings();
  updateStatus();
});

/* ---------------- Controls overlay ---------------- */
function toggleChrome(on = !reader.classList.contains('chrome-on')) {
  reader.classList.toggle('chrome-on', on);
  if (on) updateChrome();
}
function setRangePct(input) {
  const min = +input.min || 0;
  const max = +input.max || 100;
  const pct = max > min ? ((+input.value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--pct', `${pct}%`);
  return pct;
}
function updateChrome() {
  const b = R.book;
  if (!b) return;
  $('bookTitle').textContent = b.title;
  $('chapterTitle').textContent = chapterAt(R.n)?.title || (b.author || '');
  const scrub = $('scrub');
  scrub.max = String(N());
  scrub.value = String(R.n);
  setRangePct(scrub);
  $('barPage').textContent = `${R.n} of ${N()}`;
  const marked = b.bookmarks?.includes(R.n);
  $('markBtn').setAttribute('aria-pressed', String(!!marked));
  $('markBtn').setAttribute('aria-label', marked ? 'Remove bookmark' : 'Bookmark this page');
  const jb = $('jumpBack');
  jb.hidden = !R.jumpFrom;
  if (R.jumpFrom) jb.textContent = `← Back to page ${R.jumpFrom.n}`;
}

$('backBtn').addEventListener('click', popLayer);
$('markBtn').addEventListener('click', () => {
  const b = R.book;
  b.bookmarks = b.bookmarks || [];
  const i = b.bookmarks.indexOf(R.n);
  if (i >= 0) b.bookmarks.splice(i, 1);
  else { b.bookmarks.push(R.n); b.bookmarks.sort((x, y) => x - y); }
  saveSoon(b, 0);
  updateChrome();
  updateStatus();
});
$('jumpBack').addEventListener('click', () => {
  const j = R.jumpFrom;
  R.jumpFrom = null;
  if (j) go(j.n, { frac: j.frac });
});

const scrub = $('scrub');
const scrubLabel = $('scrubLabel');
scrub.addEventListener('input', () => {
  const pct = setRangePct(scrub);
  const n = +scrub.value;
  const ch = chapterAt(n);
  scrubLabel.hidden = false;
  scrubLabel.style.setProperty('--pct', `${pct}%`);
  scrubLabel.textContent = `Page ${n} of ${N()}${ch ? ' · ' + ch.title : ''}`;
});
scrub.addEventListener('change', () => {
  scrubLabel.hidden = true;
  jumpTo(+scrub.value);
});

/* ---------------- Contents & bookmarks ---------------- */
function renderToc() {
  const list = $('tocList');
  if (!R.toc.length) {
    list.innerHTML = '<li><p class="sheet-empty">This PDF doesn’t include a table of contents. Use the slider to move through it.</p></li>';
    return;
  }
  let current = -1;
  R.toc.forEach((t, i) => { if (t.page <= R.n) current = i; });
  list.innerHTML = R.toc.map((t, i) => `
    <li><button type="button" class="lvl${t.level}${i === current ? ' current' : ''}" data-page="${t.page}">
      <span>${esc(t.title)}</span><span class="num">${t.page}</span>
    </button></li>`).join('');
}
function renderMarks() {
  const b = R.book;
  const list = $('markList');
  if (!b.bookmarks?.length) {
    list.innerHTML = '<li><p class="sheet-empty">No bookmarks yet. Open the controls and tap the ribbon at the top right to mark a page.</p></li>';
    return;
  }
  list.innerHTML = b.bookmarks.map((p) => {
    const ch = chapterAt(p);
    return `<li>
      <button type="button" class="go" data-page="${p}"><span>Page ${p}</span>${ch ? `<small>${esc(ch.title)}</small>` : ''}</button>
      <button type="button" class="rm" data-rm="${p}" aria-label="Remove bookmark on page ${p}">${ICON_X}</button>
    </li>`;
  }).join('');
}
function selectTab(which) {
  const toc = which === 'toc';
  $('tabToc').setAttribute('aria-selected', String(toc));
  $('tabMarks').setAttribute('aria-selected', String(!toc));
  $('tocList').hidden = !toc;
  $('markList').hidden = toc;
}
$('tabToc').addEventListener('click', () => selectTab('toc'));
$('tabMarks').addEventListener('click', () => selectTab('marks'));
$('tocBtn').addEventListener('click', () => {
  renderToc();
  renderMarks();
  selectTab(R.toc.length || !R.book.bookmarks?.length ? 'toc' : 'marks');
  openSheet('contentsSheet');
  requestAnimationFrame(() => $('tocList').querySelector('.current')?.scrollIntoView({ block: 'center' }));
});
$('contentsSheet').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    const p = +rm.dataset.rm;
    R.book.bookmarks = R.book.bookmarks.filter((x) => x !== p);
    saveSoon(R.book, 0);
    renderMarks();
    updateChrome();
    updateStatus();
    return;
  }
  const target = e.target.closest('[data-page]');
  if (target) {
    const p = +target.dataset.page;
    popLayer();
    toggleChrome(false);
    jumpTo(p, 0);
  }
});

/* ---------------- Display sheet ---------------- */
function setChecked(selector, attr, value) {
  for (const el of document.querySelectorAll(selector)) el.setAttribute('aria-checked', String(el.dataset[attr] === String(value)));
}
function syncDisplay() {
  const sheet = $('displaySheet');
  sheet.dataset.view = R.view;
  setChecked('#displaySheet [data-view]', 'view', R.view);
  setChecked('#displaySheet [data-theme]', 'theme', settings.theme);
  setChecked('#displaySheet [data-font]', 'font', settings.font);
  setChecked('#displaySheet [data-lh]', 'lh', settings.lh);
  $('sizeOut').textContent = `${settings.size}`;
  $('scrollToggle').checked = !!settings.scroll;
  $('trimToggle').checked = R.book?.trim !== false;
  $('awakeToggle').checked = settings.awake;
  $('fullToggle').checked = settings.full;
  $('animToggle').checked = settings.anim;
  const bright = $('bright');
  bright.value = String(settings.bright);
  setRangePct(bright);
  $('viewHint').textContent = !R.hasText
    ? 'This PDF is made of scanned images, so Text view can only show the pages as pictures.'
    : R.view === 'text'
      ? 'Text is reflowed from the PDF into one column. Figures and tables look best in Page view.'
      : 'Text view reflows the words into one column you can resize.';
}
$('displayBtn').addEventListener('click', () => { syncDisplay(); openSheet('displaySheet'); });

function relayout() {
  if (!R.pdf) return;
  R.cache = new Map();
  if (scrollMode()) showScroll(R.n, within()).then(updateStatus);
  else if (R.view === 'text') showText(R.n, { frac: within() }).then(updateStatus);
  else showPage(R.n, 0);
}

$('displaySheet').addEventListener('click', (e) => {
  // Buttons only: the sheet itself carries data-view, and re-syncing on every click would undo the switches.
  const v = e.target.closest('button[data-view]')?.dataset.view;
  const t = e.target.closest('button[data-theme]')?.dataset.theme;
  const f = e.target.closest('button[data-font]')?.dataset.font;
  const lh = e.target.closest('button[data-lh]')?.dataset.lh;
  if (v && v !== R.view) {
    R.view = R.book.view = v;
    reader.dataset.view = v;
    R.zoom = 1;
    pageWrap.classList.remove('zoomed');
    saveSoon(R.book);
    go(R.n, { frac: 0 });
  }
  if (t) { settings.theme = t; applyTheme(); }
  if (f) { settings.font = f; applyTextStyle(); relayout(); }
  if (lh) { settings.lh = +lh; applyTextStyle(); relayout(); }
  if (v || t || f || lh) { saveSettings(); syncDisplay(); }
});
function stepSize(d) {
  const i = SIZES.indexOf(settings.size);
  const j = clamp((i < 0 ? SIZES.indexOf(18) : i) + d, 0, SIZES.length - 1);
  settings.size = SIZES[j];
  saveSettings();
  applyTextStyle();
  relayout();
  syncDisplay();
}
$('sizeDown').addEventListener('click', () => stepSize(-1));
$('sizeUp').addEventListener('click', () => stepSize(1));
$('scrollToggle').addEventListener('change', (e) => {
  const frac = within();
  settings.scroll = e.target.checked;
  saveSettings();
  applyTextStyle();
  if (R.view === 'text') go(R.n, { frac });
});
$('trimToggle').addEventListener('change', async (e) => {
  R.book.trim = e.target.checked;
  if (R.book.trim && !R.book.crop) R.book.crop = await computeCrop();
  saveSoon(R.book);
  relayout();
});
function applyBright() {
  $('dim').style.setProperty('--dim', String(((100 - settings.bright) / 70) * 0.62));
}
$('bright').addEventListener('input', (e) => {
  settings.bright = +e.target.value;
  setRangePct(e.target);
  applyBright();
  saveSettings();
});
$('awakeToggle').addEventListener('change', (e) => {
  settings.awake = e.target.checked;
  saveSettings();
  if (settings.awake) requestWake(); else releaseWake();
});
$('fullToggle').addEventListener('change', (e) => {
  settings.full = e.target.checked;
  saveSettings();
  if (settings.full) document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => toast('Full screen isn’t available here.'));
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
});
$('animToggle').addEventListener('change', (e) => { settings.anim = e.target.checked; saveSettings(); });

/* ---------------- Gestures ---------------- */
let touch = null;
let pinch = null;
let lastTouchEnd = 0;
const hasSelection = () => (getSelection()?.toString() || '').length > 0;

function tapAt(x) {
  if (reader.classList.contains('chrome-on')) { toggleChrome(false); return; }
  if (hasSelection()) { getSelection().removeAllRanges(); return; }
  const w = innerWidth;
  if (x < w * 0.28) prev();
  else if (x > w * 0.72) next();
  else toggleChrome(true);
}

const touchDist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
const touchMid = (e) => ({ x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 });

stage.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    const t = e.touches[0];
    const now = performance.now();
    // A touch that stops a fling isn't a tap (taps on the edges scroll, and that's fine to repeat).
    const fling = now - (R.scrolledAt || 0) < 150 && now - (R.steppedAt || 0) > 700;
    touch = { x: t.clientX, y: t.clientY, time: now, multi: false, fling };
  } else if (e.touches.length === 2) {
    if (touch) touch.multi = true;
    startPinch(e);
  }
}, { passive: true });

stage.addEventListener('touchmove', (e) => {
  if (!pinch && touch && scrollMode() && reader.classList.contains('chrome-on') &&
      Math.abs(e.touches[0].clientY - touch.y) > 12) toggleChrome(false);
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const z = clamp(pinch.z0 * (touchDist(e) / pinch.d0), 1, 4);
  pinch.z = z;
  const c = pinch.canvas;
  c.style.width = `${pinch.w1 * z}px`;
  c.style.height = `${pinch.h1 * z}px`;
  const m = touchMid(e);
  const wr = pageWrap.getBoundingClientRect();
  pageWrap.scrollLeft = c.offsetLeft + pinch.px * z - (m.x - wr.left);
  pageWrap.scrollTop = c.offsetTop + pinch.py * z - (m.y - wr.top);
}, { passive: false });

stage.addEventListener('touchend', (e) => {
  lastTouchEnd = performance.now();
  if (pinch) {
    if (e.touches.length < 2) endPinch();
    return;
  }
  if (!touch || touch.multi || e.touches.length) {
    if (!e.touches.length) touch = null;
    return;
  }
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;
  const dt = performance.now() - touch.time;
  const { fling } = touch;
  touch = null;
  const isTap = Math.hypot(dx, dy) < 12 && dt < 450;
  if (scrollMode()) {
    // Scrolling text: drags scroll natively, taps work as usual, sideways swipes do nothing.
    if (isTap && !fling) { e.preventDefault(); tapAt(t.clientX); }
    return;
  }
  if (R.zoom > 1) {
    // Zoomed in: drag to pan, edges still turn the page, middle shows controls.
    if (isTap) { e.preventDefault(); tapAt(t.clientX); }
    return;
  }
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3 && dt < 800 && !hasSelection()) {
    e.preventDefault();
    if (reader.classList.contains('chrome-on')) toggleChrome(false);
    if (dx < 0) next(); else prev();
    return;
  }
  if (isTap) { e.preventDefault(); tapAt(t.clientX); }
}, { passive: false });

stage.addEventListener('touchcancel', () => { touch = null; if (pinch) endPinch(); });

// Mouse and trackpad (useful on a desktop browser too).
stage.addEventListener('click', (e) => {
  if (performance.now() - lastTouchEnd < 700) return;
  if (hasSelection()) return;
  tapAt(e.clientX);
});

function startPinch(e) {
  if (R.view !== 'page') return;
  const c = pageWrap.querySelector('canvas');
  if (!c) return;
  const cr = c.getBoundingClientRect();
  const m = touchMid(e);
  pinch = {
    canvas: c, d0: touchDist(e), z0: R.zoom, z: R.zoom,
    w1: cr.width / R.zoom, h1: cr.height / R.zoom,
    px: (m.x - cr.left) / R.zoom, py: (m.y - cr.top) / R.zoom,
  };
  pageWrap.classList.add('zoomed');
}

async function endPinch() {
  const p = pinch;
  pinch = null;
  touch = null;
  if (!p) return;
  const z = p.z < 1.08 ? 1 : +p.z.toFixed(2);
  if (z === R.zoom && z !== 1) return;
  R.zoom = z;
  if (z === 1) {
    pageWrap.classList.remove('zoomed');
    pageWrap.scrollTo(0, 0);
    await showPage(R.n, 0);
    return;
  }
  // Re-render sharply at the new zoom, keeping the scroll position.
  const sl = pageWrap.scrollLeft;
  const st = pageWrap.scrollTop;
  const token = R.token;
  const n = R.n;
  try {
    const res = await pageCanvas(n, { zoom: z });
    if (token !== R.token || n !== R.n || R.zoom !== z) return;
    res.canvas.classList.remove('turn-next', 'turn-prev');
    pageWrap.replaceChildren(res.canvas);
    pageWrap.scrollLeft = sl;
    pageWrap.scrollTop = st;
  } catch {}
}

// Keyboard (Bluetooth keyboards, page-turn clickers, desktop).
document.addEventListener('keydown', (e) => {
  if (!R.book || layers.length > 1) return;
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); next(); }
  else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); prev(); }
  else if (e.key === 'Escape') popLayer();
});

// Rotation or window resize: lay the page out again.
let lastSize = '';
new ResizeObserver(() => {
  const s = stageSize();
  const key = `${Math.round(s.w)}x${Math.round(s.h)}`;
  if (key === lastSize) return;
  const first = !lastSize;
  lastSize = key;
  if (first || !R.pdf) return;
  clearTimeout(R.rz);
  R.rz = setTimeout(() => {
    R.zoom = 1;
    pageWrap.classList.remove('zoomed');
    relayout();
  }, 180);
}).observe(stage);

/* ---------------- Screen wake & lifecycle ---------------- */
let wake = null;
async function requestWake() {
  if (!settings.awake || !R.book || document.visibilityState !== 'visible' || wake) return;
  try {
    wake = await navigator.wakeLock?.request('screen');
    wake?.addEventListener?.('release', () => { wake = null; });
  } catch { wake = null; }
}
function releaseWake() {
  wake?.release?.().catch(() => {});
  wake = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWake();
    R.pageStartedAt = performance.now();
  } else if (R.book) {
    flushSaves(R.book);
  }
});
addEventListener('pagehide', () => { if (R.book) flushSaves(R.book); });

/* ---------------- Install prompt ---------------- */
let installEvent = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('installBar').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  $('installBar').hidden = true;
  if (installEvent) {
    installEvent.prompt();
    installEvent = null;
  }
});
addEventListener('appinstalled', () => { $('installBar').hidden = true; });

/* ---------------- Start ---------------- */
async function start() {
  applyTheme();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  const shared = new URLSearchParams(location.search).has('shared');
  if (shared) history.replaceState(null, '', location.pathname);
  await refreshLibrary();

  // PDFs shared to Folio from another app.
  try {
    const inbox = await takeInbox();
    if (inbox.length) {
      const files = inbox.map((i) => new File([i.blob], i.name || 'Shared document.pdf', { type: 'application/pdf' }));
      await importFiles(files, { open: true });
    }
  } catch {}

  // PDFs opened with Folio (where the platform supports file handling).
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      importFiles(files, { open: true });
    });
  }
}
start();
