# Releasing Cuttlefish

This document is the release contract for the npm package, GitHub platform
archives, and the in-repository Homebrew formula.

## Before Creating A GitHub Release

1. Choose a new, unpublished SemVer version.
2. Set `packages/cuttlefish/package.json` to that version and update
   `CHANGELOG.md`.
3. Run the normal root validation plus the package-content gate:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   pnpm --filter cuttlefish-cli verify:package
   ```

4. Commit those files and create a `v<same-version>` tag on that commit. For
   example, package version `0.24.0` requires tag `v0.24.0`.
5. Publish the GitHub Release from that tag. Do not reuse a tag or package
   version: npm versions are immutable.

## Automated Order

The release workflows deliberately run in this order:

1. **Publish npm Package** validates the tag/version match, runs the project
   checks, verifies the tarball contents (including the bundled shared runtime
   contract), and publishes with npm provenance.
2. **Release Artifacts** runs only after that workflow succeeds. It builds the
   platform-specific production dependency trees and uploads the archives to
   the existing GitHub Release:

   | Asset | Runner | Format |
   |-------|--------|--------|
   | `cuttlefish-cli-<ver>-linux-x64.tar.gz` | `ubuntu-latest` | tar.gz |
   | `cuttlefish-cli-<ver>-darwin-arm64.tar.gz` | `macos-latest` | tar.gz |
   | `cuttlefish-cli-<ver>-win32-x64.zip` | `windows-2022` | zip (+ `cuttlefish.cmd` launcher) |

   Local dry-run on Windows (no GitHub upload): `.\scripts\package-windows.ps1`.
   End-user Windows install: `.\scripts\install.ps1` (see [INSTALL.md](INSTALL.md)).
3. **Bump Homebrew Formula** runs only after successful npm publication. It
   retrieves the published tarball with an HTTP failure check, calculates its
   SHA-256, and commits the formula update.

This sequence means an npm failure cannot leave a release claiming binary
archives or a Homebrew formula for a tarball that does not exist.

## Recovery

If a release tag does not match `packages/cuttlefish/package.json`, the npm
and artifact jobs stop before publication. Correct the version on `main`, use
a new SemVer version and tag, and publish a new GitHub Release. Do not move or
reuse the failed tag.

`v0.1.0` is such a historical failed pre-release: it did not publish
`cuttlefish-cli` or release platform archives. It must not be presented as an
installable package release.
