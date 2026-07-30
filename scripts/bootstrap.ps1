[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Resolve-RequiredCommand {
  param([Parameter(Mandatory)][string[]]$Names, [Parameter(Mandatory)][string]$Repair)
  foreach ($Name in $Names) {
    $Found = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Found) { return $Found.Source }
  }
  throw "Required command not found: $($Names -join ', '). Repair: $Repair"
}

function Invoke-Npm {
  param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
  & $script:NpmCommand @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

Write-Host "[1/7] Locating repository"
Write-Host "      $RepositoryRoot"
Push-Location $RepositoryRoot
try {
  Write-Host "[2/7] Checking Node and npm"
  $NodeCommand = Resolve-RequiredCommand -Names @('node.exe', 'node') -Repair 'winget install --id OpenJS.NodeJS.LTS -e'
  $script:NpmCommand = Resolve-RequiredCommand -Names @('npm.cmd', 'npm.exe', 'npm') -Repair 'winget install --id OpenJS.NodeJS.LTS -e'
  $NodeVersion = & $NodeCommand --version
  $NodeMajor = [int](($NodeVersion -replace '^v', '').Split('.')[0])
  if ($NodeMajor -lt 22) { throw "Node.js 22.5 or newer is required; found $NodeVersion." }
  Write-Host "      Node $NodeVersion"
  Write-Host "      npm $(& $script:NpmCommand --version)"

  Write-Host "[3/7] Installing dependencies"
  if (Test-Path (Join-Path $RepositoryRoot 'node_modules')) {
    Invoke-Npm install
  } else {
    Invoke-Npm ci
  }
  if (-not (Test-Path (Join-Path $RepositoryRoot 'node_modules\electron\path.txt'))) {
    Write-Host "      Installing the locked Electron runtime"
    Invoke-Npm run electron:install
  }

  Write-Host "[4/7] Running diagnostics"
  & $script:NpmCommand run doctor -- --json
  $DiagnosticsExitCode = $LASTEXITCODE
  if ($DiagnosticsExitCode -ne 0) {
    Write-Warning "Diagnostics found a blocking environment issue. Build and packaging will continue so repair artifacts are available."
  }

  Write-Host "[5/7] Building core packages and running tests"
  Invoke-Npm run build
  Invoke-Npm test

  Write-Host "[6/7] Packaging desktop and VS Code extension"
  Invoke-Npm run package

  Write-Host "[7/7] Next steps"
  Write-Host "      Start development: npm run dev"
  Write-Host "      Recheck tools:     npm run doctor"
  Write-Host "      Install extension: .\scripts\install-vscode-extension.ps1"
  Write-Host ""
  Write-Host "Optional integrations do not block local startup."
  Write-Host "GitHub CLI: winget install --id GitHub.cli -e"
  Write-Host "Codex CLI:  npm install -g @openai/codex"
  Write-Host "Codex login (after installation): codex login"
  if ($DiagnosticsExitCode -ne 0) {
    throw "Bootstrap produced the build artifacts, but diagnostics still contain a blocking environment issue. Run npm run doctor after completing the listed repair."
  }
} finally {
  Pop-Location
}
