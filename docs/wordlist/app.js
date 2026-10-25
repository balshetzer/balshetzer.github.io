// app.js — the screen. The rules live in logic.js, the GitHub calls in api.js.
import { ApiError, GitHub } from "./api.js";
import {
  TIERS, createSync, decisionFor, flushOutcome, hiddenSet, isConfirm,
  lookupLinks, newOutbox, newWordDecision, nextItem, normsFromRepo,
  outcomeText, pushDecision, pushDiscard, pushRevisit, pushSkip, pushTyped,
  remaining, requestRun, revisitHiddenSet, saveWork, shouldAnnounce,
  typedText, undo, workDecisions,
} from "./logic.js";

const REPO = "balshetzer/yiddish-cryptics";
const BRANCH = "main";
const STATE_KEY = "wordlist-state-v1";
const STALE_MS = 10 * 60 * 1000;    // refresh the queue when older than this

// ------------------------------------------------------------------ storage
function loadState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STATE_KEY)); } catch { /* none */ }
  const s = {
    token: "", queue: { items: [], fetchedAt: 0 }, revisit: { items: [] },
    entry: null,                // {text} while a new word is being typed in
    repoDecided: [],
    work: [], outbox: newOutbox(), sentRecently: {}, snoozed: {}, lastRun: null,
    ...(saved || {}),
  };
  const now = Date.now();
  for (const [n, t] of Object.entries(s.snoozed)) if (t <= now) delete s.snoozed[n];
  return s;
}

const state = loadState();

function persist() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* full or blocked */ }
}

const github = () => new GitHub({ token: state.token, repo: REPO, branch: BRANCH });

// --------------------------------------------------------------------- sync
const sync = createSync(() => state.outbox, {
  online: () => navigator.onLine,
  putBatch: (id, text, n) => github().putNew(
    `wordlist/inbox/${id}.tsv`, text, `Save ${n} decision${n === 1 ? "" : "s"} from the phone app`),
  dispatchRun: async () => {
    await github().dispatch();
    state.lastRun = { requestedAt: Date.now(), status: "requested" };
  },
  persist,
  sent: (norms) => { for (const n of norms) state.sentRecently[n] = Date.now(); },
});

// manual: a button was pressed, so say what happened (see announce).
async function flush({ manual = false } = {}) {
  if (!state.token) {
    announce({ status: "token" }, manual);
    return { error: null, noToken: true };
  }
  const result = await sync.flush();
  render();
  announce(flushOutcome(result), manual);
  if (result.ran) pollRun();
  return result;
}

// ------------------------------------------------------------------ refresh
let refreshing = false;
async function refresh({ manual = false } = {}) {
  const outcome = await fetchRepoState();
  announce(outcome, manual);
  return outcome;
}

// Returns an outcome (see logic.js); says nothing itself.
async function fetchRepoState() {
  if (!state.token) return { status: "token" };
  if (!navigator.onLine) return { status: "offline" };
  if (refreshing) return { status: "busy" };
  refreshing = true;
  let outcome = { status: "ok" };
  try {
    const gh = github();
    const [queueText, revisitText, overrides, excluded, myWords, inboxNames] = await Promise.all([
      gh.getText("wordlist/data/review_queue.json"),
      gh.getText("wordlist/data/revisit_queue.json"),
      gh.getText("wordlist/input/overrides.tsv"),
      gh.getText("wordlist/input/excluded_words.txt"),
      gh.getText("wordlist/input/my_words.txt"),
      gh.listFiles("wordlist/inbox"),
    ]);
    const inbox = await Promise.all(
      inboxNames.filter((n) => n.endsWith(".tsv")).slice(0, 40)
        .map((n) => gh.getText(`wordlist/inbox/${n}`)));
    if (queueText) {
      state.queue = { items: JSON.parse(queueText).items, fetchedAt: Date.now() };
    }
    if (revisitText) state.revisit = { items: JSON.parse(revisitText).items };
    state.repoDecided = [...normsFromRepo({ overrides, excluded, myWords, inbox })];
    persist();
  } catch (e) {
    outcome = { status: "failed", error: e };
  } finally {
    refreshing = false;
    render();
  }
  if (outcome.status === "ok") outcome.left = current().left;
  return outcome;
}

// ----------------------------------------------------------------- run poll
let polling = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollRun() {
  if (polling) return;
  polling = true;
  try {
    const since = state.lastRun?.requestedAt ?? Date.now();
    for (let i = 0; i < 80; i++) {
      await sleep(i === 0 ? 4000 : 6000);
      if (!navigator.onLine) continue;
      let run;
      try { run = await github().latestRun(); } catch { continue; }
      if (run && Date.parse(run.createdAt) >= since - 60000) {
        state.lastRun = { ...state.lastRun, ...run };
        persist();
        render();
        if (run.status === "completed") {
          if (run.conclusion === "success") await refresh();
          else toast("The run failed. Check the Actions tab on GitHub.");
          return;
        }
      }
    }
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------- rendering
const $ = (id) => document.getElementById(id);

// The queue first; once it is empty, the words already rated (revisit).
// -> {item, revisit: whether item comes from that list, left}
function current() {
  const hide = hiddenSet({ ...state, now: Date.now() });
  const item = nextItem(state.queue.items, hide);
  if (item) return { item, revisit: false, left: remaining(state.queue.items, hide) };
  const rhide = revisitHiddenSet({ ...state, now: Date.now() });
  const rest = nextItem(state.revisit.items, rhide);
  return { item: rest, revisit: Boolean(rest),
           left: rest ? remaining(state.revisit.items, rhide) : 0 };
}

const currentItem = () => current().item;

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function runText() {
  const r = state.lastRun;
  if (state.outbox.pendingRun) return "run queued";
  if (!r) return "";
  if (r.status === "requested") return "run requested";
  if (r.status !== "completed") return "run in progress";
  return `last run ${r.conclusion === "success" ? "finished" : "FAILED"} ${ago(Date.parse(r.createdAt))}`;
}

function render() {
  const { item, revisit, left } = current();
  const unsaved = workDecisions(state.work).size;
  const waiting = state.outbox.batches.length;
  const haveToken = Boolean(state.token);

  const entering = Boolean(state.entry);
  $("card").hidden = !item && !entering;
  $("empty").hidden = Boolean(item) || entering;
  $("word").hidden = entering;
  $("new-word").hidden = !entering;
  $("open-add").setAttribute("aria-pressed", String(entering));
  $("left").textContent = item && !entering ? `${left} ${revisit ? "to revisit" : "left"}` : "";

  if (entering) {
    showEntry();
  } else if (item) {
    const badges = $("badges");
    badges.replaceChildren();
    for (const label of [item.kind === "candidate" ? "new word" : null,
                         revisit ? "revisit" : null,
                         item.phrase ? "phrase" : null]) {
      if (!label) continue;
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = label;
      badges.append(b);
    }
    $("word").textContent = item.word;
    $("auto").textContent = item.kind === "excluded" ? "Excluded: you said not a word"
      : item.kind === "rated" ? `Your score: ${item.mine} · Auto: ${item.score}`
      : item.score != null ? `Auto score: ${item.score}` : "Not in the list yet";
    $("gloss").textContent = item.gloss || "";
    $("meta").textContent = `seen ${item.count.toLocaleString()}×`;
    const links = lookupLinks(item);
    setTranslate(links);
    $("copy").dataset.text = links.text;
    $("search").href = links.search;
  } else {
    $("empty-text").textContent = !haveToken
      ? "Open Settings to connect to GitHub."
      : state.queue.items.length
        ? "Nothing left to review or revisit for now. Save, then Run to get more."
        : "No queue yet. Tap ↻ to fetch it.";
  }
  for (const b of document.querySelectorAll(".tier")) {
    b.classList.toggle("current", !entering && Boolean(item) && item.kind === "rated" &&
                                  b.dataset.score === String(item.mine));
  }

  const typed = entering && newWordDecision($("new-word").value, 0).decision;
  for (const b of document.querySelectorAll(".tier")) b.disabled = entering ? !typed : !item;
  for (const b of document.querySelectorAll("#remove, #skip")) b.disabled = !entering && !item;
  $("undo").disabled = state.work.length === 0;

  $("save").textContent = unsaved ? `Save (${unsaved})` : "Save";
  $("save").disabled = unsaved === 0;
  $("save").classList.toggle("hot", unsaved > 0);
  $("run").textContent = state.outbox.pendingRun ? "Run (queued)" : "Run";
  $("run").disabled = !haveToken;

  const parts = [];
  if (waiting) parts.push(`${waiting} batch${waiting === 1 ? "" : "es"} waiting to upload`);
  const rt = runText();
  if (rt) parts.push(rt);
  if (!navigator.onLine) parts.push("offline");
  $("status").textContent = parts.join(" · ");

  $("snoozed-count").textContent = Object.keys(state.snoozed).length;
}

let toastTimer = 0;
function toast(message) {
  $("toast-text").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, 6000);
}

function dismissToast() {
  clearTimeout(toastTimer);
  $("toast").hidden = true;
}
$("toast").addEventListener("click", dismissToast);   // anywhere on the banner

// On Android, Translate is an intent to the Translate app; elsewhere it is
// the web page, in a new tab.
const ANDROID = /Android/i.test(navigator.userAgent);

function setTranslate(links) {
  const a = $("translate");
  a.href = ANDROID ? links.appIntent : links.translate;
  if (ANDROID) a.removeAttribute("target");
}

$("copy").addEventListener("click", () => {
  const text = $("copy").dataset.text;
  if (!text) return;
  navigator.clipboard?.writeText(text).then(
    () => toast("Copied"),
    () => toast("Couldn't copy"));
});

// The one place the app talks to you about how something went.
function announce(outcome, manual) {
  if (!shouldAnnounce(outcome, manual)) return;
  const text = outcomeText(outcome);
  if (text) toast(text);
}

// ------------------------------------------------------------------ actions
function decide(action, score) {
  if (state.entry) {
    if (action === "remove") {              // not a word: never sent
      const text = $("new-word").value.trim();
      if (text) pushDiscard(state.work, text);
    } else {
      const { decision, error } = newWordDecision($("new-word").value, score);
      if (error) { toast(error); return; }
      pushTyped(state.work, decision);
    }
    setEntry(null);
    return;
  }
  const item = currentItem();
  if (!item) return;
  if (current().revisit) {
    pushRevisit(state.work, state.snoozed, item.norm,
                isConfirm(item, action, score) ? null : decisionFor(item, action, score),
                Date.now());
  } else {
    pushDecision(state.work, decisionFor(item, action, score));
  }
  persist();
  render();
}

function buildTiers() {
  const tiers = $("tiers");
  for (const [name, score] of TIERS) {
    const b = document.createElement("button");
    b.className = "tier";
    b.dataset.score = String(score);
    b.textContent = `${name} (${score})`;
    b.addEventListener("click", () => decide("score", score));
    tiers.append(b);
  }
}

$("remove").addEventListener("click", () => decide("remove"));
$("skip").addEventListener("click", () => {
  if (state.entry) { setEntry(null); return; }   // cancel the new word
  const item = currentItem();
  if (!item) return;
  pushSkip(state.work, state.snoozed, item.norm, Date.now());
  persist();
  render();
});
$("undo").addEventListener("click", () => {
  const text = typedText(undo(state.work, state.snoozed));
  if (text != null) { setEntry(text); return; }   // bring the typed word back
  persist();
  render();
});

$("save").addEventListener("click", () => {
  if (!saveWork(state.outbox, state.work, Date.now())) return;
  persist();
  render();
  flush({ manual: true });
});
$("run").addEventListener("click", () => {
  requestRun(state.outbox);
  persist();
  render();
  flush({ manual: true });
});
// The ↻ button spins while it works; announce() then says what happened.
$("refresh").addEventListener("click", async () => {
  const button = $("refresh");
  if (button.classList.contains("spinning")) return;
  button.classList.add("spinning");
  try {
    await Promise.all([
      (async () => {
        const sent = await flush({ manual: true });
        if (!sent.error && !sent.noToken) await refresh({ manual: true });
      })(),
      sleep(700),                  // long enough to be seen on a fast connection
    ]);
  } finally {
    button.classList.remove("spinning");
  }
});

// ----------------------------------------------------------- typing a new word
// + turns the card into an entry box; a score then adds the word like any other
// answer and moves on, and undo brings the typed word back for another score.
// "Not a word" drops it: it is never sent.
function setEntry(text) {           // null leaves entry mode
  state.entry = text == null ? null : { text };
  if (state.entry) $("new-word").value = text;
  persist();
  render();
  if (state.entry) $("new-word").focus();
}

function showEntry() {
  const { decision } = newWordDecision($("new-word").value, 0);
  const badges = $("badges");
  badges.replaceChildren();
  const b = document.createElement("span");
  b.className = "badge";
  b.textContent = "new word";
  badges.append(b);
  const known = new Set(state.repoDecided);
  for (const batch of state.outbox.batches) for (const n of Object.keys(batch.decisions)) known.add(n);
  for (const n of workDecisions(state.work).keys()) known.add(n);
  $("auto").textContent = !decision ? "Type a word, then tap a score"
    : known.has(decision.norm) ? "Already in your lists. A score replaces the old one."
    : "Tap a score to add it";
  $("gloss").textContent = "";
  $("meta").textContent = "";
  if (decision) {
    const links = lookupLinks({ word: decision.word });
    setTranslate(links);
    $("copy").dataset.text = links.text;
    $("search").href = links.search;
  } else {
    for (const id of ["translate", "search"]) $(id).removeAttribute("href");
    $("copy").dataset.text = "";
  }
}

$("open-add").addEventListener("click", () => setEntry(state.entry ? null : ""));
$("new-word").addEventListener("input", () => {
  state.entry = { text: $("new-word").value };
  persist();
  render();
});

// ----------------------------------------------------------------- settings
function showSettings(show) {
  $("settings").hidden = !show;
  if (show) {
    $("token").value = "";
    $("connection").textContent = state.token ? "A token is saved on this device." : "No token yet.";
  }
}
$("open-settings").addEventListener("click", () => showSettings(true));
$("close-settings").addEventListener("click", () => showSettings(false));

$("connect").addEventListener("click", async () => {
  const token = $("token").value.trim();
  if (!token) return;
  $("connection").textContent = "Checking…";
  const probe = new GitHub({ token, repo: REPO, branch: BRANCH });
  try {
    const result = await probe.check();
    if (!result.ok) { $("connection").textContent = result.reason; return; }
    state.token = token;
    persist();
    $("connection").textContent = "Connected.";
    $("token").value = "";
    showSettings(false);
    await refresh({ manual: true });
    await flush();
  } catch (e) {
    $("connection").textContent = e instanceof ApiError && e.kind === "auth"
      ? "GitHub rejected that token."
      : e instanceof ApiError && e.kind === "missing"
        ? "That token can't see the repo. Check its repository access."
        : e.message;
  }
});
$("sign-out").addEventListener("click", () => {
  state.token = "";
  persist();
  $("connection").textContent = "Signed out. Your unsaved work is still on this device.";
  render();
});
$("unskip").addEventListener("click", () => { state.snoozed = {}; persist(); render(); });

fetch("build.json", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((b) => { $("version").textContent = `Version ${b.commit.slice(0, 7)}, published ${b.published}`; })
  .catch(() => { $("version").textContent = ""; });

// -------------------------------------------------------------------- start
buildTiers();
if (state.entry) $("new-word").value = state.entry.text;
render();
if (!state.token) showSettings(true);
window.addEventListener("online", () => { flush(); render(); });
window.addEventListener("offline", render);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  flush();
  if (Date.now() - state.queue.fetchedAt > STALE_MS) refresh();
});
flush();
if (Date.now() - state.queue.fetchedAt > STALE_MS) refresh();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* not available */ });
}
