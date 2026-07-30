# Personal Codex Agent VS Code bridge

This local-only extension reports the active trusted workspace to the loopback daemon. It supports
multi-root workspaces, prefers the folder containing the active file, and never executes project
code. Use the Command Palette to open the desktop app, send selected prompt text, or explicitly set
the active project.

Install the packaged extension:

```powershell
code --install-extension .\artifacts\personal-codex-agent-vscode-0.2.0.vsix
```
