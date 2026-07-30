// solver-common.js — browser-side code shared by cryptic.html (single-clue
// solver) and grid.html (crossword solver). Loaded via <script> after
// normalize.js and before each page's own inline script, so everything here
// is available to them as globals (same pattern as normalize.js).

// ═══════════════════════════════════════════════════════
// Keyboard layout
// ═══════════════════════════════════════════════════════
const KB_ROWS = [
  ['א','ב','ג','ד','ה','ו','ז','ח'],
  ['ט','י','כ','ל','מ','נ','ס','ע'],
  ['פ','צ','ק','ר','ש','ת','⌦'],
];

// Build the on-screen keyboard into `container`. The page supplies what keys
// do: onLetter(letter) for a letter key, onBackspace() for ⌦, and afterKey()
// (e.g. to restore focus) after either.
function buildKeyboard(container, { onLetter, onBackspace, afterKey }) {
  KB_ROWS.forEach(row => {
    const rowEl = document.createElement('div'); rowEl.className = 'kb-row';
    row.forEach(key => {
      const isBack = key === '⌦';
      const btn = document.createElement('button');
      btn.className = 'kb-key' + (isBack ? ' kb-backspace' : '');
      btn.innerHTML = isBack ? '<span class="sym-x">' + key + '</span>' : key;
      btn.setAttribute('tabindex', '-1');
      const handler = e => {
        e.preventDefault();
        if (isBack) onBackspace(); else onLetter(key);
        if (afterKey) afterKey();
      };
      btn.addEventListener('mousedown', handler);
      btn.addEventListener('touchstart', handler, { passive: false });
      rowEl.appendChild(btn);
    });
    container.appendChild(rowEl);
  });
}

// A letter-cell <input> with all the attributes that make mobile/desktop
// typing behave (no native keyboard, no autocorrect noise). Pages attach
// their own listeners.
function makeCellInput() {
  const cell = document.createElement('input');
  cell.type = 'text';
  cell.className = 'cell';
  cell.setAttribute('role', 'gridcell');
  cell.setAttribute('inputmode', 'none');
  cell.setAttribute('autocomplete', 'off');
  cell.setAttribute('autocorrect', 'off');
  cell.setAttribute('autocapitalize', 'off');
  cell.setAttribute('spellcheck', 'false');
  cell.maxLength = 10;
  return cell;
}

// ═══════════════════════════════════════════════════════
// Base64 <-> JSON codec — the single shared path for data baked in at build
// time (cryptic.html's _pd blob, grid.html's _pgd blob) and #d= share links.
// Unpadded base64 of UTF-8 JSON. Not encryption; it only keeps answers out
// of casual View Source. build.py emits the same unpadded format.
// ═══════════════════════════════════════════════════════
function b64encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/=/g, '');
}

function b64decode(str) {
  try {
    // Restore the padding that b64encode / build.py strip on encode
    const padded = str + '==='.slice((str.length + 3) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch(e) { return null; }
}

// ═══════════════════════════════════════════════════════
// Modal — both pages have one #modal-overlay/#modal-body dialog in their
// static HTML; these helpers are the single way to toggle it.
// ═══════════════════════════════════════════════════════
function isModalOpen() {
  return !document.getElementById('modal-overlay').classList.contains('hidden');
}

function openModal() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-close').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════
// Progressive hints
// ═══════════════════════════════════════════════════════
const HINT_LABELS = ['א','ב','ג','ד','ה','ו','ז','ח','ט','י'];

// Render `state.revealed` of `hints` into `body` (at least one, if any
// exist), plus a "נאָך עצות" button until all are shown; calls onExhausted()
// once the last hint is visible. `state` is the caller's own { revealed }
// counter, so each puzzle/word keeps its own progress.
function renderHints(body, hints, state, { onExhausted } = {}) {
  body.innerHTML = '';
  if (state.revealed === 0 && hints.length > 0) state.revealed = 1;
  for (let i = 0; i < state.revealed; i++) {
    const item = document.createElement('div'); item.className = 'hint-item';
    const num = document.createElement('span'); num.className = 'hint-number';
    num.textContent = 'עצה ' + (HINT_LABELS[i] || String(i + 1));
    item.appendChild(num); item.appendChild(document.createTextNode(hints[i]));
    body.appendChild(item);
  }
  if (state.revealed < hints.length) {
    const btn = document.createElement('button'); btn.className = 'btn-more-hint';
    btn.textContent = 'נאָך עצות';
    btn.addEventListener('click', () => { state.revealed++; renderHints(body, hints, state, { onExhausted }); });
    body.appendChild(btn);
  } else if (onExhausted) {
    // All provided hints exhausted — e.g. the reveal button may now appear
    onExhausted();
  }
}

// Render the post-solve details — the explanation (if any) and the full list
// of hints that were available — into `container`. Used by cryptic.html's
// solved view and by the grid page's 🔑 modal.
function renderSolvedDetails(container, explanation, hints) {
  container.innerHTML = '';
  if (explanation) {
    const wrap = document.createElement('div'); wrap.className = 'solved-explanation-wrap';
    const title = document.createElement('div'); title.className = 'solved-hints-title';
    title.textContent = 'אױסטײַטש';
    const body = document.createElement('div'); body.className = 'solved-explanation';
    body.textContent = explanation;
    wrap.appendChild(title); wrap.appendChild(body);
    container.appendChild(wrap);
  }
  if (hints && hints.length) {
    const wrap = document.createElement('div');
    const title = document.createElement('div'); title.className = 'solved-hints-title';
    title.textContent = 'דאָס זענען געווען די עצות וואָס מען האָט געקענט באַקומען';
    wrap.appendChild(title);
    hints.forEach(h => {
      const d = document.createElement('div'); d.className = 'solved-hint';
      d.textContent = h; wrap.appendChild(d);
    });
    container.appendChild(wrap);
  }
}

// ═══════════════════════════════════════════════════════
// Reveal-a-letter
// ═══════════════════════════════════════════════════════
// Pick and lock the next letter of `answer` across `cellStates` (a linear
// array of { value, locked }), calling lock(idx, letter) for the chosen
// cell. Returns the index, or -1 when nothing is left to reveal.
//
// "odds"/"evens" refer to the 1-based position of each cell, not its array
// index: odd positions are 1st, 3rd, 5th… (array indices 0,2,4…) and even
// positions are 2nd, 4th… (array indices 1,3,5…). The phases:
//   1+2: unfilled unlocked cells, odd positions first, then even
//   3:   incorrectly filled unlocked cells, in index order
//   4:   correctly filled unlocked cells, in index order
// The answer[idx] !== undefined guards protect against more cells than the
// normalised answer has characters.
function revealNextLetterIn(cellStates, answer, lock) {
  const n = cellStates.length;
  const odds  = Array.from({length: n}, (_, i) => i).filter(i => i % 2 === 0); // 1st, 3rd, 5th…
  const evens = Array.from({length: n}, (_, i) => i).filter(i => i % 2 === 1); // 2nd, 4th…
  for (const idx of [...odds, ...evens]) {
    if (!cellStates[idx].locked && !cellStates[idx].value && answer[idx] !== undefined) {
      lock(idx, answer[idx]); return idx;
    }
  }
  for (let idx = 0; idx < n; idx++) {
    if (!cellStates[idx].locked && cellStates[idx].value !== answer[idx] && answer[idx] !== undefined) {
      lock(idx, answer[idx]); return idx;
    }
  }
  for (let idx = 0; idx < n; idx++) {
    if (!cellStates[idx].locked && answer[idx] !== undefined) {
      lock(idx, answer[idx]); return idx;
    }
  }
  return -1;
}

// Make the functions available to Node-based tests without affecting the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KB_ROWS, buildKeyboard, makeCellInput, b64encode, b64decode,
    isModalOpen, openModal, closeModal,
    HINT_LABELS, renderHints, renderSolvedDetails, revealNextLetterIn,
  };
}
