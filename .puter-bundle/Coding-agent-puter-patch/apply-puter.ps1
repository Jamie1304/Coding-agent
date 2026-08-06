param(
  [string]$RepositoryPath = "."
)

$ErrorActionPreference = "Stop"
$PatchPath = Join-Path $PSScriptRoot "puter-agent.patch"
$ResolvedRepository = (Resolve-Path $RepositoryPath).Path

function Assert-LastExitCode {
  param([string]$Step)
  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit code $LASTEXITCODE."
  }
}

Push-Location $ResolvedRepository
try {
  & git rev-parse --is-inside-work-tree | Out-Null
  Assert-LastExitCode "Git repository check"

  & git apply --check $PatchPath
  Assert-LastExitCode "Patch preflight"

  & git apply $PatchPath
  Assert-LastExitCode "Patch application"

  & npm install
  Assert-LastExitCode "Dependency installation"

  if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
  }

  & npm run typecheck
  Assert-LastExitCode "TypeScript check"

  & npm exec -- vitest run tests/unit/puter-provider.test.ts
  Assert-LastExitCode "Puter provider tests"

  & npm run build:daemon
  Assert-LastExitCode "Daemon build"

  Write-Host "Puter agent integration applied and validated."
  Write-Host "Start it with: npm run dev"
  Write-Host "The first Puter run opens browser sign-in when PUTER_AUTH_TOKEN is empty."
} finally {
  Pop-Location
}
