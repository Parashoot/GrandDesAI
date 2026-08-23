[CmdletBinding()]
param(
  [string]$Path = (Join-Path $env:LOCALAPPDATA "FoundryVTT\Data\grand-design-ai-reports\last-test-report.json")
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Path -PathType Leaf)) {
  throw "No Grand Design campaign report exists at $Path. Run the campaign macro first."
}

$report = Get-Content $Path -Raw | ConvertFrom-Json
Write-Output "Report: $($report.name)"
Write-Output "Completed: $($report.completedAt)"
Write-Output "Result: $($report.passed.Count)/$($report.expectedAssertions) passed; $($report.failed.Count) failed."
if ($report.failed.Count) {
  Write-Output "Failures:"
  $report.failed | ForEach-Object { Write-Output "- $_" }
}
Write-Output "Source: $Path"
