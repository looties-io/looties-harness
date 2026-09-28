#!/usr/bin/env bash
# Installs the nightly self-healing pass as a macOS launchd agent that runs at
# 03:00 (or at the next wake) from a dedicated worktree reset to
# origin/<integration branch> (`branches.integration` in
# .agents/harness.config.json, default dev), so the pass always runs the
# integrated code and never a work branch.
#   bash .agents/healing/install-nightly.sh [install|uninstall|run-now|status]
# The journal is initialised on install (a clone of `journalRepository` when
# the config names one, else a local directory). Each repository gets its own
# job, worktree and log: ~/Library/Logs/agent-harness-nightly-<repo>-<hash>.log.
# Owned by docs/agent-harness.md#self-healing-loop.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
common_dir="$(git -C "$script_dir" rev-parse --path-format=absolute --git-common-dir)"
repo="${common_dir%/.git}"
integration="$(cd "$repo" && node -e '
  const fs = require("node:fs");
  let branch = "dev";
  try {
    const config = JSON.parse(fs.readFileSync(".agents/harness.config.json", "utf8"));
    if (typeof config?.branches?.integration === "string" && config.branches.integration) branch = config.branches.integration;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch)) throw new Error(`invalid integration branch ${branch}`);
  process.stdout.write(branch);
')"
state="${XDG_STATE_HOME:-$HOME/.local/state}"
# One job per repository: the name and a hash of the path keep two
# repositories on one machine from sharing a worktree or a launchd label.
name="$(basename "$repo" | tr -c 'A-Za-z0-9-\n' '-' | tr -d '\n')"
slug="${name:-repo}-$(printf '%s' "$repo" | shasum -a 256 | cut -c1-8)"
worktree="$state/harness-nightly/$slug/worktree"
label="dev.agent-harness.nightly.$slug"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/agent-harness-nightly-$slug.log"
domain="gui/$(id -u)"
path_value="${HARNESS_NIGHTLY_PATH:-/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"
}

install() {
  if [ ! -e "$worktree/.git" ]; then
    git -C "$repo" fetch --quiet origin "$integration"
    mkdir -p "$(dirname "$worktree")"
    git -C "$repo" worktree add --quiet --detach "$worktree" "origin/$integration"
  fi
  if [ ! -f "$worktree/.agents/healing/nightly.mjs" ]; then
    echo "origin/$integration does not carry .agents/healing/nightly.mjs yet; install once the harness is merged there." >&2
    exit 1
  fi
  (cd "$worktree" && PATH="$path_value" node .agents/healing/journal-sync.mjs init)
  local command
  command="cd '$worktree' && git fetch --quiet origin '$integration' && git checkout --quiet --force --detach 'origin/$integration' && git clean -fdq && exec node .agents/healing/nightly.mjs"
  mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>-c</string><string>$(xml_escape "$command")</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$path_value</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST
  launchctl bootout "$domain/$label" 2>/dev/null || true
  launchctl bootstrap "$domain" "$plist"
  echo "Installed $label: nightly at 03:00 from $worktree; log $log"
}

case "${1:-install}" in
  install) install ;;
  uninstall)
    launchctl bootout "$domain/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "Removed $label; the worktree $worktree and the journal are kept."
    ;;
  run-now) launchctl kickstart "$domain/$label" ;;
  status) launchctl print "$domain/$label" | sed -n '1,25p' ;;
  *)
    echo "usage: install-nightly.sh [install|uninstall|run-now|status]" >&2
    exit 2
    ;;
esac
