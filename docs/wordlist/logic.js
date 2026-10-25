// logic.js — the rules of the app, with no DOM and no network, so they can be
// tested in Node (wordlist/app_tests/). State is plain JSON:
//
//   work      the current unsaved work, in order: the undo stack
//             {type: "decision", decision} | {type: "skip", norm, prev}
//   outbox    {batches: [{id, decisions: {norm: decision}, attempted}],
//              pendingRun}
//   snoozed   {norm: expiry ms}      skipped words, hidden for SNOOZE_DAYS
//   sentRecently {norm: ms}          uploaded decisions, hidden until the
//                                    pipeline has folded them into the queue
//
// A decision is {norm, word, kind: "word"|"candidate", action: "score"|
// "remove", score?}.

export const TIERS = [["great", 95], ["good", 75], ["okay", 55], ["poor", 35]];
export const SNOOZE_DAYS = 14;
export const SENT_HIDE_DAYS = 60;
const DAY = 86400000;

// ----------------------------------------------------------- normalization
// The same as wordlist/common.py's normalize(): ligatures expanded, points
// stripped, final letters folded, everything but Hebrew letters dropped.
const FINALS = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };

export function normalize(text) {
  return text
    .normalize("NFKD")
    .replace(/װ/g, "וו")
    .replace(/ױ/g, "וי")
    .replace(/ײ/g, "יי")
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[^א-ת]/g, "");
}

// --------------------------------------------------------------- decisions
export function decisionFor(item, action, score) {
  const d = { norm: item.norm, word: item.word, kind: item.kind, action };
  if (action === "score") d.score = score;
  return d;
}

// The lines a decision becomes in an inbox file (see wordlist/inbox.py).
// A word shown with several spellings ("a/b") is stored under its first.
export function decisionLines(d) {
  const first = d.word.split("/")[0].trim();
  if (d.action === "remove") return [`remove\t${d.norm}\t${first}`];
  const lines = [];
  if (d.kind === "candidate") lines.push(`add\t${first}`);
  lines.push(`score\t${d.norm}\t${d.score}`);
  return lines;
}

export function batchText(decisions) {
  return decisions.flatMap(decisionLines).join("\n") + "\n";
}

// ---------------------------------------------------- working set and undo
export function pushDecision(work, decision) {
  work.push({ type: "decision", decision });
}

export function pushSkip(work, snoozed, norm, now) {
  work.push({ type: "skip", norm, prev: snoozed[norm] ?? null });
  snoozed[norm] = now + SNOOZE_DAYS * DAY;
}

export function undo(work, snoozed) {
  const entry = work.pop();
  if (entry && entry.type === "skip") {
    if (entry.prev == null) delete snoozed[entry.norm];
    else snoozed[entry.norm] = entry.prev;
  }
  return entry || null;
}

// Final decision per word: a later one replaces an earlier one.
export function workDecisions(work) {
  const out = new Map();
  for (const e of work) if (e.type === "decision") out.set(e.decision.norm, e.decision);
  return out;
}

// ------------------------------------------------------------------ outbox
export function newOutbox() {
  return { batches: [], pendingRun: false };
}

export function batchId(now, rand = Math.random) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${Math.floor(rand() * 0x10000).toString(16).padStart(4, "0")}`;
}

// Save: freeze the current work as a batch and clear the undo stack. Work
// not yet attempted is merged into the last batch (later decisions win); a
// batch that has been attempted might already be on the server, so it is
// never added to — a new one starts instead. Returns false if there was
// nothing to save.
export function saveWork(outbox, work, now, rand = Math.random) {
  const decisions = workDecisions(work);
  if (!decisions.size) return false;
  let batch = outbox.batches[outbox.batches.length - 1];
  if (!batch || batch.attempted) {
    batch = { id: batchId(now, rand), decisions: {}, attempted: false };
    outbox.batches.push(batch);
  }
  for (const [norm, d] of decisions) batch.decisions[norm] = d;
  work.length = 0;
  return true;
}

// Run: any number of presses before it is sent are one request.
export function requestRun(outbox) {
  outbox.pendingRun = true;
}

// Sends the outbox in order — every batch first, then the run if wanted —
// one request at a time. A failure stops the whole thing and keeps what was
// not sent, so a run is never sent ahead of a batch it should follow.
//   deps.online()          navigator.onLine
//   deps.putBatch(id, text, n)   upload one batch (throws on failure)
//   deps.dispatchRun()           start the pipeline (throws on failure)
//   deps.persist()               write the state to storage
//   deps.sent(norms)             a batch was uploaded
// Returns {sent, ran, offline, error}. Calls overlap safely: a second call
// while one is running waits for it and then goes again.
export function createSync(getOutbox, deps) {
  let running = null;
  let again = false;

  async function once() {
    const outbox = getOutbox();
    const result = { sent: 0, ran: false, offline: false, error: null };
    if (!deps.online()) {
      result.offline = true;
      return result;
    }
    while (outbox.batches.length) {
      const batch = outbox.batches[0];
      batch.attempted = true;
      deps.persist();
      try {
        await deps.putBatch(batch.id, batchText(Object.values(batch.decisions)),
                            Object.keys(batch.decisions).length);
      } catch (e) {
        result.error = e;
        return result;
      }
      outbox.batches.shift();
      deps.sent(Object.keys(batch.decisions));
      result.sent++;
      deps.persist();
    }
    if (outbox.pendingRun) {
      try {
        await deps.dispatchRun();
      } catch (e) {
        result.error = e;
        return result;
      }
      outbox.pendingRun = false;
      result.ran = true;
      deps.persist();
    }
    return result;
  }

  async function loop() {
    let total = { sent: 0, ran: false, offline: false, error: null };
    do {
      again = false;
      const r = await once();
      total = { sent: total.sent + r.sent, ran: total.ran || r.ran,
                offline: r.offline, error: r.error };
      if (r.error || r.offline) break;
    } while (again);
    return total;
  }

  return {
    flush() {
      if (running) {
        again = true;
        return running;
      }
      running = loop().finally(() => { running = null; });
      return running;
    },
  };
}

// ------------------------------------------------------ what to show next
export function hiddenSet({ work, outbox, sentRecently, repoDecided, snoozed, now }) {
  const hide = new Set(repoDecided);
  for (const e of work) if (e.type === "decision") hide.add(e.decision.norm);
  for (const b of outbox.batches) for (const n of Object.keys(b.decisions)) hide.add(n);
  for (const [n, t] of Object.entries(sentRecently)) {
    if (now - t < SENT_HIDE_DAYS * DAY) hide.add(n);
  }
  for (const [n, expiry] of Object.entries(snoozed)) if (expiry > now) hide.add(n);
  return hide;
}

export function nextItem(items, hide) {
  return items.find((item) => !hide.has(item.norm)) || null;
}

export function remaining(items, hide) {
  let n = 0;
  for (const item of items) if (!hide.has(item.norm)) n++;
  return n;
}

// Norms already decided in the repo, from the text of its input files and
// of any inbox batches not yet applied.
export function normsFromRepo({ overrides = "", excluded = "", myWords = "", inbox = [] }) {
  const norms = new Set();
  const lines = (text) => text.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  for (const line of lines(overrides)) norms.add(normalize(line.split("\t")[0]));
  for (const line of lines(excluded)) norms.add(normalize(line));
  for (const line of lines(myWords)) norms.add(normalize(line));
  for (const text of inbox) {
    for (const line of lines(text)) {
      const [action, arg] = line.split("\t");
      if (action === "add" || action === "score" || action === "remove") {
        norms.add(normalize(arg || ""));
      }
    }
  }
  norms.delete("");
  return norms;
}

// ---------------------------------------------------------------- messages
// What happened, as the banner should say it. An outcome is
// {status, left?, error?}: "ok" (left = words still to review), "failed",
// "offline", "token" (not connected), "busy", or "silent" (nothing to say).
export function errorText(error) {
  switch (error?.kind) {
    case "network": return "Can't reach GitHub. Your work is saved on this device.";
    case "auth": return "GitHub rejected the token. Open Settings to replace it.";
    case "forbidden":
      return `GitHub says no: ${error.message}. The token may be missing a permission.`;
    default: return error?.message || "Something went wrong.";
  }
}

export function outcomeText(outcome) {
  switch (outcome.status) {
    case "ok": return `Up to date · ${outcome.left} left`;
    case "offline": return "Offline. Your work is saved on this device.";
    case "token": return "Open Settings to connect to GitHub.";
    case "busy": return "Already refreshing. Try again in a moment.";
    case "failed": return errorText(outcome.error);
    default: return null;
  }
}

// After a button press (manual) every outcome is reported; in the background
// only real problems are, and not just being offline or out of reach.
export function shouldAnnounce(outcome, manual) {
  if (outcome.status === "silent") return false;
  if (manual) return true;
  return outcome.status === "failed" && outcome.error?.kind !== "network";
}

// The outcome of a sync.flush() result.
export function flushOutcome(result) {
  return result.error ? { status: "failed", error: result.error } : { status: "silent" };
}

// ------------------------------------------------------------------ lookup
// Links for checking a word outside the app. Points (nekudes) are dropped,
// since most web text has none, and a word shown with several spellings
// ("a/b") is looked up under its first.
const POINTS = /[\u0591-\u05c7]/g;

export function lookupLinks(item) {
  const text = item.word.split("/")[0].replace(POINTS, "").trim();
  const q = encodeURIComponent(text);
  const translate = `https://translate.google.com/?sl=yi&tl=en&op=translate&text=${q}`;
  const fallback = `S.browser_fallback_url=${encodeURIComponent(translate)}`;
  return {
    text,
    translate,
    search: `https://www.google.com/search?q=${encodeURIComponent(`"${text}"`)}`,
    // Android only: an intent asking the Translate app to translate shared
    // text, and one making Chrome (not the Translate app) open the web page.
    // Either falls back to the plain link if Chrome cannot deliver it.
    appIntent: "intent:#Intent;action=android.intent.action.SEND;type=text/plain;"
      + `package=com.google.android.apps.translate;S.android.intent.extra.TEXT=${q};${fallback};end`,
    chromeIntent: "intent://translate.google.com/?sl=yi&tl=en&op=translate&text="
      + `${q}#Intent;scheme=https;package=com.android.chrome;${fallback};end`,
  };
}
