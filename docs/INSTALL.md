# Installing Cuttlefish

Cuttlefish is a Node.js gateway. You always need **Node.js 24** (`>=24 <25`;
this repo pins `24.13.0` via `.nvmrc`) and at least one engine CLI installed
**and signed in**. The CLI binary is `cuttlefish`; the published npm package
name is `cuttlefish-cli`.

Default runtime home: `~/.cuttlefish` (Windows: `%USERPROFILE%\.cuttlefish`).
Override with `CUTTLEFISH_HOME`.

## Install paths (pick one)

| Path | Best for | Status |
|------|----------|--------|
| **npm** `npm install -g cuttlefish-cli` | Everyday installs after a published release | Available only after the matching GitHub Release successfully publishes to npm — see [RELEASING.md](RELEASING.md) |
| **Homebrew** (macOS/Linux) | Formula users | Updated automatically after npm publish |
| **GitHub Release archive** | Offline / pinned platform trees with native modules prebuilt | `linux-x64` + `darwin-arm64` `.tar.gz`, `win32-x64` `.zip` attached to the release |
| **Source** | Contributors and pre-publish installs | Always works |

Until the first successful npm publication, **source** and (once a release
exists with assets) **platform archives** are the supported public paths.

---

## Prerequisites

1. **Node.js 24**
   - macOS/Linux: [nodejs.org](https://nodejs.org/), `nvm`, `fnm`, etc.
   - Windows (admin OK): `winget install --id OpenJS.NodeJS.LTS -e`
   - Windows (no admin): download the **Windows Binary (.zip)** from
     [nodejs.org/dist](https://nodejs.org/dist/) (e.g. `node-v24.x.x-win-x64.zip`),
     extract under `%LOCALAPPDATA%\Programs\`, and add that folder to your user `PATH`.
2. **pnpm 10+** only for source installs (`corepack enable` then
   `corepack prepare pnpm@10.6.4 --activate`, or `npm install -g pnpm`).
3. **An engine CLI**, signed in before you expect sessions to work — for example:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude   # /login, then quit
   ```

---

## Windows

### A. One-shot installer (source checkout)

From a clone of this repository:

```powershell
# Node 24 must already be on PATH
.\scripts\install.ps1 -FromSource -Force
```

This builds the monorepo, deploys a production package to
`%LOCALAPPDATA%\Programs\cuttlefish\`, adds `cuttlefish.cmd` to your user
`PATH`, and runs `cuttlefish setup`.

### B. Prebuilt win32-x64 zip (GitHub Release)

After a release that includes platform archives:

```powershell
# Latest release with a win32-x64 asset
irm https://raw.githubusercontent.com/cephalopod-ai/cuttlefish/main/scripts/install.ps1 -OutFile install.ps1
.\install.ps1 -FromRelease -Force

# Or a specific version / local file
.\install.ps1 -FromRelease -Version 0.23.3 -Force
.\install.ps1 -ArchivePath .\cuttlefish-cli-0.23.3-win32-x64.zip -Force
```

Asset name: `cuttlefish-cli-<version>-win32-x64.zip`  
(Contains `cuttlefish-cli\` production tree + `cuttlefish.cmd` launcher.)

### C. Build a local releasable zip (maintainers / offline handoff)

```powershell
.\scripts\package-windows.ps1
# -> dist-release\cuttlefish-cli-<version>-win32-x64.zip
.\scripts\install.ps1 -ArchivePath .\dist-release\cuttlefish-cli-<version>-win32-x64.zip -Force
```

### D. Source (manual)

```powershell
git clone https://github.com/cephalopod-ai/cuttlefish.git
cd cuttlefish
pnpm install
pnpm setup          # build + initialize %USERPROFILE%\.cuttlefish
pnpm cuttlefish start
```

Open a **new** terminal after `install.ps1` so the updated user `PATH` is picked
up, then:

```powershell
cuttlefish status
cuttlefish start
```

Dashboard: [http://localhost:8888](http://localhost:8888)

> **Native modules.** The production package ships platform-specific
> `better-sqlite3` and `node-pty` builds. Use the `win32-x64` archive built on
> Windows, or install from source/npm on the same OS/arch you will run.
> `better-sqlite3` **12.x** ships Node 24 (`NODE_MODULE_VERSION` 137) Windows
> prebuilds, so a source install on Windows does **not** require Visual Studio
> Build Tools when prebuilds download successfully. If prebuild-install fails,
> install “Desktop development with C++” (VS Build Tools) and re-run
> `pnpm install`.

---

## macOS / Linux

### npm (after publication)

```bash
npm install -g cuttlefish-cli
cuttlefish setup
cuttlefish start
```

### Homebrew (after publication)

```bash
# Formula lives in this repo (Formula/cuttlefish.rb) and is bumped by CI
# after npm publish — see docs/RELEASING.md
brew install ./Formula/cuttlefish.rb   # from a clone; tap path may vary
cuttlefish setup
cuttlefish start
```

### Platform archives

From the [GitHub Releases](https://github.com/cephalopod-ai/cuttlefish/releases)
page, download:

- `cuttlefish-cli-<version>-linux-x64.tar.gz`
- `cuttlefish-cli-<version>-darwin-arm64.tar.gz`

```bash
mkdir -p ~/.local/lib
tar -xzf cuttlefish-cli-<version>-linux-x64.tar.gz -C ~/.local/lib
# archive root contains cuttlefish-cli/
ln -sf ~/.local/lib/cuttlefish-cli/dist/bin/cuttlefish.js ~/.local/bin/cuttlefish
chmod +x ~/.local/bin/cuttlefish   # if needed; shebang is node
cuttlefish setup
cuttlefish start
```

(Ensure `~/.local/bin` is on `PATH` and Node 24 is available as `node`.)

### Source

```bash
git clone https://github.com/cephalopod-ai/cuttlefish.git
cd cuttlefish
pnpm install
pnpm setup
pnpm cuttlefish start
```

---

## After install

```bash
cuttlefish status
cuttlefish start      # opens the dashboard when possible
cuttlefish stop
cuttlefish restart
```

From a **source checkout** without a global install, prefix with `pnpm`
(`pnpm cuttlefish status`). For machine-readable JSON from source, use
`pnpm --silent cuttlefish … --json` so pnpm’s script banner does not pollute
stdout.

Sign in to each engine CLI before expecting model sessions — `--version` on an
engine only proves the binary is present, not that you are authenticated.

---

## Uninstall (Windows user install)

```powershell
# Stop the daemon if running
cuttlefish stop

# Remove install tree + PATH entry (edit user PATH if you prefer the UI)
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\cuttlefish"
# Optional: remove runtime home
# Remove-Item -Recurse -Force "$env:USERPROFILE\.cuttlefish"
```

Remove the install directory from your user `PATH` if it remains.

---

## Maintainer notes

- Release order and npm/GitHub/Homebrew contract: [RELEASING.md](RELEASING.md)
- Windows zip assets are produced by `.github/workflows/release-artifacts.yml`
  (and locally by `scripts/package-windows.ps1`).
- Do not present the historical failed `v0.1.0` pre-release as an installable
  package release.
