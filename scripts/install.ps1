#Requires -Version 5.1
<#
.SYNOPSIS
  Install Cuttlefish on Windows (Node 24 required).

.DESCRIPTION
  Supports three install modes:

    1. From a local monorepo checkout (default when run from the repo):
         .\scripts\install.ps1 -FromSource

    2. From a prebuilt win32-x64 release archive (zip or tar.gz):
         .\scripts\install.ps1 -ArchivePath .\cuttlefish-cli-0.23.3-win32-x64.zip

    3. From the latest (or a named) GitHub Release asset:
         .\scripts\install.ps1 -FromRelease
         .\scripts\install.ps1 -FromRelease -Version 0.23.3

  The package is installed under %LOCALAPPDATA%\Programs\cuttlefish by default,
  a cuttlefish.cmd shim is placed on the user PATH, and `cuttlefish setup` runs
  unless -SkipSetup is passed.

.PARAMETER FromSource
  Build and install from the current git checkout (requires pnpm 10+).

.PARAMETER FromRelease
  Download the win32-x64 archive from GitHub Releases.

.PARAMETER ArchivePath
  Path to a local cuttlefish-cli-*-win32-x64.zip (or .tar.gz) archive.

.PARAMETER Version
  SemVer to download when using -FromRelease (default: latest non-prerelease).

.PARAMETER InstallDir
  Destination directory for the package tree.

.PARAMETER SkipSetup
  Install the CLI only; do not run `cuttlefish setup`.

.PARAMETER Force
  Overwrite an existing install directory.

.EXAMPLE
  .\scripts\install.ps1 -FromSource -Force

.EXAMPLE
  .\scripts\install.ps1 -FromRelease
#>
[CmdletBinding(DefaultParameterSetName = "FromSource")]
param(
  [Parameter(ParameterSetName = "FromSource")]
  [switch]$FromSource,

  [Parameter(ParameterSetName = "FromRelease")]
  [switch]$FromRelease,

  [Parameter(ParameterSetName = "Archive")]
  [string]$ArchivePath,

  [Parameter(ParameterSetName = "FromRelease")]
  [string]$Version,

  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\cuttlefish"),

  [string]$Repo = "cephalopod-ai/cuttlefish",

  [switch]$SkipSetup,

  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info([string]$Message) { Write-Host "[cuttlefish] $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "[cuttlefish] $Message" -ForegroundColor Yellow }
function Write-Err([string]$Message)  { Write-Host "[cuttlefish] ERROR: $Message" -ForegroundColor Red }

function Assert-Node24 {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Err "Node.js is not on PATH. Install Node 24 (LTS) first:"
    Write-Host "  winget install --id OpenJS.NodeJS.LTS -e"
    Write-Host "  # or portable zip: https://nodejs.org/dist/  (major version 24 only: >=24 <25)"
    exit 1
  }
  $raw = (& node -p "process.versions.node").Trim()
  $major = [int]($raw.Split(".")[0])
  if ($major -ne 24) {
    Write-Err "Cuttlefish requires Node.js 24.x (found $raw)."
    Write-Host "  winget install --id OpenJS.NodeJS.LTS -e"
    exit 1
  }
  Write-Info "Node.js $raw OK"
}

function Ensure-UserPathEntry([string]$Dir) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  $parts = $userPath -split ";" | Where-Object { $_ -and $_.Trim() -ne "" }
  $normalized = $Dir.TrimEnd("\")
  $exists = $parts | Where-Object { $_.TrimEnd("\") -ieq $normalized }
  if (-not $exists) {
    $newPath = if ($userPath.Trim() -eq "") { $normalized } else { "$userPath;$normalized" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Info "Added to user PATH: $normalized"
  } else {
    Write-Info "Already on user PATH: $normalized"
  }
  if ($env:Path -notlike "*$normalized*") {
    $env:Path = "$normalized;$env:Path"
  }
}

function Write-CmdShim([string]$ShimPath) {
  # Shim lives next to cuttlefish-cli\ so %~dp0cuttlefish-cli resolves the package.
  $content = @"
@ECHO OFF
SETLOCAL
WHERE node >NUL 2>&1
IF ERRORLEVEL 1 (
  ECHO cuttlefish: node is not on PATH. Install Node.js 24 and reopen the terminal.
  EXIT /B 1
)
node "%~dp0cuttlefish-cli\dist\bin\cuttlefish.js" %*
"@
  Set-Content -Path $ShimPath -Value $content -Encoding ASCII
  Write-Info "Wrote shim: $ShimPath"
}

function Expand-ArchiveSafe([string]$Archive, [string]$Dest) {
  if (Test-Path $Dest) {
    if ($Force) {
      Write-Warn "Removing existing install: $Dest"
      Remove-Item -Recurse -Force $Dest
    } else {
      Write-Err "Install directory already exists: $Dest (pass -Force to overwrite)"
      exit 1
    }
  }
  New-Item -ItemType Directory -Path $Dest -Force | Out-Null

  $ext = [System.IO.Path]::GetExtension($Archive).ToLowerInvariant()
  # Extract directly into the install dir (no temp copy). Prefer tar.exe for
  # both .zip and .tar.gz: Expand-Archive is very slow on large trees.
  Write-Info "Extracting archive into $Dest"
  if ($ext -eq ".zip" -or $Archive -match "\.tar\.gz$" -or $ext -eq ".tgz") {
    if (Get-Command tar -ErrorAction SilentlyContinue) {
      if ($ext -eq ".zip") {
        & tar -xf $Archive -C $Dest
      } else {
        & tar -xzf $Archive -C $Dest
      }
      if ($LASTEXITCODE -ne 0) { throw "tar extract failed with exit $LASTEXITCODE" }
    } elseif ($ext -eq ".zip") {
      Expand-Archive -Path $Archive -DestinationPath $Dest -Force
    } else {
      throw "tar is required to extract .tar.gz on this system"
    }
  } else {
    throw "Unsupported archive type: $Archive (expected .zip or .tar.gz)"
  }

  # Normalize: find package root without recursing into node_modules.
  # Expected layouts:
  #   <Dest>/cuttlefish-cli/{package.json,dist/bin/cuttlefish.js}
  #   <Dest>/{package.json,dist/bin/cuttlefish.js}
  $candidates = @(
    (Join-Path $Dest "cuttlefish-cli"),
    $Dest
  )
  $sourcePkg = $null
  foreach ($cand in $candidates) {
    if ((Test-Path (Join-Path $cand "package.json")) -and
        (Test-Path (Join-Path $cand "dist\bin\cuttlefish.js"))) {
      $sourcePkg = $cand
      break
    }
  }
  if (-not $sourcePkg) {
    Get-ChildItem -Path $Dest -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      if (-not $sourcePkg -and
          (Test-Path (Join-Path $_.FullName "package.json")) -and
          (Test-Path (Join-Path $_.FullName "dist\bin\cuttlefish.js"))) {
        $sourcePkg = $_.FullName
      }
    }
  }
  if (-not $sourcePkg) {
    throw "Archive does not look like a cuttlefish-cli production package (missing dist/bin/cuttlefish.js)."
  }

  $targetPkg = Join-Path $Dest "cuttlefish-cli"
  if ($sourcePkg -ne $targetPkg) {
    if (Test-Path $targetPkg) { Remove-Item -Recurse -Force $targetPkg }
    Move-Item -Path $sourcePkg -Destination $targetPkg -Force
  }
  return $targetPkg
}

function Install-FromArchive([string]$Archive) {
  Write-Info "Installing from archive: $Archive"
  $null = Expand-ArchiveSafe -Archive $Archive -Dest $InstallDir
  $shim = Join-Path $InstallDir "cuttlefish.cmd"
  Write-CmdShim -ShimPath $shim
  Ensure-UserPathEntry -Dir $InstallDir
  return $shim
}

function Install-FromSource {
  $repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
  Write-Info "Installing from source checkout: $repoRoot"

  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if (-not $pnpm) {
    Write-Info "pnpm not found; enabling via corepack"
    & corepack enable
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "corepack enable failed; trying npm install -g pnpm"
      & npm install -g pnpm@10.6.4
    } else {
      & corepack prepare pnpm@10.6.4 --activate
    }
  }

  Push-Location $repoRoot
  try {
    Write-Info "pnpm install"
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

    Write-Info "pnpm build"
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }

    Write-Info "Assembling production package (pnpm deploy --prod)"
    $deployDir = Join-Path $repoRoot "release\cuttlefish-cli"
    if (Test-Path (Join-Path $repoRoot "release")) {
      Remove-Item -Recurse -Force (Join-Path $repoRoot "release")
    }
    & pnpm --filter cuttlefish-cli deploy --prod --legacy $deployDir
    if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed" }

    if (Test-Path $InstallDir) {
      if ($Force) {
        Remove-Item -Recurse -Force $InstallDir
      } else {
        Write-Err "Install directory already exists: $InstallDir (pass -Force to overwrite)"
        exit 1
      }
    }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $targetPkg = Join-Path $InstallDir "cuttlefish-cli"
    Copy-Item -Path $deployDir -Destination $targetPkg -Recurse -Force

    $shim = Join-Path $InstallDir "cuttlefish.cmd"
    Write-CmdShim -ShimPath $shim
    Ensure-UserPathEntry -Dir $InstallDir
    return $shim
  } finally {
    Pop-Location
  }
}

function Get-ReleaseAssetUrl([string]$RequestedVersion) {
  $headers = @{
    "User-Agent" = "cuttlefish-install.ps1"
    "Accept"     = "application/vnd.github+json"
  }
  if ($RequestedVersion) {
    $tag = if ($RequestedVersion.StartsWith("v")) { $RequestedVersion } else { "v$RequestedVersion" }
    $api = "https://api.github.com/repos/$Repo/releases/tags/$tag"
  } else {
    $api = "https://api.github.com/repos/$Repo/releases/latest"
  }
  Write-Info "Fetching release metadata: $api"
  $release = Invoke-RestMethod -Uri $api -Headers $headers
  $asset = $release.assets |
    Where-Object { $_.name -match "win32-x64\.(zip|tar\.gz)$" } |
    Select-Object -First 1
  if (-not $asset) {
    $names = ($release.assets | ForEach-Object { $_.name }) -join ", "
    throw "No win32-x64 archive on release $($release.tag_name). Assets: $names"
  }
  Write-Info "Using asset $($asset.name) from $($release.tag_name)"
  return $asset.browser_download_url
}

function Install-FromRelease {
  $url = Get-ReleaseAssetUrl -RequestedVersion $Version
  $tmpFile = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetFileName(($url -split "\?")[0]))
  Write-Info "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $tmpFile -UseBasicParsing
  try {
    return Install-FromArchive -Archive $tmpFile
  } finally {
    Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
  }
}

# --- main ---
Assert-Node24

# Default parameter set is FromSource when no switches given.
if ($PSCmdlet.ParameterSetName -eq "FromSource" -and -not $FromSource -and -not $FromRelease -and -not $ArchivePath) {
  $FromSource = $true
}

$shim = $null
switch ($PSCmdlet.ParameterSetName) {
  "FromSource"  { $shim = Install-FromSource }
  "FromRelease" { $shim = Install-FromRelease }
  "Archive"     {
    if (-not (Test-Path $ArchivePath)) { Write-Err "Archive not found: $ArchivePath"; exit 1 }
    $shim = Install-FromArchive -Archive (Resolve-Path $ArchivePath)
  }
}

Write-Info "Installed. Shim: $shim"
& $shim --version
if ($LASTEXITCODE -ne 0) {
  Write-Warn "cuttlefish --version returned exit $LASTEXITCODE"
}

if (-not $SkipSetup) {
  Write-Info "Running cuttlefish setup"
  & $shim setup
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "cuttlefish setup exited $LASTEXITCODE - re-run manually after fixing engines/auth."
  }
}

Write-Host ""
Write-Info "Done. Open a new terminal (so PATH refreshes), then:"
Write-Host "  cuttlefish status"
Write-Host "  cuttlefish start"
Write-Host "Dashboard: http://localhost:8888"
Write-Host ""
Write-Warn "Install and sign in to at least one engine CLI (e.g. npm i -g @anthropic-ai/claude-code) before expecting sessions to reach models."

