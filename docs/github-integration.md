# GitHub integration

GitHub operations are behind `GitHubAdapter`; the production adapter invokes GitHub CLI with argument
arrays and real exit codes. It checks `gh auth status`, creates an issue containing the frozen
specification, pushes only the run branch, creates a pull request against the detected default
branch, waits for Actions, and merges only when project configuration enables automatic merge.

Install and authenticate on Windows:

```powershell
winget install --id GitHub.cli -e
gh auth login
gh auth status
```

Use the least-privileged repository access that can read Actions and create issues, branches, pull
requests, merges, releases, and tags required by the selected workflow. Protected-branch policies
remain authoritative. No operation pushes directly to the default branch.

Project configuration:

```yaml
version: 1
quality:
  install: [npm ci]
  focused: [npm run test:unit]
  full: [npm run validate]
  security: [npm audit --audit-level=high]
github:
  enabled: true
  mergeMethod: squash
  autoMerge: false
deployment:
  adapter: disabled
```

If `gh` is missing, authentication fails, no origin exists, GitHub is unavailable, CI fails, or the
branch is protected, the run records the precise stage and error. Tests use `FakeGitHubAdapter` for
issue, pull request, CI success/failure, and merge behavior. No live GitHub success is asserted by
this repository's local validation.
