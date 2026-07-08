# Giles Feature Ledger — Entry 0009

## Feature ID
`release-artifacts-macos-ubuntu-2026-07-08`

## Short Action Summary
Added a `release: published`-triggered GitHub Actions workflow that builds `cuttlefish-cli` on
`ubuntu-latest` and `macos-latest`, assembles a production-only package via `pnpm deploy --prod`,
archives it as a per-platform `.tar.gz`, and uploads both as release assets — giving users a
download-and-run install path (no `git clone`, npm, or Homebrew required) alongside the existing
npm-publish (`release-npm.yml`) and Homebrew-bump (`bump-formula.yml`) release workflows. Also
added a one-line README callout pointing to the new tarballs under "Packaged installs". This is a
scoped response to the request "Add release files for macOS Ubuntu"; per user clarification, the
chosen interpretation was downloadable per-OS tarballs (not a CI test matrix, not standalone
single-file binaries).

## Touched Files
- `.github/workflows/release-artifacts.yml` (new) — matrix job (`ubuntu-latest` → `linux-x64`,
  `macos-latest` → `darwin-arm64`); installs, builds, tests, verifies the release tag matches
  `packages/cuttlefish/package.json` version, runs `pnpm --filter=cuttlefish-cli deploy --prod`,
  tars the deploy output, and `gh release upload`s it with `--clobber`.
- `README.md` — one-line addition to the "Packaged installs" callout documenting the two tarball
  filenames and linking to the repo's GitHub Releases page.
- `.giles/feature-ledger/giles-ledger-0009-release-artifacts-macos-ubuntu.md` (this entry).

## Validation Run
- `node -e "yaml.load(...)"` / Python `yaml.safe_load(...)` against the new workflow file — both
  parsed without error (the top-level `True: {...}` shown by PyYAML is the standard YAML 1.1
  `on:`-as-boolean quirk; it matches the existing `on:` key style already used unmodified in
  `release-npm.yml` and `bump-formula.yml`, which GitHub Actions' own parser handles correctly).
- `pnpm --version` confirmed as 10.6.4 in this container, and `pnpm deploy --help` confirmed the
  `pnpm --filter=<pkg> deploy [--prod] <dir>` syntax used in the workflow.
- Not run: an actual end-to-end trigger of the new workflow. This container has no macOS runner
  and no `pnpm install`/`pnpm build` was executed here (no `node_modules` present, and a full
  workspace install/build was out of scope for authoring a CI workflow file) — the workflow's
  correctness rests on documented `pnpm deploy` behavior and the pre-existing conventions mirrored
  from `release-npm.yml` (pinned action SHAs, `.nvmrc`-driven Node version, `GITHUB_REF_NAME`
  version-tag check), not on a local dry run of the full build.

## Remaining Open Items
- First real verification will happen on the next tagged GitHub Release publish — confirm both
  matrix legs succeed, assets attach correctly, and the archive actually runs on a clean macOS /
  Ubuntu machine (native modules `better-sqlite3` / `node-pty` are the main platform-sensitivity
  risk).
- README still says the npm package and Homebrew formula are "pending first publication"
  (`README.md:50`, `:66`) while `Formula/cuttlefish.rb` already references a real published
  version (0.23.3) — this looks like pre-existing doc drift unrelated to this change; left
  untouched as out of scope.
- No Intel macOS (`darwin-x64`) or Linux ARM (`linux-arm64`) leg was added — scoped to exactly
  "macOS Ubuntu" per the task title; can be extended by adding matrix entries if needed.

## Provenance
Original — authored directly against the current repository state at HEAD of
`claude/release-files-macos-ubuntu-fnar4u` (base `main`) in response to the task "Add release
files for macOS Ubuntu", after an `AskUserQuestion` clarification narrowed the ambiguous title to
"downloadable per-OS tarballs attached to GitHub Releases". Not reconstructed from archive/session
logs.
