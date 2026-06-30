"use strict";
// Dependency-free tests. Run with: npm test
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log("  \u2713 " + name); pass++; }

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "occs-"));
const prevHome = process.env.HOME, prevUP = process.env.USERPROFILE;
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
const cmux = require("../lib/cmux");

console.log("artifactFromUrl (classify + canonicalize):");
{
  ok("classifies a PR url", (() => { const a = cmux.artifactFromUrl("https://github.com/o/r/pull/12"); return a && a.kind === "pr" && a.url === "https://github.com/o/r/pull/12"; })());
  ok("canonicalizes a navigated PR tab (/files) back to the PR",
     cmux.artifactFromUrl("https://github.com/o/r/pull/12/files?w=1").url === "https://github.com/o/r/pull/12");
  ok("classifies an issue url", cmux.artifactFromUrl("https://github.com/o/r/issues/9").kind === "issue");
  ok("classifies a gist url", cmux.artifactFromUrl("https://gist.github.com/me/0426cb4d88b5bf11").kind === "gist");
  ok("classifies a codespace url", cmux.artifactFromUrl("https://github.com/codespaces/curly-fortnight").kind === "codespace");
  ok("non-artifact url -> null", cmux.artifactFromUrl("https://github.com/o/r") === null && cmux.artifactFromUrl("https://example.com") === null);
}

console.log("classifyTabs (tab-driven tracking set):");
{
  const tabs = [
    "https://github.com/o/r/pull/1/files",   // navigated PR
    "https://github.com/o/r/pull/1",          // same PR, base -> dedup
    "https://github.com/o/r/issues/2",
    "https://example.com/not-an-artifact",
  ];
  const arts = cmux.classifyTabs(tabs);
  ok("dedupes the same PR opened at two paths", arts.filter((a) => a.kind === "pr").length === 1);
  ok("includes the issue, drops the non-artifact", arts.some((a) => a.kind === "issue") && arts.length === 2);
}

console.log("urlsToOpen (dedup logic):");
{
  const urls = ["https://x/pull/1", "https://x/pull/2", "https://x/issues/3"];
  ok("opens only new urls (not open as tab, not opened before)",
     JSON.stringify(cmux.urlsToOpen(urls, new Set(["https://x/pull/1"]), new Set(["https://x/pull/2"]), "PostToolUse"))
       === JSON.stringify(["https://x/issues/3"]));
  ok("once opened this session, an update does not reopen",
     cmux.urlsToOpen(["https://x/pull/1"], new Set(["https://x/pull/1"]), new Set(), "PostToolUse").length === 0);
  ok("a tab the user closed stays closed (in opened-set, not a tab)",
     cmux.urlsToOpen(["https://x/pull/1"], new Set(["https://x/pull/1"]), new Set(), "Stop").length === 0);
  ok("SessionStart reopens artifacts missing from tabs, ignoring opened-set",
     JSON.stringify(cmux.urlsToOpen(urls, new Set(urls), new Set(["https://x/pull/1"]), "SessionStart"))
       === JSON.stringify(["https://x/pull/2", "https://x/issues/3"]));
  ok("SessionStart does not duplicate a tab already open",
     cmux.urlsToOpen(["https://x/pull/1"], new Set(), new Set(["https://x/pull/1"]), "SessionStart").length === 0);
}

console.log("workspaceTitleFromTree (space name <- first terminal tab):");
{
  const tree = { windows: [{ workspaces: [
    { id: "A", title: "Work", panes: [{ surfaces: [
      { type: "browser", title: "some PR" },
      { type: "terminal", title: "Implement Cmux Custom Sidebar" },
      { type: "terminal", title: "second terminal" },
    ] }] },
    { id: "B", title: "B", panes: [] },
  ] }] };
  ok("returns the first terminal tab's title for the target workspace",
     cmux.workspaceTitleFromTree(tree, "A") === "Implement Cmux Custom Sidebar");
  ok("null when already in sync",
     cmux.workspaceTitleFromTree({ windows: [{ workspaces: [
       { id: "A", title: "T", panes: [{ surfaces: [{ type: "terminal", title: "T" }] }] }] }] }, "A") === null);
  ok("null when the workspace has no terminal title", cmux.workspaceTitleFromTree(tree, "B") === null);
  ok("null when the workspace is absent / no tree", cmux.workspaceTitleFromTree(tree, "Z") === null && cmux.workspaceTitleFromTree(null, "A") === null);
}

console.log("pillText:");
{
  const states = { "https://x/pull/1": { ci: "passed" }, "https://x/pull/2": { ci: "passed" } };
  const p = cmux.pillText([
    { kind: "pr", url: "https://x/pull/1" }, { kind: "pr", url: "https://x/pull/2" },
    { kind: "issue", url: "https://x/issues/3" },
  ], states);
  ok("summarizes PRs + issues with all-green CI tick",
     p.text === "2 PR \u2713 \u00b7 1 issue" && p.color === "#3fb950");
  const f = cmux.pillText([{ kind: "pr", url: "https://x/pull/1" }], { "https://x/pull/1": { ci: "failed" } });
  ok("a failing PR turns the pill red with \u2717", f.text === "1 PR \u2717" && f.color === "#f85149");
  const r = cmux.pillText([{ kind: "pr", url: "https://x/pull/1" }], { "https://x/pull/1": { ci: "running" } });
  ok("a running PR is amber with \u2026", r.color === "#d29922" && r.text.endsWith("\u2026"));
  ok("no artifacts -> no pill", cmux.pillText([], {}) === null);
}

console.log("resolveSession:");
{
  const d = path.join(HOME, ".copilot", "session-state", "abc");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "events.jsonl"), "x");
  const r1 = cmux.resolveSession(JSON.stringify({ session_id: "abc" }));
  ok("resolves session dir from stdin session_id", r1.sessionId === "abc" && r1.dir === d);
  const r2 = cmux.resolveSession("");
  ok("falls back to a session on disk", r2.dir === d);
}

console.log("opened-state round-trip:");
{
  cmux.saveOpened("sess1", new Set(["https://x/pull/9"]));
  ok("persists and reloads the opened set", cmux.loadOpened("sess1").has("https://x/pull/9"));
  ok("unknown session -> empty set", cmux.loadOpened("nope").size === 0);
}

process.env.HOME = prevHome; if (prevUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUP;
console.log(`\n${pass} passed`);
