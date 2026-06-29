#!/usr/bin/env node
"use strict";
// occs — wire Copilot CLI hooks that, inside a cmux tab, open the session's PRs/issues/
// gists as browser tabs (to the right, same pane) on create/update/resume, and push a
// compact artifact pill to the cmux sidebar.

const fs = require("fs");
const os = require("os");
const path = require("path");
const cmux = require("../lib/cmux");

const SETTINGS = path.join(os.homedir(), ".copilot", "settings.json");
const CLI = path.resolve(__filename);
const NODE = process.execPath;
const EVENTS = ["SessionStart", "PostToolUse", "Stop"];
const TAG = "OCCS_HOOKS_DISABLED"; // unique marker in our hook command (cmux uses CMUX_*)

function readStdin() {
  if (process.stdin.isTTY) return "";
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

// settings.json is strict JSON (Copilot's user-owned file). Read/parse tolerant of a
// leading // comment header just in case, but write back as plain JSON.
function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS, "utf8");
    const stripped = raw.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    return JSON.parse(stripped || "{}");
  } catch { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const tmp = SETTINGS + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, SETTINGS);
}

function hookCommand(event) {
  // Runs only inside cmux; never blocks Copilot (always emits {}); stays synchronous so it
  // keeps cmux's trusted in-process-tree context (a backgrounded child would lose it).
  return `if [ -n "$CMUX_SURFACE_ID" ] && [ "$OCCS_HOOKS_DISABLED" != "1" ]; then "${NODE}" "${CLI}" hook ${event} || true; fi; echo '{}'`;
}

function install() {
  const s = readSettings();
  s.hooks = s.hooks || {};
  for (const ev of EVENTS) {
    s.hooks[ev] = (s.hooks[ev] || []).filter((b) => !JSON.stringify(b).includes(TAG));
    s.hooks[ev].push({ hooks: [{ type: "command", command: hookCommand(ev), timeout: 15000 }] });
  }
  writeSettings(s);
  console.log("\u2713 occs hooks installed in " + SETTINGS + " (" + EVENTS.join(", ") + ")");
  console.log("  Open a NEW Copilot CLI session in a cmux tab. The session's PRs/issues/gists");
  console.log("  open as browser tabs to the right (same pane) on create/update/resume,");
  console.log("  and a count shows in the cmux sidebar status pill.");
  console.log("  Disable per-shell with OCCS_HOOKS_DISABLED=1.");
}

function uninstall() {
  const s = readSettings();
  let n = 0;
  for (const ev of Object.keys((s.hooks) || {})) {
    const before = s.hooks[ev].length;
    s.hooks[ev] = s.hooks[ev].filter((b) => !JSON.stringify(b).includes(TAG));
    n += before - s.hooks[ev].length;
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  writeSettings(s);
  console.log(n ? `\u2713 removed ${n} occs hook block(s) from settings.json.` : "Nothing to remove.");
}

function doctor() {
  const s = readSettings();
  const installed = EVENTS.filter((ev) => (s.hooks && s.hooks[ev] || []).some((b) => JSON.stringify(b).includes(TAG)));
  let cmuxOk = false;
  try { require("child_process").execFileSync(cmux.cmuxBin(), ["ping"], { stdio: "ignore", timeout: 3000 }); cmuxOk = true; } catch {}
  console.log("occs doctor");
  console.log("  node:            " + process.version);
  console.log("  cmux reachable:  " + (cmuxOk ? "yes" : "NO (run inside cmux / is it running?)"));
  console.log("  hooks installed: " + (installed.length ? installed.join(", ") : "none (run: occs install)"));
  console.log("  inside cmux now: " + (process.env.CMUX_SURFACE_ID ? "yes" : "no"));
  console.log("  state dir:       " + cmux.STATE_DIR);
}

function help() {
  console.log(`occs \u2014 open Copilot CLI session artifacts as cmux browser tabs + a sidebar pill.

Usage:
  occs install            wire the hooks into ~/.copilot/settings.json
  occs uninstall          remove them
  occs hook <event>       hook entrypoint (reads the event JSON on stdin)
  occs run                open/refresh now for the current session (manual test)
  occs doctor             show status

Hooks fire on ${EVENTS.join(", ")}. Each artifact opens once per session as a browser
tab to the right of the terminal (same pane); a tab you close stays closed; on session
resume any missing tabs are reopened. Disable per-shell with OCCS_HOOKS_DISABLED=1.`);
}

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "hook": try { cmux.runHook(arg || "", readStdin()); } catch {} process.stdout.write("{}\n"); break;
    case "run": cmux.runHook("manual", ""); break;
    case "install": install(); break;
    case "uninstall": uninstall(); break;
    case "doctor": doctor(); break;
    default: help();
  }
}
