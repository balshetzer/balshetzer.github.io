// api.js — the few GitHub calls the app makes, using a personal access token
// (Contents: read/write and Actions: read/write on the one repo).

export class ApiError extends Error {
  // kind: "auth" (bad or expired token), "forbidden" (token lacks a
  // permission, or rate limited), "missing", "network", "server"
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const b64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
};

export class GitHub {
  constructor({ token, repo, branch = "main", fetchImpl = (...a) => fetch(...a),
                workflow = "run-pipeline.yml" }) {
    this.token = token;
    this.repo = repo;
    this.branch = branch;
    this.workflow = workflow;
    this.fetch = fetchImpl;
  }

  async request(method, path, { body, raw = false } = {}) {
    let res;
    try {
      res = await this.fetch(`https://api.github.com${path}`, {
        method,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError("network", "Can't reach GitHub");
    }
    if (res.ok) return res;
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch { /* no body */ }
    if (res.status === 401) throw new ApiError("auth", "GitHub rejected the token", 401);
    if (res.status === 403 || res.status === 429) {
      throw new ApiError("forbidden", detail || "Not allowed", res.status);
    }
    if (res.status === 404) throw new ApiError("missing", detail || "Not found", 404);
    if (res.status === 422) throw new ApiError("exists", detail || "Already exists", 422);
    throw new ApiError("server", detail || `GitHub error ${res.status}`, res.status);
  }

  contents(path) {
    return `/repos/${this.repo}/contents/${path}`;
  }

  // The text of a file on the branch ("" if it does not exist).
  async getText(path) {
    try {
      const res = await this.request("GET", `${this.contents(path)}?ref=${this.branch}`, { raw: true });
      return await res.text();
    } catch (e) {
      if (e.kind === "missing") return "";
      throw e;
    }
  }

  // File names in a directory on the branch ([] if it does not exist).
  async listFiles(dir) {
    try {
      const res = await this.request("GET", `${this.contents(dir)}?ref=${this.branch}`);
      return (await res.json()).filter((e) => e.type === "file").map((e) => e.name);
    } catch (e) {
      if (e.kind === "missing") return [];
      throw e;
    }
  }

  // Create a file that must not exist yet. If it already does (a retried
  // upload that had in fact gone through), that counts as done.
  async putNew(path, text, message) {
    try {
      await this.request("PUT", this.contents(path), {
        body: { message, content: b64(text), branch: this.branch },
      });
      return "created";
    } catch (e) {
      if (e.kind === "exists") return "exists";
      throw e;
    }
  }

  async dispatch() {
    await this.request("POST", `/repos/${this.repo}/actions/workflows/${this.workflow}/dispatches`, {
      body: { ref: this.branch },
    });
  }

  // The newest run of the pipeline workflow on this branch, or null.
  async latestRun() {
    const res = await this.request(
      "GET",
      `/repos/${this.repo}/actions/workflows/${this.workflow}/runs?branch=${this.branch}&per_page=1`);
    const run = (await res.json()).workflow_runs[0];
    return run ? { id: run.id, status: run.status, conclusion: run.conclusion,
                   createdAt: run.created_at, url: run.html_url } : null;
  }

  // Can this token write to the repo? Returns {ok, reason}.
  async check() {
    const res = await this.request("GET", `/repos/${this.repo}`);
    const info = await res.json();
    return info.permissions && info.permissions.push
      ? { ok: true } : { ok: false, reason: "The token can read the repo but not write to it" };
  }
}
