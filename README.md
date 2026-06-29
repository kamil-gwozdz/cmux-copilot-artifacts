# opinionated-cmux-copilot-sidebar (`occs`)

GitHub Copilot CLI hooks for [cmux](https://cmux.com). When Copilot runs inside a cmux
tab, this:

- **opens the session's artifacts as browser tabs** — every PR / issue / gist / codespace
  the session **creates or updates** opens as a browser tab **to the right of the
  terminal, in the same pane** (not a split). Also restored **on session resume**.
- **shows a compact artifact pill** in the cmux sidebar — e.g. `2 PR ✓ · 1 issue`, colored
  by CI state (green pass / amber running / red fail).

It reuses [`copilot-pr-footer`](https://github.com/kamil-gwozdz/copilot-pr-footer) for
artifact detection and live `gh` PR state (same `events.jsonl` parsing and state cache as
the footer).

## Why hooks (and why it's safe)

cmux's control socket is `cmuxOnly` — it only trusts clients in cmux's own process tree, so
a launchd agent or detached daemon can't drive it. Copilot CLI hooks run **inside** the
cmux tab, so they're trusted with no extra moving parts. Each hook also no-ops outside cmux
and never blocks Copilot.

## Install

```sh
npm install -g opinionated-cmux-copilot-sidebar   # or: npm link from a checkout
occs install
```

`occs install` adds hooks to `~/.copilot/settings.json` for `SessionStart`, `PostToolUse`,
and `Stop` (coexisting with cmux's own `cmux hooks copilot` install — it never touches
those). Then open a **new** Copilot CLI session in a cmux tab.

> Requires `gh` for PR-state badges in the pill, and cmux running.

## Behaviour

| Trigger | What happens |
|---|---|
| A PR/issue/gist is **created** or **updated** in the session | it opens once as a browser tab to the right (same pane) |
| The same artifact is updated again | no duplicate tab |
| You **close** an artifact tab | it stays closed (not reopened) |
| You **resume** the session (cmux relaunched) | missing artifact tabs are reopened |
| Any artifacts exist | the sidebar pill shows the count + CI state |

Tabs open **without** stealing focus. Each artifact opens at most once per session (tracked
in `~/.config/occs/opened/<session>.json`); resume reopens only tabs that aren't already
present.

## Commands

| Command | What it does |
|---|---|
| `occs install` | wire the hooks into `~/.copilot/settings.json` |
| `occs uninstall` | remove them (leaves cmux's own hooks intact) |
| `occs run` | open/refresh now for the current session (manual test) |
| `occs doctor` | show status (node, cmux reachable, hooks, state dir) |
| `occs hook <event>` | hook entrypoint (reads the event JSON on stdin) |

Disable temporarily in a shell with `OCCS_HOOKS_DISABLED=1`.

## Uninstall

```sh
occs uninstall
npm uninstall -g opinionated-cmux-copilot-sidebar
```

## License

MIT
