# Cuttlefish

> A lightweight AI gateway daemon that orchestrates professional AI coding CLIs — **Claude Code, Codex, Grok, Antigravity, Pi, Hermes, Kiro, Ollama, Kilo, and Aider** — behind one unified process. Cuttlefish is a bus, not a brain.

[![npm version](https://img.shields.io/npm/v/cuttlefish-cli.svg)](https://www.npmjs.com/package/cuttlefish-cli)
[![license: MIT](https://img.shields.io/npm/l/cuttlefish-cli.svg)](https://github.com/cephalopod-ai/cuttlefish)
[![node](https://img.shields.io/node/v/cuttlefish-cli.svg)](https://github.com/cephalopod-ai/cuttlefish)

<p align="center">
  <img src="https://raw.githubusercontent.com/cephalopod-ai/cuttlefish/main/assets/cuttlefish-showcase.gif" alt="Cuttlefish web dashboard" width="800" />
</p>

## What is Cuttlefish?

Cuttlefish is an open-source AI gateway that wraps battle-tested AI coding CLIs — **Claude Code, Codex, Grok, Antigravity, Pi, Hermes, Kiro, Ollama, Kilo, and Aider** — behind a single daemon. It routes tasks to the right engine, runs a hierarchical org of AI "employees", schedules background work with cron, talks to your tools through connectors, and ships a full web dashboard and voice mode — all on top of the official CLIs you already trust.

**Cuttlefish is a bus, not a brain.** Most AI agent frameworks reinvent the wheel — custom tool-calling loops, brittle context management, hand-rolled retries — and bill you per token on top. Cuttlefish instead delegates to the professional CLIs and adds only what they're missing: routing, an org system, scheduling, connectors, and a UI.

## 🔑 Works with your Claude Max subscription

Because Cuttlefish drives the **official Claude Code CLI** under the hood, it works with the flat-rate Anthropic Max subscription — no per-token API billing, no surprise invoices. Third-party agent frameworks were banned from using Max OAuth tokens in January 2026; since Cuttlefish delegates to Anthropic's first-party CLI, it stays fully supported.

## 🚀 Install

**Node.js 24** (`>=24 <25`) is required. Full matrix (npm, Homebrew, GitHub
archives, Windows): **[docs/INSTALL.md](https://github.com/cephalopod-ai/cuttlefish/blob/main/docs/INSTALL.md)**.

Install at least one engine CLI first:

- **Claude Code** — `npm install -g @anthropic-ai/claude-code`
- **Codex** (optional) — `npm install -g @openai/codex`

### npm (after a published release)

```bash
npm install -g cuttlefish-cli
cuttlefish setup
cuttlefish start
```

### Windows

```powershell
# From a source checkout (supported today before npm publication):
git clone https://github.com/cephalopod-ai/cuttlefish.git
cd cuttlefish
.\scripts\install.ps1 -FromSource -Force

# After a GitHub Release with a win32-x64 asset:
.\scripts\install.ps1 -FromRelease -Force
```

Build a local releasable zip: `.\scripts\package-windows.ps1` →
`dist-release\cuttlefish-cli-<version>-win32-x64.zip`.

### Source (all platforms)

```bash
git clone https://github.com/cephalopod-ai/cuttlefish.git
cd cuttlefish
pnpm install
pnpm setup                 # build and initialize the Cuttlefish home
pnpm cuttlefish start      # start the gateway daemon + web dashboard
```

> Sign in to your engines once before `cuttlefish start` — run `claude` and use `/login` (and `codex` if installed).

## Runtime home and lifecycle

Cuttlefish uses `~/.cuttlefish` by default. Set `CUTTLEFISH_HOME` to use a
separate active home; lifecycle commands and `cuttlefish list` use that same
home. `cuttlefish restart` is detached so it can survive a gateway-session
shutdown, and overlapping restart requests coalesce.

## ✨ Features

- **Multi-engine** — Claude Code, Codex, Grok, Antigravity, Pi, Hermes, Kiro, Ollama, Kilo, and Aider behind one API; switch engine and model per task or per employee.
- **AI org system** — hierarchical "employees" with personas, ranks, and departments. Delegate work down the tree; results flow back up through a COO.
- **Cron & background jobs** — schedule recurring agent work and long-running tasks; review the output before it reaches you.
- **Connectors** — Slack and more, so your agents can message, report, and act.
- **Web dashboard + voice** — chat UI, live org chart, kanban board, logs, usage limits, and a hands-free talk mode.
- **Skills** — reusable Markdown playbooks your agents follow step by step.
- **Matrix orchestration** — durable runtime, queue controls, dual-lane runs, recovery/requeue flows, worktree execution, and a dedicated orchestration dashboard.
- **Operator controls** — approvals, archives, stricter file handling, and stronger backend/frontend coverage than the upstream baseline.
- **Subscription-friendly** — every Claude turn runs through the real interactive CLI inside a PTY, so your Max plan keeps working instead of silently draining API credits.

## 📚 Documentation

Full documentation, architecture notes, diagrams, and validation ledgers live in
the repository:

**→ https://github.com/cephalopod-ai/cuttlefish/blob/main/docs/INDEX.md**

Cuttlefish is forked from [`repo-makeover/jinn`](https://github.com/repo-makeover/jinn), which is itself a substantial rework/fork of the original [`hristo2612/jinn`](https://github.com/hristo2612/jinn). The original project and direct fork remain the MIT-licensed lineage for this package.

For the source-grounded fork delta, see:

**→ https://github.com/cephalopod-ai/cuttlefish/blob/main/docs/UPSTREAM_DIFF_BASELINE.md**

## License

[MIT](https://github.com/cephalopod-ai/cuttlefish)
