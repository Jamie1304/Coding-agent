[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
try { npm run test; exit $LASTEXITCODE }
finally { Pop-Location }
