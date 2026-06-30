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

console.log("workspaceTitles (extract cur + first terminal tab):");
{
  const tree = { windows: [{ workspaces: [
    { id: "A", title: "Work", panes: [{ surfaces: [
      { type: "browser", title: "some PR" },
      { type: "terminal", title: "Implement Cmux Custom Sidebar" },
      { type: "terminal", title: "second terminal" },
    ] }] },
    { id: "B", title: "B", panes: [] },
  ] }] };
  const a = cmux.workspaceTitles(tree, "A");
  ok("reads workspace title + first terminal tab", a.cur === "Work" && a.tab === "Implement Cmux Custom Sidebar");
  const b = cmux.workspaceTitles(tree, "B");
  ok("no terminal -> empty tab", b.cur === "B" && b.tab === "");
  const z = cmux.workspaceTitles(null, "A");
  ok("no tree -> empties", z.cur === "" && z.tab === "");
}

console.log("nextWorkspaceTitle (tab-follow, cmux-reset re-assert, manual wins):");
{
  // first sight on the cwd default -> take over with the tab title
  let s = cmux.nextWorkspaceTitle({ cur: "Work", tab: "Sess A", base: "Work", ours: undefined, manual: undefined });
  ok("default 'Work' -> renamed to tab title", s.rename === "Sess A" && s.ours === "Sess A" && s.manual === null);
  // already in sync -> no rename
  ok("in sync -> no rename", cmux.nextWorkspaceTitle({ cur: "Sess A", tab: "Sess A", base: "Work", ours: "Sess A", manual: null }).rename === null);
  // tab title updated by Copilot -> follow it
  s = cmux.nextWorkspaceTitle({ cur: "Sess A", tab: "Sess B", base: "Work", ours: "Sess A", manual: null });
  ok("Copilot renamed the tab -> follow", s.rename === "Sess B" && s.ours === "Sess B");
  // cmux reset the space back to 'Work' -> re-assert the tab title (not treated as manual)
  s = cmux.nextWorkspaceTitle({ cur: "Work", tab: "Sess B", base: "Work", ours: "Sess B", manual: null });
  ok("cmux reset to 'Work' -> re-assert tab", s.rename === "Sess B" && s.manual === null);
  // user renames by hand -> becomes manual, wins
  s = cmux.nextWorkspaceTitle({ cur: "My Name", tab: "Sess B", base: "Work", ours: "Sess B", manual: null });
  ok("hand rename -> detected manual, no override", s.rename === null && s.manual === "My Name" && s.ours === "My Name");
  // once manual, a new tab title is ignored
  s = cmux.nextWorkspaceTitle({ cur: "My Name", tab: "Sess C", base: "Work", ours: "My Name", manual: "My Name" });
  ok("manual ignores later tab changes", s.rename === null && s.manual === "My Name");
  // once manual, cmux's 'Work' reset is corrected back to the manual name
  s = cmux.nextWorkspaceTitle({ cur: "Work", tab: "Sess C", base: "Work", ours: "My Name", manual: "My Name" });
  ok("manual re-asserted over cmux reset", s.rename === "My Name" && s.manual === "My Name");
}

console.log("pillText:");
{
  const P = (s) => cmux.pillText([{ kind: "pr", url: "https://x/pull/1" }], { "https://x/pull/1": s });
  ok("open + CI passed + approved -> green, ✓ appr", (() => {
    const p = P({ state: "OPEN", ci: "passed", review: "APPROVED" });
    return p.color === "#3fb950" && p.text === "1 PR \u2713 appr";
  })());
  ok("CI pending -> yellow, …", (() => {
    const p = P({ state: "OPEN", ci: "running" });
    return p.color === "#d29922" && p.text === "1 PR \u2026";
  })());
  ok("CI failed -> red, ✗", (() => {
    const p = P({ state: "OPEN", ci: "failed" });
    return p.color === "#f85149" && p.text === "1 PR \u2717";
  })());
  ok("merged -> violet, 'merged'", (() => {
    const p = P({ state: "MERGED", ci: "none" });
    return p.color === "#a371f7" && p.text === "1 PR merged";
  })());
  ok("merge conflict -> red, 'conflict' (only when CONFLICTING)", (() => {
    const p = P({ state: "OPEN", ci: "passed", mergeable: "CONFLICTING" });
    return p.color === "#f85149" && p.text.includes("conflict");
  })());
  ok("mergeable=MERGEABLE shows no conflict word", (() => {
    const p = P({ state: "OPEN", ci: "passed", mergeable: "MERGEABLE" });
    return !p.text.includes("conflict");
  })());
  ok("changes requested -> red, chg", (() => {
    const p = P({ state: "OPEN", ci: "passed", review: "CHANGES_REQUESTED" });
    return p.color === "#f85149" && p.text.includes("chg");
  })());
  ok("review required -> rev?", P({ state: "OPEN", ci: "passed", review: "REVIEW_REQUIRED" }).text.includes("rev?"));
  ok("rolls up PRs + issues; all-green tick", (() => {
    const p = cmux.pillText([
      { kind: "pr", url: "https://x/pull/1" }, { kind: "pr", url: "https://x/pull/2" },
      { kind: "issue", url: "https://x/issues/3" },
    ], { "https://x/pull/1": { state: "OPEN", ci: "passed" }, "https://x/pull/2": { state: "OPEN", ci: "passed" } });
    return p.text === "2 PR \u2713 \u00b7 1 issue" && p.color === "#3fb950";
  })());
  ok("worst CI wins the rollup (one failing among passing -> red ✗)", (() => {
    const p = cmux.pillText([
      { kind: "pr", url: "https://x/pull/1" }, { kind: "pr", url: "https://x/pull/2" },
    ], { "https://x/pull/1": { state: "OPEN", ci: "passed" }, "https://x/pull/2": { state: "OPEN", ci: "failed" } });
    return p.color === "#f85149" && p.text.startsWith("2 PR \u2717");
  })());
  ok("no artifacts -> no pill", cmux.pillText([], {}) === null);
  ok("issue-only -> neutral blue, no PR part", (() => {
    const p = cmux.pillText([{ kind: "issue", url: "https://x/issues/9" }], {});
    return p.text === "1 issue" && p.color === "#58a6ff";
  })());
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
