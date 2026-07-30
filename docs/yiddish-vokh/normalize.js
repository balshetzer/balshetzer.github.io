// normalize.js — the single browser-side source for Yiddish normalization and
// answer-length parsing. Loaded via <script src="normalize.js"> by both
// cryptic.html (the solver) and cryptic-guide.html before their own inline scripts,
// so the functions below are available to them as globals.
//
// normalize.py (build time) and lib.typ (Typst/PDF) reimplement the same rules
// in their own languages; the test suite checks all of them against a shared
// corpus so they can't drift apart.

// ── Normalisation ──
// Fold nikud/cantillation, final letters, and Yiddish digraphs so that spelling
// variants of an answer compare equal.
const EXPLICIT_MAP = {
  'יִ':'י','ײַ':'יי','שׁ':'ש','שׂ':'ש',
  'שּׁ':'ש','שּׂ':'ש','אַ':'א','אָ':'א',
  'אּ':'א','בּ':'ב','גּ':'ג','דּ':'ד',
  'הּ':'ה','וּ':'ו','זּ':'ז','טּ':'ט',
  'יּ':'י','ךּ':'כ','כּ':'כ','לּ':'ל',
  'מּ':'מ','נּ':'נ','סּ':'ס','ףּ':'פ',
  'פּ':'פ','צּ':'צ','קּ':'ק','רּ':'ר',
  'שּ':'ש','תּ':'ת','וֹ':'ו','בֿ':'ב',
  'כֿ':'כ','פֿ':'פ',
  'װ':'וו','ױ':'וי','ײ':'יי',
};
const FINAL_MAP = {
  'ך':'כ','ם':'מ','ן':'נ','ף':'פ','ץ':'צ',
};

function normaliseHebrew(str) {
  let result = '';
  for (const ch of str) {
    if (EXPLICIT_MAP[ch] !== undefined) { result += EXPLICIT_MAP[ch]; continue; }
    const cp = ch.codePointAt(0);
    if ((cp >= 0x0591 && cp <= 0x05C7) || cp === 0xFB1E) continue;
    if (FINAL_MAP[ch] !== undefined) { result += FINAL_MAP[ch]; continue; }
    if (cp >= 0x05D0 && cp <= 0x05EA) { result += ch; continue; }
  }
  return result;
}

// Normalize a Hebrew key for data-key lookup. Mirrors normalize.py: expand
// Yiddish digraphs, NFKD, keep alef-tav + spaces, fold sofit, collapse spaces.
function normalizeKey(s) {
  s = s.replace(/װ/g, 'וו').replace(/ױ/g, 'וי').replace(/ײ/g, 'יי');
  s = s.normalize('NFKD').replace(/[^א-ת\s]/g, '');
  const sofit = {'ך':'כ','ם':'מ','ן':'נ','ף':'פ','ץ':'צ'};
  return s.replace(/[ךםןףץ]/g, c => sofit[c]).trim().replace(/\s+/g, ' ');
}

// ── Answer length spec ──
// Characters allowed in an answer that are not Hebrew letters — used both to
// warn on stray input and to split an answer into words.
const ANSWER_SEP_CHARS = [' ', '-', '–', '־'];
const ANSWER_SEP_RE = new RegExp('[' + ANSWER_SEP_CHARS.map(c => c.replace(/[-\]]/g, '\\$&')).join('') + ']+');

// Turn an answer into a spec like "1 4" or "3-4": normalised letter count per
// word, with the separators between words kept verbatim.
function answerToLengthSpec(answer) {
  if (!answer.trim()) return '';
  // Split on runs of separator chars, keeping the separators
  const tokens = answer.trim().split(new RegExp('(' + ANSWER_SEP_RE.source + ')'));
  const parts = [];
  let pendingSep = null;
  for (const tok of tokens) {
    if (!tok) continue;
    const hebrewOnly = normaliseHebrew(tok);
    if (hebrewOnly.length > 0) {
      parts.push({ count: hebrewOnly.length, sep: pendingSep !== null ? pendingSep : null });
      pendingSep = null;
    } else {
      const s = tok.trim();
      pendingSep = s === '' ? ' ' : s;
      if (parts.length > 0) { parts[parts.length - 1].sep = pendingSep; pendingSep = null; }
    }
  }
  return parts.map((p, i) =>
    p.count + ((p.sep && i < parts.length - 1) ? p.sep : '')
  ).join('');
}

// Parse a spec string back into per-word { count, sep } descriptors (for the grid).
function parseLengthSpec(spec) {
  const tokens = String(spec).trim().match(/(\d+|[^\d]+)/g) || [];
  const words = []; let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^\d+$/.test(tok)) {
      const count = parseInt(tok, 10);
      const nextTok = tokens[i + 1];
      const sep = (nextTok && !/^\d+$/.test(nextTok)) ? nextTok : null;
      words.push({ count, sep });
      i += sep !== null ? 2 : 1;
    } else { i++; }
  }
  return words;
}

// Render a spec for display, e.g. "1 4" -> "(1, 4)".
function formatLengthSpec(spec) {
  return '(' + spec.replace(/ /g, ', ') + ')';
}

// Make the functions available to Node-based tests without affecting the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    EXPLICIT_MAP, FINAL_MAP, normaliseHebrew, normalizeKey,
    ANSWER_SEP_CHARS, ANSWER_SEP_RE, answerToLengthSpec, parseLengthSpec, formatLengthSpec,
  };
}
