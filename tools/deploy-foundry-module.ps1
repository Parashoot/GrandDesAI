[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $env:LOCALAPPDATA "FoundryVTT\Data\modules\grand-design-ai")
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$source = Join-Path $repoRoot "foundry-module"

if (-not (Test-Path (Join-Path $source "module.json"))) {
  throw "Foundry module source was not found at $source."
}

$sourcePath = (Resolve-Path $source).Path
if (Test-Path $Destination) {
  $destinationPath = (Resolve-Path $Destination).Path
  if ($sourcePath -eq $destinationPath) {
    throw "The deployment destination cannot be the source directory."
  }
} else {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $destinationPath = (Resolve-Path $Destination).Path
}

# Build stamp (board 30f2b191). A new commit since the last deploy bumps the patch version in the
# SOURCE module.json (so the version really moves and robocopy /MIR cannot regress it); the stamp
# itself is written only to the DEPLOYED scripts/build-info.js, leaving the committed "dev" default alone.
$sha = "unknown"
$dirty = $false
try {
  $sha = (git -C $repoRoot rev-parse --short HEAD).Trim()
  $dirty = [bool](git -C $repoRoot status --porcelain -- foundry-module)
} catch {
  Write-Warning "git is unavailable; the build stamp will say 'unknown'."
}
$stampFile = Join-Path $destinationPath "scripts\build-info.js"
$lastSha = $null
if (Test-Path $stampFile) {
  $m = [regex]::Match((Get-Content $stampFile -Raw), 'sha:\s*"([^"]+)"')
  if ($m.Success) { $lastSha = $m.Groups[1].Value }
}
if ($sha -ne "unknown" -and $sha -ne $lastSha) {
  $manifestPath = Join-Path $sourcePath "module.json"
  $text = [System.IO.File]::ReadAllText($manifestPath)
  $bumped = [regex]::Replace($text, '("version":\s*"\d+\.\d+\.)(\d+)(")', { param($x) $x.Groups[1].Value + ([int]$x.Groups[2].Value + 1) + $x.Groups[3].Value }, 1)
  [System.IO.File]::WriteAllText($manifestPath, $bumped, (New-Object System.Text.UTF8Encoding($false)))
}

robocopy $sourcePath $destinationPath /MIR /XD node_modules .git tests /XF *.md package.json package-lock.json /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -gt 7) {
  throw "Foundry module deployment failed with robocopy exit code $LASTEXITCODE."
}

$builtAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
$stampLine = "export const BUILD = Object.freeze({ sha: `"$sha`", builtAt: `"$builtAt`", dirty: $($dirty.ToString().ToLower()) });"
$stampBody = (Get-Content (Join-Path $sourcePath "scripts\build-info.js") -Raw) -replace '(?m)^export const BUILD = .*$', $stampLine
[System.IO.File]::WriteAllText($stampFile, $stampBody, (New-Object System.Text.UTF8Encoding($false)))

$sourceVersion = (Get-Content (Join-Path $sourcePath "module.json") -Raw | ConvertFrom-Json).version
$destinationVersion = (Get-Content (Join-Path $destinationPath "module.json") -Raw | ConvertFrom-Json).version
if ($sourceVersion -ne $destinationVersion) {
  throw "Deployment verification failed: expected version $sourceVersion, found $destinationVersion."
}
$deployedStamp = Get-Content $stampFile -Raw
if ($deployedStamp -notmatch [regex]::Escape("sha: `"$sha`"")) {
  throw "Deployment verification failed: build stamp $sha was not written to $stampFile."
}

$dirtyNote = if ($dirty) { " + uncommitted changes" } else { "" }
Write-Output "Grand Design AI $destinationVersion (build $sha$dirtyNote, $builtAt) deployed to $destinationPath. Reload the world to load it."
