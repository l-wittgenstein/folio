// Rebuilds readable paragraphs from a PDF page's positioned text runs.
// Handles: line grouping, two-column pages, running headers/footers and page
// numbers, hyphenated line breaks, headings (by size), footnotes, list items.

const SENT_END = /[.!?:;…"”’»)\]]$/;
const BULLET = /^([•·▪‣◦\-–—*]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s/;

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}
const norm = (t) => t.toLowerCase().replace(/[\d\s.,:;|·•–—-]+/g, ' ').trim();

export class Reflower {
  constructor(pdf) {
    this.pdf = pdf;
    this.raw = new Map();   // page -> Promise<{runs, w, h}>
    this.done = new Map();  // page -> Promise<result>
  }

  rawPage(n) {
    if (!this.raw.has(n)) {
      this.raw.set(n, (async () => {
        const page = await this.pdf.getPage(n);
        const tc = await page.getTextContent();
        const vp = page.getViewport({ scale: 1 });
        const runs = [];
        for (const it of tc.items) {
          if (!it.str || !it.transform) continue;
          // Map into top-left viewport space so rotated pages behave too.
          const [a, b, c, d, e, f] = it.transform;
          const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
          const [x, y] = vp.convertToViewportPoint(e, f);
          const rot = Math.atan2(b, a) - (vp.rotation * Math.PI) / 180;
          if (Math.abs(Math.sin(rot)) > 0.2) continue; // skip sideways labels
          runs.push({ str: it.str, x, y, w: (it.width || 0) * (vp.scale || 1), size, eol: it.hasEOL });
        }
        return { runs, w: vp.width, h: vp.height };
      })());
    }
    return this.raw.get(n);
  }

  // Normalised text of lines in the top/bottom bands, to spot running headers.
  async bands(n) {
    if (n < 1 || n > this.pdf.numPages) return new Set();
    const { runs, h } = await this.rawPage(n);
    const set = new Set();
    for (const line of groupLines(runs)) {
      if (line.y < h * 0.09 || line.y > h * 0.91) set.add(norm(line.text));
    }
    return set;
  }

  page(n) {
    if (!this.done.has(n)) this.done.set(n, this.build(n));
    return this.done.get(n);
  }

  async build(n) {
    const { runs, w, h } = await this.rawPage(n);
    const chars = runs.reduce((s, r) => s + r.str.trim().length, 0);
    if (chars < 40) return { blocks: [], chars, text: '' };

    const neighbours = await Promise.all([n - 2, n - 1, n + 1, n + 2].map((k) => this.bands(k)));
    const repeated = (t) => neighbours.some((s) => s.has(t));

    // Body size = most common size, weighted by characters.
    const sizes = [];
    for (const r of runs) for (let i = 0; i < Math.min(r.str.length, 40); i++) sizes.push(Math.round(r.size * 2) / 2);
    const body = median(sizes) || 10;

    const columns = splitColumns(runs, w, body);
    const blocks = [];
    for (const colRuns of columns) {
      let lines = groupLines(colRuns);
      lines = lines.filter((l) => {
        const inBand = l.y < h * 0.09 || l.y > h * 0.91;
        if (!inBand) return true;
        const t = norm(l.text);
        if (!t) return false;                 // bare page number
        if (/^[ivxlcdm]+$/.test(t) && l.text.length < 8) return false;
        if (l.text.length < 90 && repeated(t)) return false;
        return true;
      });
      blocks.push(...paragraphs(lines, body));
    }

    // A page whose first paragraph continues the previous page's sentence.
    const first = blocks.find((b) => b.type === 'p');
    if (first && /^[a-zà-ÿ,;)\]]/.test(first.text)) first.cont = true;

    const text = blocks.map((b) => b.text).join('\n');
    return { blocks, chars, text };
  }
}

function groupLines(runs) {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    let line = null;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
      const L = lines[i];
      if (Math.abs(L.y - r.y) < Math.min(L.size, r.size) * 0.45) { line = L; break; }
    }
    if (!line) {
      line = { y: r.y, size: r.size, runs: [] };
      lines.push(line);
    }
    line.runs.push(r);
    if (r.str.trim().length > 2 && r.size > line.size) line.size = r.size;
  }
  for (const L of lines) {
    L.runs.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    for (const r of L.runs) {
      if (prevEnd !== null) {
        const gap = r.x - prevEnd;
        if (gap > r.size * 0.14 && !/\s$/.test(text) && !/^\s/.test(r.str)) text += ' ';
      }
      text += r.str;
      prevEnd = r.x + r.w;
    }
    L.text = text.replace(/\s+/g, ' ').trim();
    L.x0 = L.runs[0].x;
    L.x1 = Math.max(...L.runs.map((r) => r.x + r.w));
    // Dominant size by characters
    const tally = new Map();
    for (const r of L.runs) {
      const k = Math.round(r.size * 2) / 2;
      tally.set(k, (tally.get(k) || 0) + r.str.length);
    }
    L.size = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || L.size;
  }
  return lines.filter((l) => l.text);
}

// Detect a vertical gutter in the middle of the page (two-column layouts).
function splitColumns(runs, pageW, body) {
  const bodyRuns = runs.filter((r) => Math.abs(r.size - body) < body * 0.2 && r.str.trim());
  if (bodyRuns.length < 30) return [runs];
  const BINS = 120;
  const cover = new Array(BINS).fill(0);
  for (const r of bodyRuns) {
    const a = Math.max(0, Math.floor((r.x / pageW) * BINS));
    const b = Math.min(BINS - 1, Math.floor(((r.x + r.w) / pageW) * BINS));
    for (let i = a; i <= b; i++) cover[i]++;
  }
  const peak = Math.max(...cover);
  let best = null;
  let i = Math.floor(BINS * 0.3);
  while (i < BINS * 0.7) {
    if (cover[i] <= peak * 0.03) {
      let j = i;
      while (j < BINS * 0.7 && cover[j] <= peak * 0.03) j++;
      if (!best || j - i > best[1] - best[0]) best = [i, j];
      i = j;
    } else i++;
  }
  if (!best || best[1] - best[0] < 2) return [runs];
  const split = (((best[0] + best[1]) / 2) / BINS) * pageW;
  const left = runs.filter((r) => r.x < split);
  const right = runs.filter((r) => r.x >= split);
  const lc = left.reduce((s, r) => s + r.str.length, 0);
  const rc = right.reduce((s, r) => s + r.str.length, 0);
  if (lc < (lc + rc) * 0.2 || rc < (lc + rc) * 0.2) return [runs];
  return [left, right];
}

function paragraphs(lines, body) {
  const blocks = [];
  if (!lines.length) return blocks;
  const bodyLines = lines.filter((l) => Math.abs(l.size - body) < body * 0.15);
  const left = pct(bodyLines.map((l) => l.x0), 0.2) || pct(lines.map((l) => l.x0), 0.2);
  const right = pct(bodyLines.map((l) => l.x1), 0.8) || pct(lines.map((l) => l.x1), 0.8);
  const gaps = [];
  for (let i = 1; i < bodyLines.length; i++) {
    const g = bodyLines[i].y - bodyLines[i - 1].y;
    if (g > 0 && g < body * 3) gaps.push(g);
  }
  const lead = median(gaps) || body * 1.25;

  let cur = null;
  let prev = null;
  const push = (b) => { blocks.push(b); cur = b; };

  for (const L of lines) {
    const isHead = L.size >= body * 1.18 && L.text.length < 140;
    const isNote = L.size <= body * 0.86;
    const gap = prev ? L.y - prev.y : 0;

    if (isHead) {
      const level = L.size >= body * 1.5 ? 2 : 3;
      if (cur && cur.type === 'h' && cur.level === level && prev && gap < L.size * 1.9) {
        cur.text += ' ' + L.text;
      } else {
        push({ type: 'h', level, text: L.text });
      }
      prev = L;
      continue;
    }

    let breakPara = !cur || cur.type !== 'p';
    if (!breakPara) {
      const indented = L.x0 > left + body * 0.9 && L.x0 < left + body * 6;
      const bigGap = gap > lead * 1.45 || gap < 0;
      const prevShort = prev.x1 < right - body * 2.2 && SENT_END.test(prev.text);
      const sizeChange = !!cur.note !== isNote;
      const bullet = BULLET.test(L.text);
      breakPara = indented || bigGap || prevShort || sizeChange || bullet;
    }

    if (breakPara) {
      push({ type: 'p', text: L.text, note: isNote, li: BULLET.test(L.text) });
    } else {
      cur.text = joinLine(cur.text, L.text);
    }
    prev = L;
  }
  return blocks.filter((b) => b.text.trim());
}

function joinLine(a, b) {
  if (/­$/.test(a)) return a.slice(0, -1) + b;
  if (/[A-Za-zÀ-ÿ]-$/.test(a) && /^[a-zà-ÿ]/.test(b)) return a.slice(0, -1) + b;
  if (/[-–—/]$/.test(a)) return a + b;
  return a + ' ' + b;
}

// Rough language guess so the browser hyphenates with the right dictionary.
const LANG_WORDS = {
  en: ['the', 'and', 'of', 'to', 'is', 'that', 'with', 'for'],
  es: ['el', 'los', 'que', 'del', 'por', 'una', 'con', 'las'],
  it: ['il', 'che', 'di', 'della', 'per', 'non', 'gli', 'una'],
  fr: ['le', 'les', 'des', 'est', 'une', 'que', 'pour', 'dans'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'den'],
  pt: ['os', 'que', 'não', 'uma', 'com', 'para', 'dos', 'das'],
};
export function guessLang(text) {
  const words = text.toLowerCase().match(/[a-zà-ÿ]+/g) || [];
  if (words.length < 40) return null;
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  let best = null;
  let bestScore = 0;
  for (const [lang, list] of Object.entries(LANG_WORDS)) {
    const score = list.reduce((s, w) => s + (counts.get(w) || 0), 0);
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  return bestScore >= 5 ? best : null;
}

export function blocksToHTML(blocks) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let firstP = true;
  return blocks.map((b) => {
    if (b.type === 'h') { firstP = false; return `<h${b.level}>${esc(b.text)}</h${b.level}>`; }
    const cls = [];
    if (b.note) cls.push('note');
    if (b.li) cls.push('li');
    if (b.cont) cls.push('cont');
    if (firstP && !b.cont) cls.push('first');
    firstP = false;
    return `<p${cls.length ? ` class="${cls.join(' ')}"` : ''}>${esc(b.text)}</p>`;
  }).join('');
}
