#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { journalRoot } from '../hooks/journal.mjs';
import { harnessConfig, repoRoot, run } from './lib.mjs';

// The agent journal can be a clone of a private repository
// (`journalRepository` in the config, as owner/name; design decision 23), so
// the evidence survives the loss of a machine. Without one it stays local and
// a sync does nothing. Hooks only append locally; this script commits and
// pushes what they wrote. Every machine writes its own monthly stream files,
// so a rebase rarely meets a conflict; when it does, the sync stops and says
// so. The journal repository's own branch is `main`. Usage:
//   node .agents/healing/journal-sync.mjs init
//   node .agents/healing/journal-sync.mjs sync [--pull-only]
// Owned by docs/agent-harness.md#self-healing-loop.

export const JOURNAL_CONTENT = Object.freeze(['events', 'ledger', 'sessions', 'candidates', 'canaries', 'state', 'digests']);

export const LOCAL_ONLY = 'journalRepository is not set in .agents/harness.config.json: the journal stays local and is not synced';

/** The configured journal repository (owner/name), or null when the journal stays local. */
export function journalRepository(root = repoRoot) {
  const value = harnessConfig(root).journalRepository ?? null;
  if (value === null) return null;
  // A malformed value is a mistake, not a choice to stay local: say so.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`journalRepository must be owner/name or null, not ${JSON.stringify(value)}`);
  return value;
}

const README = `# Agent journal

Private evidence store of the agent harness's self-healing loop (design
decision 23). Written by the harness hooks and the nightly pass; read by
agents. Not project authority: the rules live in the project repository under
docs/agent-harness.md#self-healing-loop.

- events/, ledger/: append-only monthly JSONL streams, one file per machine.
- sessions/, candidates/, canaries/, state/, digests/: JSON and Markdown documents.

Secrets are redacted before anything is written.
`;

const git = (root, args, options = {}) => run('git', args, { cwd: root, ...options });

/** True when the clone's `origin` is `repository` on GitHub, over HTTPS or SSH. */
export function originIs(root, repository) {
  let url;
  try {
    url = git(root, ['remote', 'get-url', 'origin']).trim();
  } catch {
    return false;
  }
  const name = url.replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/, '').replace(/\.git$/, '');
  return name !== url && name.toLowerCase() === repository.toLowerCase();
}

// The private check covers the configured name; this one makes sure that
// name is where the clone actually pushes, so a renamed config never sends
// the journal to an older, possibly public, remote.
function assertOrigin(root, repository, check) {
  if (!check(root, repository)) throw new Error(`${root} does not push to ${repository} (its origin differs); fix the remote or journalRepository before syncing`);
}

/** GitHub's visibility of `repository`: PRIVATE, INTERNAL or PUBLIC. */
export const githubVisibility = (repository) => run('gh', ['repo', 'view', repository, '--json', 'visibility', '--jq', '.visibility']).trim();

// The journal holds user replies, restatements and blocked commands: it may
// only ever reach a private repository. A typo, a public repository or a
// failed lookup stops the sync before anything leaves the machine.
export function assertPrivate(repository, visibility = githubVisibility) {
  let value;
  try {
    value = visibility(repository);
  } catch (error) {
    throw new Error(`could not confirm that ${repository} is private (${String(error?.message ?? error).split('\n')[0]}); the journal is not synced`);
  }
  if (value !== 'PRIVATE') throw new Error(`${repository} is ${value || 'of unknown visibility'}, not PRIVATE; the journal holds session content and is never synced to it`);
}

export function initJournal(root = journalRoot(), { repository = journalRepository(), visibility = githubVisibility, origin = originIs } = {}) {
  if (!repository) {
    mkdirSync(root, { recursive: true });
    if (!existsSync(path.join(root, 'README.md'))) writeFileSync(path.join(root, 'README.md'), README);
    return `${LOCAL_ONLY} (${root})`;
  }
  assertPrivate(repository, visibility);
  if (existsSync(path.join(root, '.git'))) {
    assertOrigin(root, repository, origin);
    return `${root} is already a clone`;
  }
  if (existsSync(root) && readdirSync(root).length > 0) {
    // Hooks may have written before the clone existed: keep their files.
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
    // An empty remote has no main yet: the first sync creates it.
    if (hasRemoteMain(root)) {
      git(root, ['fetch', '-q', 'origin', 'main']);
      git(root, ['reset', '-q', 'origin/main']);
      // A mixed reset fills the index but leaves remote-only files missing.
      const missing = git(root, ['ls-files', '--deleted', '-z']).split('\0').filter(Boolean);
      if (missing.length) git(root, ['restore', '--source=origin/main', '--worktree', '--', ...missing]);
      // Append-only streams written on both sides keep every line: the
      // remote's first, then the local lines it does not have.
      const changed = git(root, ['diff', '--name-only', '-z', '--diff-filter=M']).split('\0').filter((file) => file.endsWith('.jsonl'));
      for (const file of changed) {
        const remote = git(root, ['show', `origin/main:${file}`]);
        const known = new Set(remote.split('\n'));
        const local = readFileSync(path.join(root, file), 'utf8').split('\n').filter((line) => line && !known.has(line));
        writeFileSync(path.join(root, file), `${remote}${remote && !remote.endsWith('\n') ? '\n' : ''}${local.length ? `${local.join('\n')}\n` : ''}`);
      }
    }
    if (!existsSync(path.join(root, 'README.md'))) writeFileSync(path.join(root, 'README.md'), README);
    return `${root} initialised on top of existing files`;
  }
  mkdirSync(path.dirname(root), { recursive: true });
  try {
    run('gh', ['repo', 'clone', repository, root, '--', '-q']);
  } catch {
    mkdirSync(root, { recursive: true });
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
  }
  if (!existsSync(path.join(root, 'README.md'))) writeFileSync(path.join(root, 'README.md'), README);
  return `${root} cloned`;
}

const hasRemoteMain = (root) => {
  try {
    git(root, ['ls-remote', '--exit-code', '--heads', 'origin', 'main']);
    return true;
  } catch (error) {
    if (error.status === 2) return false; // No matching head, including an empty origin.
    throw error;
  }
};

export function syncJournal({ root = journalRoot(), pullOnly = false, now = new Date(), repository = journalRepository(), visibility = githubVisibility, origin = originIs } = {}) {
  if (!repository) return { committed: false, pushed: false, skipped: LOCAL_ONLY };
  assertPrivate(repository, visibility);
  if (!existsSync(path.join(root, '.git'))) throw new Error(`${root} is not a clone of ${repository}; run journal-sync.mjs init`);
  assertOrigin(root, repository, origin);
  const paths = [...JOURNAL_CONTENT, 'README.md'].filter((entry) => existsSync(path.join(root, entry)));
  let committed = false;
  // Hooks append to tracked streams at any time: commit first, even before a
  // pull-only sync, so the rebase never meets unstaged changes.
  if (paths.length > 0) {
    git(root, ['add', '--', ...paths]);
    if (git(root, ['diff', '--cached', '--name-only']).trim()) {
      git(root, ['-c', 'user.name=Agent journal', '-c', 'user.email=agent-journal@localhost.invalid', 'commit', '-q', '-m', `journal: ${hostname().split('.')[0]} ${now.toISOString()}`]);
      committed = true;
    }
  }
  const remoteMain = hasRemoteMain(root);
  if (remoteMain) {
    try {
      git(root, ['pull', '-q', '--rebase', 'origin', 'main']);
    } catch (error) {
      try {
        git(root, ['rebase', '--abort']);
      } catch {
        // No rebase in progress.
      }
      throw new Error(`journal pull failed, local commits kept: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  let hasHead = true;
  try {
    git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  } catch {
    hasHead = false;
  }
  const ahead = hasHead && (!remoteMain || git(root, ['rev-list', '--count', 'origin/main..HEAD']).trim() !== '0');
  if (!pullOnly && ahead) git(root, ['push', '-q', 'origin', 'HEAD:main']);
  return { committed, pushed: !pullOnly && ahead };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    if (command === 'init') console.log(initJournal());
    else if (command === 'sync') console.log(JSON.stringify(syncJournal({ pullOnly: process.argv.includes('--pull-only') })));
    else {
      console.error('usage: journal-sync.mjs init | sync [--pull-only]');
      process.exit(2);
    }
  } catch (error) {
    console.error(`[journal] ${error.message}`);
    process.exit(1);
  }
}
