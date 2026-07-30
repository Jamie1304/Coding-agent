[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
try { npm run package; exit $LASTEXITCODE }
finally { Pop-Location }
