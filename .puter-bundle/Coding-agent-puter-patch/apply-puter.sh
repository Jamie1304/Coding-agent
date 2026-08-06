#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATCH_PATH="$SCRIPT_DIR/puter-agent.patch"
REPOSITORY_PATH=${1:-.}

cd "$REPOSITORY_PATH"
git rev-parse --is-inside-work-tree >/dev/null
git apply --check "$PATCH_PATH"
git apply "$PATCH_PATH"
npm install

if [ ! -f .env ]; then
  cp .env.example .env
fi

npm run typecheck
npm exec -- vitest run tests/unit/puter-provider.test.ts
npm run build:daemon

printf '%s\n' 'Puter agent integration applied and validated.'
printf '%s\n' 'Start it with: npm run dev'
printf '%s\n' 'The first Puter run opens browser sign-in when PUTER_AUTH_TOKEN is empty.'
