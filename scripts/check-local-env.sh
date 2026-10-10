#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_NODE="$(cat "$PROJECT_ROOT/.nvmrc")"
EXPECTED_ROOT="~/dev/DiaryPipeline"
EXPECTED_REMOTE="git@github.com:<you>/DiaryPipeline.git"

check_command() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    printf "[ok] %s: %s\n" "$name" "$(command -v "$name")"
  else
    printf "[missing] %s\n" "$name"
  fi
}

echo "Project root: $PROJECT_ROOT"
if [[ "$PROJECT_ROOT" == "$EXPECTED_ROOT" ]]; then
  echo "[ok] active repo path matches ACTIVE_REPO.md"
else
  echo "[warning] active repo path does not match ACTIVE_REPO.md"
  echo "Expected: $EXPECTED_ROOT"
fi
echo "Expected Node version: $EXPECTED_NODE"
echo

check_command git
check_command brew
check_command fnm
check_command node
check_command npm
echo

if command -v node >/dev/null 2>&1; then
  CURRENT_NODE="$(node -v 2>/dev/null || true)"
  echo "Detected Node version: $CURRENT_NODE"
  if [[ "$CURRENT_NODE" != "v$EXPECTED_NODE" ]]; then
    echo "Node version does not match .nvmrc"
  fi
fi

if [[ -f "$PROJECT_ROOT/.env.local" ]]; then
  echo ".env.local present"
else
  echo ".env.local missing"
fi

if [[ -f "$PROJECT_ROOT/node_modules/.bin/tsc" ]] && [[ ! -L "$PROJECT_ROOT/node_modules/.bin/tsc" ]]; then
  echo "Warning: node_modules/.bin/tsc is a plain file, not a symlink"
  echo "This can happen when node_modules was copied between machines instead of installed locally"
  echo "Recommended fix: rm -rf node_modules && npm install"
fi

if git -C "$PROJECT_ROOT" remote get-url origin >/dev/null 2>&1; then
  ORIGIN_URL="$(git -C "$PROJECT_ROOT" remote get-url origin)"
  echo "Git remote origin: $ORIGIN_URL"
  if [[ "$ORIGIN_URL" == "$EXPECTED_REMOTE" ]]; then
    echo "[ok] Git remote origin matches canonical GitHub repo"
  else
    echo "[warning] Git remote origin does not match canonical GitHub repo"
    echo "Expected: $EXPECTED_REMOTE"
  fi
else
  echo "Git remote origin is not configured"
fi

echo
echo "Recommended next steps:"
echo "1. brew install fnm"
echo "2. Add 'eval \"\$(fnm env --use-on-cd --shell zsh)\"' to ~/.zshrc"
echo "3. fnm install && fnm use"
echo "4. npm install"
echo "5. Fill in .env.local"
