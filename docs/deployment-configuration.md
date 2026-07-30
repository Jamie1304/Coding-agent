# Deployment configuration

Deployment is disabled by default and this is not a run failure. The agent never invents deployment,
smoke-test, migration, or rollback commands. A project owner must add them to
`.agent/project.yml`.

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
  adapter: custom
  build: [npm run build:artifact]
  staging: [npm run deploy:staging]
  stagingSmoke: [npm run smoke:staging]
  production: [npm run deploy:production]
  productionSmoke: [npm run smoke:production]
  rollback: [npm run rollback:production]
```

Commands are tokenized and spawned without a shell. Quote executable paths containing spaces. The
working directory is the validated worktree.

Production requires successful local gates, security review, CI where GitHub is active, successful
configured staging and smoke tests, the tested commit, and a non-empty rollback command. Projects
with database migrations should make the deployment command create and verify a backup first.

If production smoke testing fails, the state machine enters `ROLLING_BACK`, runs rollback, records
its actual exit status, and never publishes a successful release. The fake adapter tests successful
staging/production and production-smoke failure with verified rollback.
