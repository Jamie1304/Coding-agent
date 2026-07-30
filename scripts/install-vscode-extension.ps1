[CmdletBinding()]
param([string]$VsixPath)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $VsixPath) {
  $VsixPath = Join-Path $Root 'artifacts\personal-codex-agent-vscode-0.2.0.vsix'
}
$Resolved = Resolve-Path -LiteralPath $VsixPath -ErrorAction Stop
$CodeCommand = Get-Command code.cmd, code.exe, code -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $CodeCommand) {
  throw 'VS Code CLI was not found. Repair: winget install --id Microsoft.VisualStudioCode -e'
}
& $CodeCommand.Source --install-extension $Resolved.Path
if ($LASTEXITCODE -ne 0) { throw "VS Code extension installation failed." }
Write-Host "Installed $($Resolved.Path). Reload VS Code to activate it."
