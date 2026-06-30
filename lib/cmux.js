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
const { execFileSync } = require("child_process");
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
  if (tpath && fs.existsSync(tpath)) return { sessionId: path.basename(tpath), dir: tpath };
  if (id) { const dir = path.join(SESSIONS_DIR, id); if (fs.existsSync(dir)) return { sessionId: id, dir }; }

  const surf = process.env.CMUX_SURFACE_ID;
  if (surf) {
    try {
      const rec = JSON.parse(fs.readFileSync(HOOK_SESSIONS, "utf8"));
      for (const s of Object.values(rec.sessions || {})) {
        if (s.surfaceId === surf && s.sessionId) {
          const dir = path.join(SESSIONS_DIR, s.sessionId);
          if (fs.existsSync(dir)) return { sessionId: s.sessionId, dir };
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
function openTabs(urls) {
  const surf = process.env.CMUX_SURFACE_ID;
  if (!surf) return [];
  const opened = [];
  for (const u of urls) {
    if (cmuxOk(["tab-action", "--tab", surf, "--action", "new-browser-right", "--url", u, "--focus", "false"])) opened.push(u);
  }
  return opened;
}

// ── workspace title ─────────────────────────────────────────────────────────────
// cmux doesn't mirror a tab's title onto its workspace, so the space name keeps the
// cwd basename ("Work") while the Copilot tab shows the session summary. We re-apply
// the first terminal tab's title to the workspace on each hook (a one-shot rename loses
// to cmux's creation-time title; re-applying on PostToolUse/Stop wins) — UNLESS the user
// renamed the space by hand, in which case their name wins from then on.
const TITLES_FILE = path.join(os.homedir(), ".config", "occs", "titles.json");
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
// name once detected. A change to something that is neither our title, the tab title, nor
// the cwd default (base) is a human rename → it wins from then on. cur === base is cmux's
// own reset, not the user, so we re-assert. Returns { rename, ours, manual }.
function nextWorkspaceTitle({ cur, tab, base, ours, manual }) {
  cur = cur || ""; base = base || "";
  if (cur && cur !== base && cur !== tab && cur !== ours) manual = cur;
  const desired = manual || tab || "";
  const rename = (desired && desired !== cur) ? desired : null;
  return { rename, ours: rename || cur, manual: manual || null };
}

function syncWorkspaceTitle() {
  const ws = process.env.CMUX_WORKSPACE_ID;
  if (!ws) return;
  const tree = cmuxJson(["tree", "--all", "--json", "--id-format", "both"]);
  if (!tree) return;
  const { cur, tab } = workspaceTitles(tree, ws);
  const base = path.basename(process.cwd() || "");
  const prev = loadTitle(ws);
  const next = nextWorkspaceTitle({ cur, tab, base, ours: prev.ours, manual: prev.manual });
  if (next.rename) cmuxOk(["rename-workspace", "--workspace", ws, next.rename]);
  if (next.ours !== prev.ours || (next.manual || null) !== (prev.manual || null))
    saveTitle(ws, { ours: next.ours, manual: next.manual });
}

// ── status pill ─────────────────────────────────────────────────────────────────
// Compact "<n> PR <ci> · <n> issue · <n> gist". CI is the worst rollup across the PRs.
function pillText(arts, states) {
  const by = { pr: [], issue: [], gist: [], codespace: [] };
  for (const a of arts) (by[a.kind] || (by[a.kind] = [])).push(a);
  const parts = [];
  if (by.pr.length) {
    let ci = "";
    const sts = by.pr.map((a) => states[a.url]).filter(Boolean);
    if (sts.some((s) => s.ci === "failed")) ci = " \u2717";
    else if (sts.some((s) => s.ci === "running")) ci = " \u2026";
    else if (sts.length && sts.every((s) => s.ci === "passed")) ci = " \u2713";
    parts.push(`${by.pr.length} PR${ci}`);
  }
  if (by.issue.length) parts.push(`${by.issue.length} issue`);
  if (by.gist.length) parts.push(`${by.gist.length} gist`);
  if (!parts.length) return null;
  let color = "#58a6ff";
  const sts = by.pr.map((a) => states[a.url]).filter(Boolean);
  if (sts.some((s) => s.ci === "failed")) color = "#f85149";
  else if (sts.some((s) => s.ci === "running")) color = "#d29922";
  else if (sts.length && sts.every((s) => s.ci === "passed")) color = "#3fb950";
  return { text: parts.join(" \u00b7 "), color, icon: "arrow.triangle.pull" };
}

function updatePill(arts, states) {
  const p = pillText(arts, states);
  if (!p) { cmuxOk(["clear-status", PILL_KEY]); return; }
  cmuxOk(["set-status", PILL_KEY, p.text, "--icon", p.icon, "--color", p.color, "--priority", "5"]);
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
  const { sessionId, dir } = resolveSession(stdinStr);

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

  // 3) keep the space name in sync with the first Copilot terminal tab's title
  syncWorkspaceTitle();
}

module.exports = {
  cmuxBin, resolveSession, collect, urlsToOpen, openTabs, pillText, updatePill,
  loadOpened, saveOpened, currentTabUrls, currentTabArtifacts, classifyTabs,
  artifactFromUrl, runHook, syncWorkspaceTitle, workspaceTitles, nextWorkspaceTitle,
  STATE_DIR, PILL_KEY, SESSIONS_DIR,
};
