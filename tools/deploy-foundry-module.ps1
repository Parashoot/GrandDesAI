[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $env:LOCALAPPDATA "FoundryVTT\Data\modules\grand-design-ai")
)

$ErrorActionPreference = "Stop"
$source = Join-Path (Split-Path $PSScriptRoot -Parent) "foundry-module"

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

robocopy $sourcePath $destinationPath /MIR /XD node_modules .git tests /XF *.md package.json package-lock.json /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -gt 7) {
  throw "Foundry module deployment failed with robocopy exit code $LASTEXITCODE."
}

$sourceVersion = (Get-Content (Join-Path $sourcePath "module.json") -Raw | ConvertFrom-Json).version
$destinationVersion = (Get-Content (Join-Path $destinationPath "module.json") -Raw | ConvertFrom-Json).version
if ($sourceVersion -ne $destinationVersion) {
  throw "Deployment verification failed: expected version $sourceVersion, found $destinationVersion."
}

Write-Output "Grand Design AI $destinationVersion deployed to $destinationPath."
