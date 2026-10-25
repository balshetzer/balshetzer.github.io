// app.js — the screen. The rules live in logic.js, the GitHub calls in api.js.
import { ApiError, GitHub } from "./api.js";
import {
  TIERS, createSync, decisionFor, hiddenSet, newOutbox, nextItem,
  normsFromRepo, pushDecision, pushSkip, remaining, requestRun, saveWork,
  undo, workDecisions,
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
    token: "", queue: { items: [], fetchedAt: 0 }, repoDecided: [],
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

async function flush({ quiet = true } = {}) {
  if (!state.token) return;
  const result = await sync.flush();
  render();
  if (result.error) report(result.error, quiet);
  if (result.ran) pollRun();
  return result;
}

// ------------------------------------------------------------------ refresh
let refreshing = false;
// Returns "ok", "failed", or why nothing was done: "token", "offline", "busy".
async function refresh({ quiet = true } = {}) {
  if (!state.token) return "token";
  if (!navigator.onLine) return "offline";
  if (refreshing) return "busy";
  refreshing = true;
  let outcome = "ok";
  try {
    const gh = github();
    const [queueText, overrides, excluded, myWords, inboxNames] = await Promise.all([
      gh.getText("wordlist/data/review_queue.json"),
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
    state.repoDecided = [...normsFromRepo({ overrides, excluded, myWords, inbox })];
    persist();
  } catch (e) {
    report(e, quiet);
    outcome = "failed";
  } finally {
    refreshing = false;
    render();
  }
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

function currentItem() {
  return nextItem(state.queue.items, hidden());
}

function hidden() {
  return hiddenSet({ ...state, repoDecided: state.repoDecided, now: Date.now() });
}

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
  const hide = hidden();
  const item = nextItem(state.queue.items, hide);
  const unsaved = workDecisions(state.work).size;
  const waiting = state.outbox.batches.length;
  const haveToken = Boolean(state.token);

  $("card").hidden = !item;
  $("empty").hidden = Boolean(item);
  $("left").textContent = state.queue.items.length ? `${remaining(state.queue.items, hide)} left` : "";

  if (item) {
    const badges = $("badges");
    badges.replaceChildren();
    for (const label of [item.kind === "candidate" ? "new word" : null,
                         item.phrase ? "phrase" : null]) {
      if (!label) continue;
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = label;
      badges.append(b);
    }
    $("word").textContent = item.word;
    $("auto").textContent = item.score != null
      ? `Auto score: ${item.score}` : "Not in the list yet";
    $("gloss").textContent = item.gloss || "";
    $("meta").textContent = `seen ${item.count.toLocaleString()}×`;
  } else {
    $("empty-text").textContent = !haveToken
      ? "Open Settings to connect to GitHub."
      : state.queue.items.length
        ? "That's everything in this queue. Save, then Run to get more."
        : "No queue yet. Tap ↻ to fetch it.";
  }

  for (const b of document.querySelectorAll(".tier, #remove, #skip")) b.disabled = !item;
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

function report(error, quiet) {
  if (error instanceof ApiError && error.kind === "network") {
    if (!quiet) toast("Can't reach GitHub. Your work is saved on this device.");
  } else if (error instanceof ApiError && error.kind === "auth") {
    toast("GitHub rejected the token. Open Settings to replace it.");
  } else if (error instanceof ApiError && error.kind === "forbidden") {
    toast(`GitHub says no: ${error.message}. The token may be missing a permission.`);
  } else {
    toast(error?.message || "Something went wrong.");
  }
}

// ------------------------------------------------------------------ actions
function decide(action, score) {
  const item = currentItem();
  if (!item) return;
  pushDecision(state.work, decisionFor(item, action, score));
  persist();
  render();
}

function buildTiers() {
  const tiers = $("tiers");
  for (const [name, score] of TIERS) {
    const b = document.createElement("button");
    b.className = "tier";
    b.textContent = `${name} (${score})`;
    b.addEventListener("click", () => decide("score", score));
    tiers.append(b);
  }
}

$("remove").addEventListener("click", () => decide("remove"));
$("skip").addEventListener("click", () => {
  const item = currentItem();
  if (!item) return;
  pushSkip(state.work, state.snoozed, item.norm, Date.now());
  persist();
  render();
});
$("undo").addEventListener("click", () => { undo(state.work, state.snoozed); persist(); render(); });

$("save").addEventListener("click", () => {
  if (!saveWork(state.outbox, state.work, Date.now())) return;
  persist();
  render();
  flush({ quiet: false });
});
$("run").addEventListener("click", () => {
  requestRun(state.outbox);
  persist();
  render();
  flush({ quiet: false });
});
// The ↻ button spins while it works, then says what happened.
$("refresh").addEventListener("click", async () => {
  const button = $("refresh");
  if (button.classList.contains("spinning")) return;
  button.classList.add("spinning");
  try {
    const [, outcome] = await Promise.all([
      flush({ quiet: false }).then(() => refresh({ quiet: false })),
      sleep(700),                  // long enough to be seen on a fast connection
    ]);
    if (outcome === "ok") {
      toast(`Up to date · ${remaining(state.queue.items, hidden())} left`);
    } else if (outcome === "offline") {
      toast("Offline. Your work is saved on this device.");
    } else if (outcome === "token") {
      toast("Open Settings to connect to GitHub.");
    }                              // "failed": refresh() already said why
  } finally {
    button.classList.remove("spinning");
  }
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
    await refresh({ quiet: false });
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
