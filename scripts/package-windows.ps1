#Requires -Version 5.1
<#
.SYNOPSIS
  Build a releasable cuttlefish-cli win32-x64 zip from the current checkout.

.DESCRIPTION
  Builds a *portable* production tree (classic npm node_modules, no pnpm
  junctions) so the archive can be extracted anywhere and still resolve deps.
  Writes:

    dist-release/cuttlefish-cli-<version>-win32-x64.zip

  Matching the asset name produced by .github/workflows/release-artifacts.yml.

.EXAMPLE
  .\scripts\package-windows.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$OutDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "dist-release")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot
try {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "node not on PATH (need Node 24)" }
  $raw = (& node -p "process.versions.node").Trim()
  if ([int]($raw.Split(".")[0]) -ne 24) { throw "Need Node 24.x (found $raw)" }

  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "Enabling pnpm via corepack..."
    & corepack enable
    & corepack prepare pnpm@10.6.4 --activate
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm not on PATH"
  }

  if (-not $SkipBuild) {
    Write-Host "pnpm install"
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
    Write-Host "pnpm build"
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
    Write-Host "pnpm --filter cuttlefish-cli verify:package"
    & pnpm --filter cuttlefish-cli verify:package
    if ($LASTEXITCODE -ne 0) { throw "verify:package failed" }
  }

  $version = & node -p "require('./packages/cuttlefish/package.json').version"
  $pkgSrc = Join-Path $repoRoot "packages\cuttlefish"
  $contractsSrc = Join-Path $repoRoot "packages\contracts"
  $stagingRoot = Join-Path $repoRoot "release"
  $staging = Join-Path $stagingRoot "cuttlefish-cli"

  if (Test-Path $stagingRoot) { Remove-Item -Recurse -Force $stagingRoot }
  New-Item -ItemType Directory -Path $staging -Force | Out-Null

  Write-Host "Staging package payload into $staging"
  foreach ($item in @("LICENSE", "README.md", "dist", "template", "assets")) {
    $from = Join-Path $pkgSrc $item
    if (-not (Test-Path $from)) { throw "Missing required package path: $from" }
    Copy-Item -Path $from -Destination (Join-Path $staging $item) -Recurse -Force
  }
  if (-not (Test-Path (Join-Path $staging "dist\bin\cuttlefish.js"))) {
    throw "Missing dist/bin/cuttlefish.js - run a full build first"
  }
  if (-not (Test-Path (Join-Path $staging "dist\web\index.html"))) {
    throw "Missing dist/web/index.html - root pnpm build must embed the web UI"
  }

  # Vendor the workspace contracts package so npm install does not need the monorepo.
  $vendorContracts = Join-Path $staging "vendor\contracts"
  New-Item -ItemType Directory -Path $vendorContracts -Force | Out-Null
  Copy-Item (Join-Path $contractsSrc "package.json") $vendorContracts
  if (-not (Test-Path (Join-Path $contractsSrc "dist"))) {
    throw "packages/contracts/dist missing - build contracts first"
  }
  Copy-Item (Join-Path $contractsSrc "dist") (Join-Path $vendorContracts "dist") -Recurse -Force

  # Rewrite package.json for a portable npm install (file: contracts, no bundledDeps).
  # Write UTF-8 *without BOM* - a UTF-8 BOM breaks JSON.parse in the CLI version reader.
  $pkgJsonPath = Join-Path $pkgSrc "package.json"
  $stagingPkgJson = Join-Path $staging "package.json"
  $rewriteJs = Join-Path $stagingRoot "rewrite-package-json.mjs"
  @'
import fs from "node:fs";
const [,, src, dest] = process.argv;
const pkg = JSON.parse(fs.readFileSync(src, "utf8"));
pkg.dependencies["@cuttlefish/contracts"] = "file:./vendor/contracts";
delete pkg.bundledDependencies;
fs.writeFileSync(dest, JSON.stringify(pkg, null, 2) + "\n", "utf8");
'@ | Set-Content -Path $rewriteJs -Encoding ascii
  & node $rewriteJs $pkgJsonPath $stagingPkgJson
  if ($LASTEXITCODE -ne 0) { throw "failed to write portable package.json" }
  Remove-Item -Force $rewriteJs -ErrorAction SilentlyContinue

  Write-Host "npm install --omit=dev (portable classic node_modules)"
  Push-Location $staging
  try {
    # npm writes warnings to stderr; do not treat them as terminating under Stop.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    $env:npm_config_ignore_scripts = "false"
    # npm 11 allow-scripts gate: approve known packages when the command exists.
    & npm approve-scripts better-sqlite3 node-pty protobufjs "@whiskeysockets/baileys" 2>&1 | Out-Host
    & npm install --omit=dev --no-fund --no-audit 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    # Force native install scripts even if they were gated on first pass.
    Push-Location "node_modules\better-sqlite3"
    try {
      if (Test-Path "package.json") {
        & npx --yes prebuild-install 2>&1 | Out-Host
      }
    } finally { Pop-Location }
    Push-Location "node_modules\node-pty"
    try {
      if (Test-Path "scripts\prebuild.js") {
        & node scripts/prebuild.js 2>&1 | Out-Host
        if (Test-Path "scripts\post-install.js") { & node scripts/post-install.js 2>&1 | Out-Host }
      }
    } finally { Pop-Location }

    $ErrorActionPreference = $prevEap

    # Materialize the file: contracts junction as a real directory so zip/tar is relocatable.
    $contractsLink = "node_modules\@cuttlefish\contracts"
    $contractsVendor = "vendor\contracts"
    if (Test-Path $contractsLink) {
      $item = Get-Item $contractsLink -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Write-Host "Materializing @cuttlefish/contracts junction as real files"
        & cmd /c "rmdir `"$contractsLink`""
        if (Test-Path $contractsLink) { throw "failed to remove contracts junction" }
        Copy-Item -Path $contractsVendor -Destination $contractsLink -Recurse -Force
      }
    }

    & node -e "require('better-sqlite3'); console.log('better-sqlite3-ok')"
    if ($LASTEXITCODE -ne 0) { throw "better-sqlite3 native binding unavailable" }
  } finally {
    Pop-Location
  }

  # Smoke checks before archiving (must resolve modules from the staging tree).
  Push-Location $staging
  try {
    & node "dist\bin\cuttlefish.js" --version
    if ($LASTEXITCODE -ne 0) { throw "portable cuttlefish --version failed" }
    & node -e "import('chokidar').then(()=>console.log('chokidar-ok'))"
    if ($LASTEXITCODE -ne 0) { throw "chokidar import failed in portable tree" }
    & node -e "const D=require('better-sqlite3'); console.log('sqlite-ok', new D(':memory:').prepare('select 1 as n').get())"
    if ($LASTEXITCODE -ne 0) { throw "better-sqlite3 import failed in portable tree" }
  } finally {
    Pop-Location
  }

  # Windows launcher next to package root inside the zip.
  $launcher = Join-Path $stagingRoot "cuttlefish.cmd"
  Set-Content -Path $launcher -Encoding ASCII -Value @"
@ECHO OFF
SETLOCAL
WHERE node >NUL 2>&1
IF ERRORLEVEL 1 (
  ECHO cuttlefish: node is not on PATH. Install Node.js 24 first.
  EXIT /B 1
)
node "%~dp0cuttlefish-cli\dist\bin\cuttlefish.js" %*
"@

  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
  $archiveName = "cuttlefish-cli-$version-win32-x64.zip"
  $archivePath = Join-Path $OutDir $archiveName
  if (Test-Path $archivePath) { Remove-Item -Force $archivePath }

  # tar.exe (Windows 10+) is faster/more reliable than Compress-Archive on large trees.
  Write-Host "Creating $archivePath"
  Push-Location $stagingRoot
  try {
    & tar -a -cf $archivePath *
    if ($LASTEXITCODE -ne 0) { throw "tar archive failed with exit $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  $sizeMb = [math]::Round((Get-Item $archivePath).Length / 1MB, 2)
  if ($sizeMb -le 0) { throw "Archive is empty: $archivePath" }
  Write-Host "Wrote $archivePath ($sizeMb MB)"
  Write-Host "Install with:"
  Write-Host "  .\scripts\install.ps1 -ArchivePath `"$archivePath`" -Force"
} finally {
  Pop-Location
}
