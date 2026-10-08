# Installation

This guide documents the local Bun/mise fork of **`Jonghakseo/my-pi`**.
The prepared checkout supplies 10 bundled agents, local/npm resources, and the
existing Claude MCP bridge without replacing personal configuration.
The current local update has not been pushed; cloning upstream alone does not
reproduce these personal changes.

> Linux works too if you skip macOS-specific items (Ghostty, AppleScript-based skills,
> Peekaboo). Windows is not supported.

---

## 1. Prerequisites

Install these **before** bootstrap. Versions below are what the repo is developed against.

### Runtimes

| Tool | Version | Install |
|---|---|---|
| **Node.js** | `>=22.19` (tested on `22.19.0`) | `brew install node@22` or `mise use -g node@22` |
| **Bun** | `1.3.11` (pinned via `.mise.toml` and `packageManager`) | `mise install` |
| **Python** | `>=3.10` | for the `skill-creator` skill's `validate_skill.py` (`@ryan_nookpi/pi-skill-skill-creator`) |
| **Git** | any recent | `brew install git` |

### Required CLIs

```bash
# pi itself (the TUI this repo configures)
npm i -g @earendil-works/pi-coding-agent

# GitHub CLI (used by many agents and the open-pr extension)
brew install gh && gh auth login

# Claude Code — the MCP bridge extension re-uses its MCP server config
# https://docs.claude.com/claude-code
```

### Recommended / skill-specific CLIs

Skip any you don't use; the matching skill will simply no-op.

| CLI | Used by | Install |
|---|---|---|
| `ctx7` (Context7) | `skills/context7-cli` | `npm i -g @upstash/context7-mcp` (see skill) |
| `gw` (git-worktree helper) | `skills/gw-worktree-cleanup` | https://github.com/jonghakseo/gw |
| `ffmpeg`, `yt-dlp` | `fetch_content` video frames | `brew install ffmpeg yt-dlp` |
| `peekaboo` | `skills/peekaboo` | `brew install steipete/tap/peekaboo` |
| Ghostty | `bookmark` extension panel | https://ghostty.org |

---

## 2. Choose the installation layout

pi reads its configuration from **`~/.pi/agent`**. The source may live in a separate checkout with resource links into that directory. For an existing installation, preserve auth, MCP, memory, personal settings and agents; do not replace them with the repository templates. Remove old local extension links when the same extension is supplied by npm, so it loads only once.

The validated local checkout is:

```bash
cd ~/Desktop/my-pi
```

Its branch is `chore/upstream-20261007`. This is now an independent repository: its Git metadata, current source, and retained `interactive-shell` tool all live inside `~/Desktop/my-pi`. No second worktree is required. The original working states are backed up outside the active installation. Only the obsolete `interactive-shell` skill was removed. The new `output-compactor` extension is not linked into the active installation, so this update does not enable its automatic model calls.

For another machine, first obtain the intended personal fork revision and establish the resource links deliberately. Do not move or replace an existing `~/.pi/agent` as an installation shortcut.

---

## 3. Run the bootstrap script

The script checks required CLI availability, installs dependencies, syncs agents, and scaffolds the root `.env` file.

```bash
./scripts/bootstrap.sh
```

It will:

1. Check that Node, Bun, Git, GitHub CLI, and pi are available.
2. Run `bun install --omit peer` at the repo root and `bun install` inside `extensions/`.
3. Run `scripts/sync-agents.mjs` to sync `agents/*.md` into `~/.pi/agent/agents/` and remove retired bundled agent definitions. Existing user model assignments and unrelated personal agents are preserved, including on `--force`. `PI_CODING_AGENT_DIR` can point to an isolated validation directory.
4. Create `.env` from the template if missing.
5. Print a checklist of any missing optional CLIs from §1.

Re-run it anytime; it is idempotent. Bundled agents ship without `model:`. Configure models manually in the installed agent definitions after validation; unspecified models follow runtime defaults.

---

## 4. Secrets and per-user files

These are git-ignored — fill them in manually after bootstrap.

### `auth.json`
Created the first time you launch `pi` and pick a provider (Anthropic / OpenAI / Ollama).
You normally don't edit it by hand.

### `.env` (repo root)
Currently empty by default; add only what your own extensions need.

### `agents/.env.browser` (optional)
Only needed if you use the `browser` agent with persistent cookies.

---

## 5. MCP servers

This local installation retains its existing Claude MCP bridge and configuration. A native MCP migration is separate work; do not expose the same servers through both mechanisms unintentionally.

For a new native-only setup, pi ships built-in MCP support (`builtin:mcp`). Servers live in
`~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (trusted projects), and tools
are exposed as `mcp__<server>__<tool>`.

1. Add a server: `pi mcp add creatrip --url https://ai.creatrip.com/api/mcp/sse`
   (or edit `mcp.json` directly).
2. Check it: `pi mcp list`. Sign in with `pi mcp login <server>` if needed.
3. Inside a session, `/mcp` manages servers (state, tools, exposure, sign-in).

---

## 6. Launch

```bash
cd ~/.pi/agent
pi
```

Existing installations keep their authentication. A fresh installation will prompt you to sign in to the default provider
(`openai-codex` per `settings.json`). After that the TUI should look identical to
the screenshot in the [README](./README.md#usage-example).

---

## 7. What is *not* shipped in the repo

These are intentionally git-ignored — recreate or substitute if you want parity:

| Path | Why ignored | What to do |
|---|---|---|
| `auth.json` | provider tokens | created on first launch |
| `.env`, `agents/.env.browser` | secrets | use the `.example` files |
| `sessions/`, `.data/`, `state/`, `.context/`, `cron/` | per-machine runtime data | left empty; pi recreates |
| `bin/`, `local-scripts/` | personal scripts | not portable |
| `until-presets/`, `extensions/usage-reporter/` | personal `until` presets and extensions | optional |
| `extensions/picky-handoff` | symlink to a separate repo | not required |
| Daily/weekly retro logs and stamp files | local cron output | safe to skip |

**Skills**: `.gitignore` excludes `skills/*` but keeps the ones already tracked
in git. Cloning gives you exactly the public skill set — no extra steps.

---

## 8. Troubleshooting

- **`pi` not found** → re-run `npm i -g @earendil-works/pi-coding-agent` and
  check `npm bin -g` is on your `PATH`.
- **Dependency installation fails** → use the pinned Bun version. Root installation uses `bun install --omit peer`; extension development dependencies are pinned to the installed Pi release.
- **Agents missing in TUI** → run `node scripts/sync-agents.mjs --force`.
- **MCP tools missing** → run `pi mcp list` and fix the failing entry in
  `mcp.json`, or `/mcp reconnect <server>` inside a session.
- **`extensions/` typecheck errors** → `cd extensions && bun run typecheck`.
