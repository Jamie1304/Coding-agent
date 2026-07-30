[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Npm = Get-Command npm.cmd, npm.exe, npm -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Npm) {
  throw 'npm was not found. Repair: winget install --id OpenJS.NodeJS.LTS -e'
}
Push-Location $RepositoryRoot
try {
  & $Npm.Source run dev
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
