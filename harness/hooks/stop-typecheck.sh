#!/usr/bin/env bash
# Stop hook (Claude): typechecks at the end of a turn and wakes the session on
# failure (exit 2). It runs only the `typecheck` npm script, never a build,
# and exits 0 in a repository without one. Owned by
# docs/agent-harness.md#safety-nets.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
input=$(cat)
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0;; esac
[ -f package.json ] && [ -d node_modules ] || exit 0
node -e 'const p = JSON.parse(require("fs").readFileSync("package.json", "utf8")); process.exit(p.scripts && p.scripts.typecheck ? 0 : 1)' 2>/dev/null || exit 0
out=$(npm run --silent typecheck 2>&1) || { printf '%s\n' "$out" | tail -40 >&2; exit 2; }
