<p align="center">
  <img src="assets/brand/cuttlefish_wordmark_horizontal.svg" alt="Cuttlefish" width="460" />
</p>

<p align="center"><b>Run your AI agents as a company.</b></p>

<p align="center">
  Cuttlefish is the orchestration layer that runs any agent CLI - Claude Code, Codex, Hermes, Grok, Ollama, Kilo, Aider - as interchangeable engines, and coordinates them as a company of AI employees:
  hierarchy, delegation, cron, skills, and connectors.<br/>
  It doesn't replace your agents. <b>It gives them an org chart.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.23.3-7c3aed" alt="version 0.23.3" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7c3aed" alt="license: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524%20%3C25-7c3aed" alt="node >=24 <25" />
  <img src="https://img.shields.io/badge/status-beta-7c3aed" alt="status: beta" />
</p>

<p align="center">
  <img src="assets/cuttlefish-showcase.gif" alt="Cuttlefish web dashboard" width="820" />
</p>

> **You bring the engines. Cuttlefish runs the company.**

---

## Why Cuttlefish?

You've already installed the best agent CLIs. Cuttlefish turns that pile of terminals into a coordinated team.

- **🎼 Conducts your agents - doesn't replace them.** Claude Code, Codex, Grok, Antigravity, Pi, Hermes, Kiro, Ollama, Kilo, Aider - whatever's on your `PATH` becomes a Cuttlefish engine. Cuttlefish adds **zero** AI logic of its own ("bus, not brain"); all the intelligence is your engines'. When they get better, Cuttlefish gets better, for free.
- **🏢 An AI org you design in YAML.** Named employees with personas, ranks, and departments - and a reporting hierarchy of any depth. A COO delegates work to managers, managers to their reports. Real chain of command, not a flat pool of anonymous agents.
- **💸 Runs on your subscription, not a token meter.** Cuttlefish drives the *official* Claude Code CLI inside a real terminal, so Claude turns bill against your flat-rate Max/Pro subscription - a whole org grinding all day is a fixed monthly cost, not a surprise API invoice.
- **⏰ Works while you sleep.** Hot-reloadable cron schedules background research, content, monitoring, and support - output routed through your COO for review, then to you on Slack.
- **📦 Skills, connectors, and memory - shared across the org.** Reusable markdown playbooks every engine follows natively, Slack/WhatsApp connectors, and git-backed shared knowledge. The institutional layer a lone agent can't keep.

<p align="center">
  <img src="assets/chat.png" alt="Cuttlefish chat - an engineering agent diagnosing and fixing a flaky test" width="840" />
</p>
<p align="center"><sub>An agent on the Engineering team triages a flaky CI test, ships the fix, and opens a PR - streamed live in the dashboard.</sub></p>

---

## Quickstart

> **Prerequisites:** Node.js **24** (the repo pins **24.13.0** via `.nvmrc` and root tooling enforces `>=24 <25`), **pnpm 10+**, and at least one agent CLI installed **and signed in** - Cuttlefish orchestrates them and can't run a session without one.

```bash
# 1. Install from source (the npm package and Homebrew formula are pending first publication)
git clone https://github.com/e3742526/cuttlefish.git
cd cuttlefish
pnpm install
pnpm setup        # builds all packages and initializes ~/.cuttlefish (probes your engines, writes config)

# 2. Install + sign in to at least one engine (example: Claude Code)
npm install -g @anthropic-ai/claude-code
claude            # run once, use /login, then quit

# 3. Start the gateway - opens the dashboard for you
pnpm cuttlefish start
```

Then open **[http://localhost:8888](http://localhost:8888)**, send your first message, and watch your COO delegate.

> **Packaged installs.** `npm install -g cuttlefish-cli` and the Homebrew tap will be the one-line install paths once the package is published; until then, install from source as above. Each [GitHub Release](https://github.com/e3742526/cuttlefish/releases) also ships prebuilt `cuttlefish-cli-<version>-linux-x64.tar.gz` and `cuttlefish-cli-<version>-darwin-arm64.tar.gz` tarballs for a download-and-run install without `git clone`.

> **`--version` ≠ signed in.** Cuttlefish drives the official engine CLIs, so authenticate each one *before* `cuttlefish start` (run `claude` → `/login`, run `codex` to sign in, etc.). Without this, sessions can't reach the models - the most common fresh-install gotcha.

Everyday commands (prefix with `pnpm` when running from a source checkout, e.g. `pnpm cuttlefish status`):

```bash
cuttlefish start      # start the gateway daemon (auto-opens the dashboard)
cuttlefish stop       # stop it
cuttlefish restart    # restart safely (detached; works even from inside a session)
cuttlefish status     # is the daemon running?
```

---

## How it works

Cuttlefish is a **gateway daemon + web dashboard**. The daemon dispatches each task to an AI engine, manages connectors, runs scheduled cron jobs, and serves the dashboard at `localhost:8888`.

For the maintained implementation map, architecture notes, and validation ledger,
start with [`docs/INDEX.md`](docs/INDEX.md). The current diagrams live in
[`docs/IMPLEMENTATION_DIAGRAMS.md`](docs/IMPLEMENTATION_DIAGRAMS.md), including
the gateway/API/session/engine component map. The README intentionally links to
the maintained diagram source instead of carrying a second hand-maintained
architecture sketch.

Three ideas make Cuttlefish click:

1. **Engines** - any agent CLI you have installed, made interchangeable. Pick engine + model + effort per employee or per session.
2. **Employees** - YAML personas with a role and a place in the hierarchy. They're just files in `~/.cuttlefish/org/` you can read and edit.
3. **Delegation** - any session can spawn child sessions that report back. Your COO breaks a task down, fans it out to employees, and synthesizes the result.

---

## Engines - bring your own

Cuttlefish detects whichever agent CLIs are on your `PATH` and makes them interchangeable engines. Switch per session or per employee in the dashboard; engines whose binary isn't installed are simply hidden. **No version pinning, no bundled model lists** - Cuttlefish asks each CLI what it can do at boot, so the moment your CLI learns a new model, Cuttlefish offers it.

| Engine | What it is | Install | Modes | Effort |
|--------|-----------|---------|-------|--------|
| **claude** | Anthropic Claude Code - first-party, subscription-friendly | `npm install -g @anthropic-ai/claude-code` | Chat (PTY + live stream) · CLI (xterm) | low / medium / high |
| **codex** | OpenAI Codex CLI | `npm install -g @openai/codex` | Chat · CLI (xterm) | low / medium / high / xhigh |
| **grok** | xAI Grok CLI | `npm install -g @xai-official/grok` (run `grok` once to auth) | Chat · CLI (xterm) | low / medium / high / xhigh / max |
| **antigravity** | Antigravity CLI (`agy`) | see Antigravity docs | CLI (xterm) | - |
| **pi** | Pi coding agent CLI | see Pi CLI docs | Chat | - |
| **hermes** | NousResearch Hermes - open-source, model-agnostic agent | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` | Chat (ACP streaming) · CLI (xterm view) | - |
| **ollama** | Local Ollama CLI driving a pulled local model | install from [ollama.com](https://ollama.com/download), then `ollama pull <model>` | Chat | - |
| **kilo** | Kilo Code CLI in autonomous terminal mode | `npm install -g @kilocode/cli` and run `kilo` once to `/connect` | Chat | - |
| **aider** | [Aider](https://aider.chat) AI pair-programmer | `python -m pip install aider-install && aider-install` (or `pipx install aider-chat`), then set a provider API key | Chat · CLI (xterm) | - |

The picker shows real model names out of the box (Opus 4.8, GPT-5.5, Gemini 3.x…). Those labels live in your `config.yaml`, so a fresh install looks polished day one - while Grok, Pi, and Hermes report their model lists live at session start, and Aider surfaces the models for whichever provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are present in the gateway env.

> **Hermes cost note.** Unlike the subscription-wrapped engines, Hermes owns its own model loop and bills **per token** on the provider configured in `~/.hermes`. It streams over the Agent Client Protocol (ACP) and runs fully auto-approved. See [`docs/engines-hermes.md`](docs/engines-hermes.md).

<details>
<summary><b>How the Claude engine runs on your subscription</b> (the PTY details)</summary>

Cuttlefish drives the **real interactive `claude` binary inside a [node-pty](https://github.com/microsoft/node-pty) pseudo-terminal** - byte-for-byte identical to typing `claude` at your shell - so Anthropic's billing pipeline counts it against your Max/Pro subscription rather than your API credit pool. Every Claude turn (cron, Slack, web Chat, web CLI) flows through one path:

- **Hooks for turn boundaries.** A per-session settings file registers Claude Code's `SessionStart` / `Stop` / `PreToolUse` / `PostToolUse` hooks; a tiny relay POSTs each event back to the daemon over loopback, so it knows exactly when a turn starts, finishes, or hits a rate limit - no screen-scraping.
- **Real streaming.** The PTY's `claude` is pointed at a per-session loopback proxy via `ANTHROPIC_BASE_URL`; Cuttlefish intercepts the model's own SSE stream and forwards it to the UI word-by-word.
- **One process, two views.** The dashboard's Chat ↔ CLI toggle is two views of the *same* PTY: Chat renders the parsed stream, CLI attaches `xterm.js` to the live terminal.
- **Exact cost.** At turn end the daemon sums token usage straight from Claude Code's own transcript JSONL.

Codex, Grok, and Pi use a simpler spawn-per-turn model; Hermes streams over ACP. They don't have Claude's subscription-billing wrinkle, so they don't need a PTY.

</details>

---

## The org system

Employees are plain YAML files in `~/.cuttlefish/org/`. Each has a persona, a rank, a department, an engine, and a place in the hierarchy:

```yaml
name: research-lead
displayName: Research Lead
department: research
rank: manager
engine: claude
model: opus
reportsTo: chief-of-staff      # hierarchy of any depth
persona: |
  You lead market research. Break briefs into parallel sub-tasks,
  delegate to your analysts, and synthesize one clear answer.
```

Ranks (executive → manager → senior → employee) define default reporting lines; `reportsTo` overrides them for any depth you like. The COO delegates to managers, managers to their reports - and you watch the whole tree light up live.

<p align="center">
  <img src="assets/org-map.png" alt="Interactive org chart of AI employees across departments" width="900" />
</p>

Every department also has a **board**. Assign tickets to employees, watch work move across columns, and kick off an agent straight from a card.

<p align="center">
  <img src="assets/kanban.png" alt="Kanban board with tickets assigned to AI employees across columns" width="900" />
</p>

---

## Features

- **🔌 Ten engines, one picker** - Claude Code, Codex, Grok, Antigravity, Pi, Hermes, Kiro, Ollama, Kilo, Aider; pick engine + model + effort per session or per employee, switchable mid-chat.
- **🏢 AI org system** - employees, departments, ranks, managers, and a reporting hierarchy of any depth, all in editable YAML.
- **🧩 Real delegation** - parent/child sessions with completion callbacks and a COO-review pattern that filters noise before it reaches you.
- **⏰ Cron scheduling** - hot-reloadable background jobs with run history and optional failure alerts.
- **📦 Skills** - reusable markdown playbooks auto-synced into the underlying CLIs; install community skills with one command.
- **💬 Connectors** - Slack (threads + ✅ reaction approvals), WhatsApp, and inbound IMAP inbox polling/inspection.
- **🌐 Web dashboard** - chat, interactive org map, kanban boards, cron visualizer, usage & limits, activity logs, skills catalog, settings.
- **🖥️ Chat or raw terminal** - toggle any session between rendered chat and a live `xterm` view of the engine.
- **📎 Attachments** - drag, drop, or paste files and images into chat; passed through to the engine and rendered inline.
- **🎙️ Voice** - push-to-talk dictation (local Whisper) and a hands-free "Talk" mission-control mode with streaming TTS.
- **💰 Cost governance** - per-employee monthly budgets and per-session cost/time caps.
- **🗂️ Orchestration Command Center** - a durable, provider-neutral run scheduler with queue pause/resume, dual-lane (cross-provider) competition runs, worktree-isolated execution, recovery/requeue, and a dedicated operations dashboard.
- **🧾 Traceability & provenance** - a persistent run ledger and artifact-lineage store record what ran, on which engine, and what it produced, so outputs can be traced back to their originating session and inputs.
- **✅ Approval gates** - human approve/reject checkpoints surfaced in the dashboard (and via Slack ✅ reactions) before sensitive actions proceed.
- **🔄 Hot-reload & self-modification** - edit config, cron, org, or skills and the daemon reloads live; agents can edit those files too.
- **🔗 MCP support** - connect engines to any MCP server, with per-employee allow-lists.

## Lineage And Credit

Cuttlefish is forked from [`repo-makeover/jinn`](https://github.com/repo-makeover/jinn), which is itself a substantial rework/fork of the original [`hristo2612/jinn`](https://github.com/hristo2612/jinn). The original Jinn project and the direct `repo-makeover/jinn` fork remain the technical lineage and MIT-licensed basis for this work, and we gratefully credit their authors.

Where Jinn established the core idea - a lightweight gateway that orchestrates agent CLIs as an AI organization - Cuttlefish deliberately keeps that layer lightweight ("bus, not brain") and invests its divergence in **traceability, provenance capture, and governance**:

- **Traceability & provenance** - a persistent run ledger records every execution, and an artifact-lineage store links outputs back to the sessions, engines, and inputs that produced them, so any result can be audited end to end.
- **Governance** - human approval gates, per-employee budgets and session caps, policy evaluation with export gating, machine-readable governance metadata (`governance/*.yaml`), a maintained decision log, and documentation/validation ledgers.
- **Hardened orchestration** - a durable, provider-neutral run scheduler (queue controls, dual-lane runs, worktree-isolated execution, recovery/requeue) with an operations dashboard - added without turning the gateway itself into an agent framework.
- **Safety & engineering hygiene** - stricter file-read boundaries and transfer guards, SSRF protection, secret-stripped engine environments, Node 24 pinning, and explicit lint/typecheck/test surfaces with broad seam-test coverage.

The source-grounded fork diff lives in [`docs/UPSTREAM_DIFF_BASELINE.md`](docs/UPSTREAM_DIFF_BASELINE.md).

---

## What people build with it

- **A Slack bot that actually ships work** - @mention an employee, it codes, and reports back in-thread.
- **An always-on content pipeline** - cron jobs research, draft, fact-check, and publish on a schedule, reviewed by a COO.
- **A support desk** - inbound tickets triaged by an employee, with human ✅ approval before any reply goes out.
- **A research org** - a manager fans a question out to analysts in parallel, then synthesizes one answer.

---

## Configuration

Cuttlefish reads `~/.cuttlefish/config.yaml`:

```yaml
gateway:
  port: 8888
  host: "127.0.0.1"
  # /api/files/read is limited to these roots by default.
  # Omit to allow only ~/.cuttlefish plus Cuttlefish-managed file/upload directories.
  fileReadRoots:
    - "/path/to/project"
  # Unsafe escape hatch for single-user local installs only.
  allowArbitraryFileRead: false

engines:
  default: claude        # claude | codex | grok | antigravity | pi | hermes | kiro | ollama | kilo
  claude:
    bin: claude          # binary on your PATH (override to point elsewhere)
    model: opus
    effortLevel: medium
  codex:
    bin: codex
    model: gpt-5.5
  ollama:
    bin: ollama
    model: gemma4
  kilo:
    bin: kilo
    model: default

connectors:
  slack:
    shareSessionInChannel: false
    ignoreOldMessagesOnBoot: true
```

- **Engines** point at a CLI `bin` and a default `model`; `engines.default` selects which one new sessions use.
- **Ollama and Kilo are deliberately demoted in auto-selection.** Cuttlefish detects and exposes them everywhere, but setup and fallback ordering prefer the existing first-party agent CLIs unless you explicitly choose Ollama/Kilo or they are the only installed engines.
- **Cron jobs** live in `~/.cuttlefish/cron/jobs.json` (hot-reloaded).
- **Employees** live as YAML files in `~/.cuttlefish/org/` (registry rebuilds on change).
- **Skills** live in `~/.cuttlefish/skills/<name>/SKILL.md`.
- **External knowledge export** is optional and provider-neutral: default installs
  stay local-only, while `knowledge.sink.type` can be `noop`, `jsonl`, or
  `webhook`, and `knowledge.readProvider.type` can stay `none` or use a generic
  `webhook` lookup provider.

Everything is human-readable files you own - `cat` it, edit it, commit it.

---

## Roadmap

Cuttlefish is in active development. Shipped recently: the orchestration Command Center, approval gates, the run ledger and artifact-lineage provenance stores, ten-engine support, file attachments, agent-to-agent messaging, shared memory, and live streaming. On deck:

- **Engines** - deeper local-model support (llama.cpp and richer local-agent adapters), engine fallback chains.
- **Connectors** - iMessage, outbound email/reply workflows, generic webhooks.
- **Dashboard** - per-employee cost analytics, deeper orchestration run analytics.
- **Platform** - npm/Homebrew package publication, installable plugins, REST API auth, multi-user roles, Docker image.
- **Skills** - community marketplace, versioning, scaffolding templates.

Want to suggest something? [Open an issue](https://github.com/e3742526/cuttlefish/issues).

---

## Development

```bash
git clone https://github.com/e3742526/cuttlefish.git
cd cuttlefish
pnpm install
pnpm setup   # one-time: builds all packages and creates ~/.cuttlefish
pnpm dev     # gateway (:8888) + Vite dev server (:5888) with hot reload
```

Open **[http://localhost:5888](http://localhost:5888)** - Vite proxies `/api` and `/ws` to the gateway.

> **Prerequisites:** Node.js **24.13.0** (the repo pins it via `.nvmrc` + `engine-strict` - native modules like `better-sqlite3` are ABI-locked), pnpm 10+, and at least one engine CLI. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the full setup.

---

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for setting up your environment and submitting pull requests.
