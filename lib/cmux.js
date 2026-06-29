"use strict";
// opinionated-cmux-copilot-sidebar — core.
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
function runHook(event, stdinStr) {
  if (!process.env.CMUX_SURFACE_ID) return; // not inside cmux
  const { sessionId, dir } = resolveSession(stdinStr);
  if (!dir) return;
  const { arts, states } = collect(dir);
  const urls = arts.map((a) => a.url);
  const tabs = currentTabUrls();
  const opened = loadOpened(sessionId);
  const justOpened = openTabs(urlsToOpen(urls, opened, tabs, event));
  // Record everything now visible (newly opened + already a tab) so closing a tab is
  // respected on later create/update ticks, while SessionStart can still restore tabs.
  let changed = false;
  for (const u of [...justOpened, ...urls.filter((x) => tabs.has(x))]) {
    if (!opened.has(u)) { opened.add(u); changed = true; }
  }
  if (changed) saveOpened(sessionId, opened);
  updatePill(arts, states);
}

module.exports = {
  cmuxBin, resolveSession, collect, urlsToOpen, openTabs, pillText, updatePill,
  loadOpened, saveOpened, currentTabUrls, runHook,
  STATE_DIR, PILL_KEY, SESSIONS_DIR,
};
