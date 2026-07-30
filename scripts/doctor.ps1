[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = 'Stop'
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Npx = Get-Command npx.cmd, npx.exe, npx -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Npx) {
  throw 'npx was not found. Repair: winget install --id OpenJS.NodeJS.LTS -e'
}
Push-Location $RepositoryRoot
try {
  $Arguments = @('--no-install', 'tsx', '.\scripts\doctor.ts')
  if ($Json) { $Arguments += '--json' }
  & $Npx.Source @Arguments
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
