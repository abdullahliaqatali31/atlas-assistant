# Installs Atlas on this PC with one command (Windows 10/11, PowerShell 5.1+):
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 -From .\atlas-<version>-win-x64.zip
#   iwr -useb <address of install.ps1> | iex          (downloads the latest release)
#
# What it does: makes sure Node.js 22.13+ is here (installs the LTS with winget if
# not), unpacks Atlas to %LOCALAPPDATA%\Atlas\app, installs its two run-time
# modules, puts the `atlas` command on your PATH and starts Atlas, which opens
# in your browser. Your data (%APPDATA%\Personal Assistant) is never touched;
# keys stay in Windows Credential Manager.
param(
  # A release zip on this PC, or its web address. Empty: the latest release.
  [string]$From = $env:ATLAS_FROM,
  # Install without starting Atlas.
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Where releases are published (owner/repo on GitHub); ATLAS_REPO overrides it.
$Repo = if ($env:ATLAS_REPO) { $env:ATLAS_REPO } else { 'abdullahliaqatali31/atlas-assistant' }
$LatestRelease = "https://github.com/$Repo/releases/latest/download/atlas-win-x64.zip"

function Say($text) { Write-Host "  $text" -ForegroundColor Cyan }

# ── Node.js ─────────────────────────────────────────────
function NodeVersion {
  try { $v = (& node --version) 2>$null; if ($v -match '^v(\d+)\.(\d+)') { return [version]"$($Matches[1]).$($Matches[2])" } } catch {}
  return $null
}
$node = NodeVersion
if (-not $node -or $node -lt [version]'22.13') {
  Say 'Installing Node.js (LTS)...'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Node.js 22.13 or newer is needed. Install it from https://nodejs.org and run this again.' }
  winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $node = NodeVersion
  if (-not $node -or $node -lt [version]'22.13') { throw 'Node.js did not install. Install it from https://nodejs.org and run this again.' }
}
Say "Node.js $node"

# ── the files ───────────────────────────────────────────
$home_ = Join-Path $env:LOCALAPPDATA 'Atlas'
$app = Join-Path $home_ 'app'
$bin = Join-Path $home_ 'bin'
$tmp = Join-Path $env:TEMP "atlas-install-$PID"
New-Item -ItemType Directory -Force $tmp, $bin | Out-Null

if (-not $From) { $From = $LatestRelease }
$zip = Join-Path $tmp 'atlas.zip'
if ($From -match '^https?://') {
  Say "Downloading $From"
  Invoke-WebRequest -UseBasicParsing -Uri $From -OutFile $zip
} else {
  Copy-Item -LiteralPath (Resolve-Path $From) $zip
}

# A running Atlas is stopped first (it starts again at the end).
if (Test-Path (Join-Path $app 'bin\atlas.mjs')) {
  Say 'Stopping the running Atlas...'
  try { & node (Join-Path $app 'bin\atlas.mjs') stop | Out-Null } catch {}
}

Say "Unpacking to $app"
$stage = Join-Path $tmp 'stage'
Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
Move-Item $stage $app

Say 'Installing its modules...'
Push-Location $app
try { & npm install --omit=dev --no-audit --no-fund --loglevel=error | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' } } finally { Pop-Location }

# ── the atlas command ───────────────────────────────────
Set-Content -Encoding ASCII -Path (Join-Path $bin 'atlas.cmd') -Value "@node `"$app\bin\atlas.mjs`" %*"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $bin })) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';')) + ";$bin").TrimStart(';'), 'User')
  $env:Path += ";$bin"
  Say "Added $bin to your PATH (new terminals know 'atlas')."
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

if (-not $NoStart) {
  Say 'Starting Atlas...'
  & node (Join-Path $app 'bin\atlas.mjs') start
}
Write-Host ''
Write-Host '  Atlas is installed.  atlas | atlas open | atlas stop | atlas status' -ForegroundColor Green
Write-Host '  It starts with Windows; change that in Settings > Connection.' -ForegroundColor Green
