"use strict";
// cmux-copilot-artifacts — core.
//
// Copilot CLI hooks run *inside* the cmux tab, so they are trusted by cmux's cmuxOnly
// control socket. On those hooks we:
//   1. open each PR/issue/gist/codespace the session created/updated as a browser TAB to
//      the right of the terminal, in the same pane (on create, update, and resumption);
//   2. push a compact artifact count to the cmux sidebar status pill.
//
// Artifact detection + live PR state are reused from copilot-pr-footer (same events.jsonl
// parsing and gh-state cache as the footer).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { sessionArtifacts, prStates } = require("copilot-pr-footer/lib/artifacts");

const SESSIONS_DIR = path.join(os.homedir(), ".copilot", "session-state");
const STATE_DIR = path.join(os.homedir(), ".config", "occs", "opened");
const HOOK_SESSIONS = path.join(os.homedir(), ".cmuxterm", "copilot-hook-sessions.json");
const PILL_KEY = "copilot-artifacts";

// ── cmux bin (absolute, PATH-independent) ──────────────────────────────────────
let CMUX_BIN = null;
function cmuxBin() {
  if (CMUX_BIN) return CMUX_BIN;
  if (process.env.CMUX_BUNDLED_CLI_PATH && fs.existsSync(process.env.CMUX_BUNDLED_CLI_PATH)) return (CMUX_BIN = process.env.CMUX_BUNDLED_CLI_PATH);
  for (const c of [
    "/Applications/cmux.app/Contents/Resources/bin/cmux",
    path.join(os.homedir(), "Applications/cmux.app/Contents/Resources/bin/cmux"),
    "/opt/homebrew/bin/cmux", "/usr/local/bin/cmux",
  ]) { try { if (fs.existsSync(c)) return (CMUX_BIN = c); } catch {} }
  return (CMUX_BIN = "cmux");
}
function cmux(args, timeout) {
  return execFileSync(cmuxBin(), args, { encoding: "utf8", timeout: timeout || 5000, stdio: ["ignore", "pipe", "ignore"] });
}
function cmuxOk(args, timeout) { try { cmux(args, timeout); return true; } catch { return false; } }
function cmuxJson(args, timeout) { try { return JSON.parse(cmux(args, timeout)); } catch { return null; } }

// ── which session fired this hook ───────────────────────────────────────────────
// Copilot passes a JSON event on stdin; prefer its session id / transcript path. Fall
// back to cmux's per-surface session record, then the newest session on disk.
function resolveSession(stdinStr) {
  let p = {};
  if (stdinStr && stdinStr.trim()) { try { p = JSON.parse(stdinStr) || {}; } catch {} }
  const id = p.session_id || p.sessionId || p.session || "";
  const tpath = p.transcript_path || p.transcriptPath || "";
  if (tpath && fs.existsSync(tpath)) return { sessionId: path.basename(tpath), dir: tpath, exact: true };
  if (id) { const dir = path.join(SESSIONS_DIR, id); if (fs.existsSync(dir)) return { sessionId: id, dir, exact: true }; }

  const surf = process.env.CMUX_SURFACE_ID;
  if (surf) {
    try {
      const rec = JSON.parse(fs.readFileSync(HOOK_SESSIONS, "utf8"));
      for (const s of Object.values(rec.sessions || {})) {
        if (s.surfaceId === surf && s.sessionId) {
          const dir = path.join(SESSIONS_DIR, s.sessionId);
          if (fs.existsSync(dir)) return { sessionId: s.sessionId, dir, exact: true };
        }
      }
    } catch {}
  }
  // newest events.jsonl
  try {
    let best = null;
    for (const n of fs.readdirSync(SESSIONS_DIR)) {
      try {
        const mt = fs.statSync(path.join(SESSIONS_DIR, n, "events.jsonl")).mtimeMs;
        if (!best || mt > best.mt) best = { id: n, mt };
      } catch {}
    }
    if (best) return { sessionId: best.id, dir: path.join(SESSIONS_DIR, best.id) };
  } catch {}
  return { sessionId: "", dir: "" };
}

// ── artifacts for one session (deduped, push:// resolved) ───────────────────────
function collect(dir) {
  if (!dir) return { arts: [], states: {} };
  const raw = sessionArtifacts(dir);
  const states = prStates(raw.filter((a) => a.kind === "pr").map((a) => a.url));
  const seen = new Set();
  const arts = [];
  for (const a of raw) {
    let url = a.url;
    if (a.kind === "pr" && url.startsWith("push://")) {
      url = (states[url] && states[url].url) || "";
      if (!url) continue;
    }
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    arts.push({ kind: a.kind, url, origin: a.origin });
  }
  return { arts, states };
}

// ── opened-state (per session) ──────────────────────────────────────────────────
function stateFile(sessionId) { return path.join(STATE_DIR, (sessionId || "default") + ".json"); }
function loadOpened(sessionId) {
  try { return new Set(JSON.parse(fs.readFileSync(stateFile(sessionId), "utf8")).opened || []); } catch { return new Set(); }
}
function saveOpened(sessionId, set) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  const f = stateFile(sessionId), tmp = f + "." + process.pid + ".tmp";
  try { fs.writeFileSync(tmp, JSON.stringify({ opened: [...set] })); fs.renameSync(tmp, f); } catch {}
}

// Browser tab URLs already open in this workspace (so we never duplicate a tab).
function currentTabUrls() {
  const ws = process.env.CMUX_WORKSPACE_ID;
  const tree = cmuxJson(["tree", "--all", "--json", "--id-format", "both"]);
  const out = new Set();
  if (!tree) return out;
  for (const win of (tree.windows || [])) {
    for (const w of (win.workspaces || [])) {
      if (ws && w.id && w.id !== ws) continue;
      for (const pane of (w.panes || [])) {
        for (const s of (pane.surfaces || [])) {
          if (s.type === "browser" && s.url) out.add(s.url);
        }
      }
    }
  }
  return out;
}

// Classify a (possibly navigated) URL as a GitHub artifact, returning its canonical url
// so a PR tab the user navigated within (…/pull/123/files) still matches …/pull/123.
function artifactFromUrl(url) {
  let m;
  if ((m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)))
    return { kind: "pr", url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` };
  if ((m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/)))
    return { kind: "issue", url: `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}` };
  if ((m = url.match(/^https?:\/\/gist\.[\w.-]+\/(?:[\w-]+\/)?[0-9a-f]{8,}/)))
    return { kind: "gist", url: m[0] };
  if (/^https?:\/\/github\.com\/codespaces\//.test(url))
    return { kind: "codespace", url: url.split("?")[0] };
  return null;
}

// Pure: dedupe a list of tab urls into the distinct artifacts they represent (canonical).
function classifyTabs(urls) {
  const seen = new Map();
  for (const u of urls) {
    const a = artifactFromUrl(u);
    if (a && !seen.has(a.url)) seen.set(a.url, a);
  }
  return [...seen.values()];
}

// Artifacts whose browser tab is currently open in this workspace (canonical, deduped).
function currentTabArtifacts() { return classifyTabs([...currentTabUrls()]); }

// Pure: which artifact urls to open now.
//  - SessionStart (resume): open any not currently shown as a tab (restore after restart),
//    ignoring the opened-set so a relaunched cmux gets its tabs back.
//  - otherwise (create/update): open any not already opened this session and not already a
//    tab — so each artifact opens once and a tab the user closed stays closed.
function urlsToOpen(urls, opened, currentTabs, event) {
  const resume = event === "SessionStart";
  return urls.filter((u) => !currentTabs.has(u) && (resume || !opened.has(u)));
}

// Open each url as a browser tab to the right of the terminal, in the same pane.
// Tabs open in the background (--focus false). After opening, focus is re-asserted on
// the terminal: cmux honors --focus false, but a freshly loaded browser webview can still
// grab OS keyboard focus, so we snap it back so the user never has to click to the terminal.
function openTabs(urls) {
  const surf = process.env.CMUX_SURFACE_ID;
  if (!surf) return [];
  const opened = [];
  for (const u of urls) {
    if (cmuxOk(["tab-action", "--tab", surf, "--action", "new-browser-right", "--url", u, "--focus", "false"])) opened.push(u);
  }
  if (opened.length) cmuxOk(["rpc", "surface.focus", JSON.stringify({ surface_id: surf })]);
  return opened;
}

// ── workspace title ─────────────────────────────────────────────────────────────
// cmux doesn't mirror a tab's title onto its workspace, so the space name keeps the
// cwd basename ("Work"). We re-apply the Copilot session name to the workspace on each
// hook (a one-shot rename loses to cmux's creation-time title) — UNLESS the user
// renamed the space by hand, in which case their name wins from then on.
const TITLES_FILE = path.join(os.homedir(), ".config", "occs", "titles.json");
const TAB_SUFFIX = / - GitHub Copilot$/;
const AUTO_TITLES = new Set(["copilot", "github copilot"]);
const SEEN_MAX = 20;
function loadTitle(ws) {
  try { return (JSON.parse(fs.readFileSync(TITLES_FILE, "utf8")) || {})[ws] || {}; } catch { return {}; }
}
function saveTitle(ws, rec) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(TITLES_FILE, "utf8")) || {}; } catch {}
  all[ws] = rec;
  try { fs.mkdirSync(path.dirname(TITLES_FILE), { recursive: true }); } catch {}
  const tmp = TITLES_FILE + "." + process.pid + ".tmp";
  try { fs.writeFileSync(tmp, JSON.stringify(all)); fs.renameSync(tmp, TITLES_FILE); } catch {}
}

// Session name from <session>/workspace.yaml (`dir` may also be a transcript file).
function sessionName(dir) {
  if (!dir) return "";
  let yaml = "";
  for (const f of [path.join(dir, "workspace.yaml"), path.join(path.dirname(dir), "workspace.yaml")]) {
    try { yaml = fs.readFileSync(f, "utf8"); break; } catch {}
  }
  const m = yaml.match(/^name:[ \t]*(.*)$/m);
  return m ? yamlScalar(m[1]) : "";
}

// Decode a one-line YAML scalar; unsupported forms (block scalars, flow, anchors) -> "".
function yamlScalar(raw) {
  const v = raw.trim();
  if (v.startsWith("'")) {
    const m = v.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    return m ? m[1].replace(/''/g, "'") : "";
  }
  if (v.startsWith('"')) {
    const m = v.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    try { return m ? JSON.parse(m[1]) : ""; } catch { return ""; }
  }
  if (/^[|>&*!{[@`%]/.test(v)) return "";
  return v.replace(/\s+#.*$/, "").trim();
}

function cleanTabTitle(t) { return (t || "").replace(TAB_SUFFIX, "").trim(); }

// Pure: extract the current workspace title (cur) and its first terminal tab title (tab).
function workspaceTitles(tree, ws) {
  let cur = "", tab = "";
  for (const win of (tree && tree.windows || [])) {
    for (const w of (win.workspaces || [])) {
      if (w.id !== ws) continue;
      cur = w.title || "";
      for (const pane of (w.panes || [])) {
        for (const s of (pane.surfaces || [])) {
          if (s.type === "terminal" && s.title && !tab) tab = s.title;
        }
      }
    }
  }
  return { cur, tab };
}

// Pure: decide the next title. `ours` is what we last applied; `manual` is a user-chosen
// name once detected; `seen` holds titles cmux or Copilot produced (never a hand rename).
// Only a title that matches none of those, nor a cwd basename in `bases`, counts as a
// hand rename. Returns { rename, ours, manual, seen }.
function nextWorkspaceTitle({ cur, tab, name, base, bases, ours, manual, seen }) {
  cur = cur || "";
  bases = (bases || [base]).filter(Boolean);
  seen = (seen || []).filter(Boolean);
  const cleanTab = cleanTabTitle(tab);
  const isDefault = (t) => bases.includes(t) || AUTO_TITLES.has(t.toLowerCase()) || TAB_SUFFIX.test(t) || seen.includes(t);
  if (manual && (isDefault(manual) || manual === name || manual === cleanTab)) manual = null;
  if (cur && !isDefault(cur) && ![tab, cleanTab, name, ours].includes(cur)) manual = cur;
  const desired = manual || name || cleanTab;
  const rename = (desired && desired !== cur) ? desired : null;
  const next = rename || cur;
  const auto = [tab, cleanTab, name, manual ? null : next].filter(Boolean);
  seen = [...seen.filter((t) => !auto.includes(t)), ...new Set(auto)].slice(-SEEN_MAX);
  return { rename, ours: next, manual: manual || null, seen };
}

function syncWorkspaceTitle({ dir, cwd } = {}) {
  const ws = process.env.CMUX_WORKSPACE_ID;
  if (!ws) return;
  const tree = cmuxJson(["tree", "--all", "--json", "--id-format", "both"]);
  if (!tree) return;
  const { cur, tab } = workspaceTitles(tree, ws);
  const bases = [...new Set([cwd, process.cwd()].filter(Boolean).map((p) => path.basename(p)))];
  const prev = loadTitle(ws);
  const next = nextWorkspaceTitle({ cur, tab, name: sessionName(dir), bases, ours: prev.ours, manual: prev.manual, seen: prev.seen });
  if (next.rename) cmuxOk(["rename-workspace", "--workspace", ws, "--", next.rename]);
  const rec = { ours: next.ours, manual: next.manual, seen: next.seen };
  if (JSON.stringify(rec) !== JSON.stringify({ ours: prev.ours, manual: prev.manual || null, seen: prev.seen || [] })) saveTitle(ws, rec);
}

// ── status pill ─────────────────────────────────────────────────────────────────
// Roll the tracked PRs' state into one pill: a count, glyphs for CI / review / merge
// conflict, and a color.
//   color:  violet = all merged · red = CI failed / conflict / changes requested ·
//           yellow = CI pending · green = open & CI passed · blue = neutral
//   glyphs: ci ✓ / … / ✗ · review appr / chg / rev? · "conflict" when mergeable=CONFLICTING
const PILL = { merged: "#a371f7", bad: "#f85149", pending: "#d29922", ok: "#3fb950", neutral: "#58a6ff" };
const up = (s) => String(s || "").toUpperCase();

function pillText(arts, states) {
  if (!arts.length) return null;
  const prs = arts.filter((a) => a.kind === "pr");
  const issues = arts.filter((a) => a.kind === "issue").length;
  const gists = arts.filter((a) => a.kind === "gist").length;
  const codespaces = arts.filter((a) => a.kind === "codespace").length;

  const parts = [];
  let color = PILL.neutral;

  if (prs.length) {
    const sts = prs.map((a) => states[a.url]).filter(Boolean);
    const some = (f) => sts.some(f);
    const allOf = (f) => sts.length > 0 && sts.every(f);

    const allMerged = allOf((s) => up(s.state) === "MERGED");
    const ciFailed = some((s) => s.ci === "failed");
    const ciRunning = some((s) => s.ci === "running");
    const ciPassed = some((s) => s.ci === "passed");
    const conflict = some((s) => up(s.mergeable) === "CONFLICTING");
    const changes = some((s) => s.review === "CHANGES_REQUESTED");
    const approved = allOf((s) => s.review === "APPROVED");
    const reviewReq = some((s) => s.review === "REVIEW_REQUIRED");

    const g = [];
    if (allMerged) {
      g.push("merged");
    } else {
      if (ciFailed) g.push("\u2717");
      else if (ciRunning) g.push("\u2026");
      else if (ciPassed) g.push("\u2713");
      if (conflict) g.push("conflict");
      if (changes) g.push("chg");
      else if (approved) g.push("appr");
      else if (reviewReq) g.push("rev?");
    }
    parts.push(`${prs.length} PR${g.length ? " " + g.join(" ") : ""}`);

    if (ciFailed || conflict || changes) color = PILL.bad;
    else if (ciRunning) color = PILL.pending;
    else if (allMerged) color = PILL.merged;
    else if (ciPassed) color = PILL.ok;
  }
  if (issues) parts.push(`${issues} issue`);
  if (gists) parts.push(`${gists} gist`);
  if (codespaces) parts.push(`${codespaces} codespace`);
  if (!parts.length) return null;
  return { text: parts.join(" \u00b7 "), color, icon: "arrow.triangle.pull" };
}

function updatePill(arts, states) {
  const p = pillText(arts, states);
  if (!p) { cmuxOk(["clear-status", PILL_KEY]); return; }
  cmuxOk(["set-status", PILL_KEY, p.text, "--icon", p.icon, "--color", p.color, "--priority", "5"]);
}

// ── pill freshness after hooks stop ──────────────────────────────────────────────
// The pill is pushed only when a Copilot hook fires. CI on a big repo settles long
// after the session's last hook (an idle session, or a single multi-minute tool call),
// so the pill freezes at whatever CI state it last saw — e.g. a failed old commit that
// a later force-push turned green. When any tracked PR's CI is still running we hand off
// to a bounded, self-refreshing poller (one per surface) that re-pushes the pill until
// CI settles.
const WATCH_TICK_MS = 30 * 1000;
const WATCH_MAX_MS = 45 * 60 * 1000; // CI's realistic ceiling; give up after this
function watchLock(surface) { return path.join(STATE_DIR, "watch-" + (surface || "default") + ".lock"); }
function watchRunning(surface) {
  try { return Date.now() - fs.statSync(watchLock(surface)).mtimeMs < WATCH_TICK_MS * 3; } catch { return false; }
}
function touchWatch(surface) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(watchLock(surface), String(Date.now())); } catch {}
}
function clearWatch(surface) { try { fs.unlinkSync(watchLock(surface)); } catch {} }

// A tracked PR is "settled" once CI is no longer running (or it left OPEN). No tracked
// PRs at all -> nothing to watch (settled).
function pillSettled(arts, states) {
  const prs = arts.filter((a) => a.kind === "pr");
  if (!prs.length) return true;
  return prs.every((a) => {
    const s = states[a.url];
    if (!s) return false;
    const st = String(s.state || "").toUpperCase();
    return st === "MERGED" || st === "CLOSED" || s.ci !== "running";
  });
}

// Detached loop: refresh the pill from live PR state every tick until settled or capped.
function watchPill(surface) {
  const started = Date.now();
  const tick = () => {
    touchWatch(surface);
    const arts = currentTabArtifacts();
    const states = prStates(arts.filter((a) => a.kind === "pr").map((a) => a.url));
    updatePill(arts, states);
    if (pillSettled(arts, states) || Date.now() - started > WATCH_MAX_MS) { clearWatch(surface); return; }
    setTimeout(tick, WATCH_TICK_MS);
  };
  tick();
}

// Spawn the poller (once per surface) when CI is still running after a hook.
function ensureWatcher(surface, arts, states) {
  if (!surface || pillSettled(arts, states) || watchRunning(surface)) return;
  touchWatch(surface);
  try {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "bin", "cli.js"), "pill-watch", surface], { detached: true, stdio: "ignore" });
    child.unref();
  } catch { clearWatch(surface); }
}

// ── hook entrypoint ─────────────────────────────────────────────────────────────
// Two layers:
//   1. auto-open  — open each PR/issue/gist the session created/updated as a tab, once;
//      a tab the user closed is not reopened (resume restores all).
//   2. pill       — tracking is tied to TABS: the sidebar pill reflects exactly the
//      artifact tabs currently open. Close a tab and it leaves the pill; open one (an
//      auto-opened PR, a reopened tab, or any PR you open yourself) and it joins.
function runHook(event, stdinStr) {
  if (!process.env.CMUX_SURFACE_ID) return; // not inside cmux
  const { sessionId, dir, exact } = resolveSession(stdinStr);
  let cwd = "";
  try { const p = JSON.parse(stdinStr || "{}") || {}; cwd = p.cwd || p.workingDirectory || p.working_directory || ""; } catch {}

  // canonical urls of artifact tabs open right now (tolerant of in-tab navigation)
  const tabKeys = new Set(currentTabArtifacts().map((a) => a.url));

  // 1) auto-open new session artifacts (skip ones already a tab or already opened once)
  let justOpened = [];
  if (dir) {
    const { arts } = collect(dir);
    const urls = arts.map((a) => a.url);
    const opened = loadOpened(sessionId);
    justOpened = openTabs(urlsToOpen(urls, opened, tabKeys, event));
    let changed = false;
    for (const u of [...justOpened, ...urls.filter((x) => tabKeys.has(x))]) {
      if (!opened.has(u)) { opened.add(u); changed = true; }
    }
    if (changed) saveOpened(sessionId, opened);
  }

  // 2) pill = open artifact tabs (+ anything just opened, in case the tree read lags)
  const tracked = currentTabArtifacts();
  for (const u of justOpened) {
    const a = artifactFromUrl(u);
    if (a && !tracked.some((t) => t.url === a.url)) tracked.push(a);
  }
  const states = prStates(tracked.filter((a) => a.kind === "pr").map((a) => a.url));
  updatePill(tracked, states);
  ensureWatcher(process.env.CMUX_SURFACE_ID, tracked, states);

  // 3) keep the space name in sync with the Copilot session name
  syncWorkspaceTitle({ dir: exact ? dir : "", cwd });
}

module.exports = {
  cmuxBin, resolveSession, collect, urlsToOpen, openTabs, pillText, updatePill,
  loadOpened, saveOpened, currentTabUrls, currentTabArtifacts, classifyTabs,
  artifactFromUrl, runHook, syncWorkspaceTitle, workspaceTitles, nextWorkspaceTitle, sessionName, yamlScalar, cleanTabTitle,
  pillSettled, watchPill, ensureWatcher,
  STATE_DIR, PILL_KEY, SESSIONS_DIR,
};
