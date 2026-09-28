#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { DEFAULT_CONFIG, LOOP_ENV, loadConfig } from './config.mjs';
import { JOURNAL_DIRECTORY, appendRecord, inJournal, journalMuted, journalRoot } from './journal.mjs';
import { effectiveLevel, isEntrypoint, normalize, readStdin, readTranscript, respondPreToolUse, toolFromArgv, truncate } from './lib.mjs';
import { basename, parseCommands } from './shell.mjs';
import { STAMP_DIRECTORY, readReview, stampRoot } from './stamps.mjs';

// Guard hook (PreToolUse, Claude and Codex). It enforces the "Never" list and
// the production confirmations of docs/agent-harness.md, and lets an L0 merge
// into the integration branch through only with a head-bound independent
// review. Branch names, the CI workflow, the production commands and the
// protected configuration come from .agents/harness.config.json, read on every
// call. Verdicts: pass (stay silent), ask (Claude asks the maintainer; Codex
// blocks and hands the command over), deny (blocked everywhere).

const SEVERITY = { pass: 0, allow: 1, ask: 2, deny: 3 };
const APPROVAL_LINE = /^Independent review:\s*(APPROVE|REQUEST_CHANGES)\s+([0-9a-f]{40})\b/;
// A real approval line: at the start of a line, with a full head SHA.
const APPROVAL_MARKER = /^\s*Independent review:\s*APPROVE\s+[0-9a-f]{40}\b/m;
const FULL_SHA = /^[0-9a-f]{40}$/;
const ENV_FILE = /^\.env(?:\..+)?$/;
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)(?:\..+)?$/;
// Names a glob is tested against: a glob that matches one of them reads a secret file.
const ENV_SAMPLES = ['.env', '.env.local', '.env.production', '.env.development', '.env.production.local'];
const PRINTERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk', 'strings', 'xxd', 'od', 'hexdump', 'base64', 'cut', 'sort', 'uniq', 'nl', 'tac', 'diff', 'cmp', 'jq', 'yq', 'cp', 'mv', 'scp', 'rsync', 'open', 'code', 'vim', 'vi', 'nano', 'pbcopy', 'curl', 'dotenv']);
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk', 'jq', 'yq']);
// Commands whose file operands end up in their output, for the approval tripwire.
const FILE_READERS = new Set(['cat', 'head', 'tail', 'sed', 'awk', 'tee']);
const WRITERS = new Set(['tee', 'truncate', 'touch']);
// Commands that write only their last operand, and those that remove or
// change every operand.
const COPIERS = new Set(['cp', 'install', 'ln']);
const REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'mv']);
const MODE_CHANGERS = new Set(['chmod', 'chown', 'chgrp', 'chflags']);
// The harness's own enforcement (design decision 20): its hooks, their
// settings, manifest, generated hashes, generator and config, the reviewer
// role whose verdict unlocks a merge, the self-healing gate (its scripts,
// canary cases and admitted rules), and git hooks. The config counts because a
// looser config is a weaker guard. Matched on the absolute path, so the main
// checkout's `.codex/` seen from a worktree and the user-level settings count
// too.
const HARNESS_FILES = [
  /(?:^|\/)\.agents\/hooks(?:\/|$)/,
  /(?:^|\/)\.agents\/manifest(?:\.state)?\.json$/,
  /(?:^|\/)\.agents\/harness\.config\.json$/,
  /(?:^|\/)\.agents\/(?:evals|rules\/learned|healing)(?:\/|$)/,
  /(?:^|\/)\.agents\/(?:sync-adapters|check)\.mjs$/,
  /(?:^|\/)\.agents\/agents\/(?:reviewer|healer)\.md$/,
  /(?:^|\/)\.claude\/agents\/(?:reviewer|healer)\.md$/,
  /(?:^|\/)\.codex\/agents\/reviewer\.toml$/,
  /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/,
  /(?:^|\/)\.codex\/(?:hooks\.json|config\.toml)$/,
  /(?:^|\/)\.git\/hooks(?:\/|$)/,
  /(?:^|\/)\.husky(?:\/|$)/,
];
// Directories that contain harness files: removing, moving or restoring one reaches them.
const HARNESS_PARENTS = /(?:^|\/)(?:\.agents(?:\/rules|\/agents)?|\.claude(?:\/agents)?|\.codex(?:\/agents)?|\.git)$/;
const HARNESS_MENTION = /\.agents\/(?:hooks|manifest(?:\.state)?\.json|harness\.config\.json|agents\/(?:reviewer|healer)\.md|evals|healing|rules\/learned|sync-adapters\.mjs|check\.mjs)|(?:\.claude|\.codex)\/agents\/(?:reviewer|healer)|\.claude\/settings|\.codex\/(?:hooks\.json|config\.toml)|\.git\/hooks|\.husky/;
// A write, removal or move whose arguments name a harness file. Only the call
// counts: code that imports or reads these files, or merely quotes one in a
// string it parses, passes.
const MENTION = HARNESS_MENTION.source;
const NODE_WRITE_CALL = new RegExp(`\\b(?:writeFile|appendFile|rm|rmdir|unlink|rename|copyFile|cp|truncate|chmod|symlink|link|createWriteStream)(?:Sync)?\\s*\\(\\s*[^)]*?(?:${MENTION})`);
const SCRIPT_WRITE_CALL = new RegExp(`\\bopen\\s*\\([^)]*?(?:${MENTION})[^)]*?,\\s*['"][^'"]*[wax+]|\\b(?:remove|unlink|rename|replace|rmtree|move|copy\\w*|write_text|write_bytes|chmod|delete|write)\\s*\\([^)]*?(?:${MENTION})|(?:${MENTION})[^)]*\\)\\s*\\.\\s*(?:write_text|write_bytes|unlink|rename|replace|chmod)\\b`);
const NODE_RUNTIMES = new Set(['node', 'deno', 'bun', 'tsx']);
const INLINE_CODE_FLAGS = new Set(['-e', '-E', '-c', '-p', '--eval', '--print']);
const GH_TIMEOUT_MS = 10_000;

const verdict = (decision, reason) => ({ decision, reason });
const PASS = verdict('pass', '');
const worst = (verdicts) => verdicts.reduce((current, next) => (SEVERITY[next.decision] > SEVERITY[current.decision] ? next : current), PASS);
const firstLine = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 160);

// ---------------------------------------------------------------------- config

// The repository's config, read on every call (docs/agent-harness.md#configuration).
const integrationBranch = (context) => context.config.branches.integration;
const releaseBranch = (context) => context.config.branches.release;
const protectedBranches = (context) => new Set([integrationBranch(context), releaseBranch(context)]);
const compiledConfig = new WeakMap();

// Lint, test and build configuration: the config's patterns, compiled once per config.
function protectedConfigPatterns(config) {
  if (!compiledConfig.has(config)) compiledConfig.set(config, (config.protectedConfig ?? []).map((pattern) => new RegExp(pattern)));
  return compiledConfig.get(config);
}

// The production commands as { command, effect }; a bare string is a command.
export function productionEntries(config) {
  return (config?.productionCommands ?? [])
    .map((entry) => (typeof entry === 'string' ? { command: entry } : entry))
    .filter((entry) => typeof entry?.command === 'string' && entry.command.trim() !== '');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export const defaultDeps = {
  env: process.env,
  repoRoot(cwd) {
    try {
      return git(['rev-parse', '--show-toplevel'], cwd);
    } catch {
      return cwd;
    }
  },
  // The effective config of the repository at `root`; throws when it cannot be read.
  config: loadConfig,
  currentBranch(cwd) {
    try {
      return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    } catch {
      return '';
    }
  },
  readFile(path) {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ? readFileSync(path, 'utf8') : null;
  },
  isDirectory(path) {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  },
  gh(args, cwd) {
    return execFileSync('gh', args, { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  },
  revParse(ref, cwd) {
    try {
      return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    } catch {
      return '';
    }
  },
  // True when `ancestor` is an ancestor of `sha`; throws when git cannot tell.
  isAncestor(ancestor, sha, cwd) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', ancestor, sha], { cwd, timeout: 5000, stdio: 'ignore' });
      return true;
    } catch (error) {
      if (error?.status === 1) return false;
      throw error;
    }
  },
  review(sha, cwd) {
    return readReview(stampRoot(cwd), sha);
  },
  configGet(key, cwd) {
    try {
      return git(['config', '--get', key], cwd);
    } catch {
      return '';
    }
  },
  // The non-empty lines git prints for `args`; throws when git fails.
  gitLines(args, cwd) {
    return git(args, cwd).split('\n').map((line) => line.trim()).filter(Boolean);
  },
  // Design decision 24: the files outside `excluded` that name one of `paths`
  // (git grep exits 1 when nothing matches).
  codeReferences(paths, excluded, cwd) {
    const result = spawnSync('git', ['grep', '-l', '-F', ...paths.flatMap((path) => ['-e', path]), '--', '.', ...excluded.map((pattern) => `:(exclude,glob)${pattern.includes('/') || !pattern.startsWith('*') ? pattern : `**/${pattern}`}`)], { cwd, timeout: 10_000, encoding: 'utf8' });
    if (result.status === 1) return [];
    if (result.error || result.status !== 0) throw result.error ?? new Error(`git grep exited ${result.status}`);
    return String(result.stdout).split('\n').filter(Boolean);
  },
  // Design decision 24: the documentation findings a docs-only push to the
  // integration branch is checked against, from the config's `docsCheck`
  // argv. Exit 1 only means some exist, anything else means the check itself
  // broke.
  checkDocs(cwd, argv) {
    const result = spawnSync(argv[0], argv.slice(1), { cwd, timeout: 20_000, encoding: 'utf8' });
    if (result.error || (result.status !== 0 && result.status !== 1)) throw result.error ?? new Error(`the docs check exited ${result.status}`);
    return result.status === 0 ? [] : String(result.stderr).split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
  },
  transcript: readTranscript,
};

// A file the guard cannot read is treated as unreadable, never as a crash.
function readText(context, path) {
  try {
    return context.deps.readFile(resolve(context.cwd, path));
  } catch {
    return null;
  }
}

/** Returns { decision: 'pass' | 'allow' | 'ask' | 'deny', reason } for one tool call. */
export function evaluate(input, deps = defaultDeps) {
  return nightlyVerdict(evaluateCall(input, deps), deps.env);
}

/** Headless nightly sessions have nobody to answer an ask: refuse instead. */
export function nightlyVerdict(result, env) {
  if (env[LOOP_ENV.nightly] === '1' && result.decision === 'ask') return verdict('deny', `${result.reason} (The nightly pass has nobody to ask, so this is refused.)`);
  return result;
}

function evaluateCall(input, deps) {
  const context = { input, deps, cwd: input.cwd, root: null, config: null };
  context.root = deps.repoRoot(input.cwd);
  if (isHealingRun(context)) return healingVerdict(input, context);
  if (input.kind === 'bash') {
    // A config the guard cannot read throws here, so the fallback asks.
    context.config = deps.config(context.root);
    return evaluateBash(input.command, context);
  }
  if (input.kind === 'read') return worst(input.paths.map((path) => envFileVerdict(path, 'read')));
  if (input.kind === 'search') return worst([...input.paths.map((path) => envFileVerdict(path, 'search')), envGlobVerdict(input.glob ?? '', 'search')]);
  if (input.kind === 'edit' || input.kind === 'patch') {
    // An unreadable config still leaves the harness files, secrets, approvals
    // and journal guarded, and the default protected configuration; editing
    // the config itself asks as a harness file.
    try {
      context.config = deps.config(context.root);
    } catch {
      context.config = DEFAULT_CONFIG;
    }
    return worst([
      ...input.paths.map((path) => envFileVerdict(path, 'edit')),
      ...input.paths.map((path) => configVerdict(path, context)),
      ...input.paths.map((path) => harnessVerdict(path, context, 'This edit')),
      ...input.paths.map((path) => (inStampStore(path) ? stampWrite(path) : PASS)),
      ...input.paths.map((path) => (touchesJournal(path, context) ? journalWrite(path) : PASS)),
    ]);
  }
  return PASS;
}

// When the guard itself fails, a command that can reach GitHub, git remotes
// or a configured production command asks instead of passing (design
// decision 8: errors never open the gate). Anything else passes, so a guard
// bug cannot block all work. When the config itself cannot be read, only gh
// and git ask.
export function fallbackVerdict(input, error, deps = defaultDeps) {
  const command = input?.command ?? '';
  if (!command) return PASS;
  const programs = new Set(['gh', 'git']);
  try {
    for (const entry of productionEntries(deps.config(deps.repoRoot(input.cwd)))) programs.add(basename(entry.command.trim().split(/\s+/)[0]));
  } catch {
    // The config is what failed: gh and git still ask.
  }
  const names = [...programs].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!new RegExp(`(?<!\\w)(?:${names})(?!\\w)`).test(command)) return PASS;
  return verdict('ask', `The guard failed on this command (${firstLine(error)}), so it needs the maintainer's confirmation. Standard: docs/agent-harness.md#safety-nets`);
}

function evaluateBash(command, context) {
  const commands = parseCommands(command);
  const verdicts = [];
  let cwd = context.cwd;
  let branchSwitched = false;
  // An environment variable can make a git "read" run a program (external
  // diff, pager, fsmonitor through GIT_CONFIG_*), wherever the line sets it.
  const gitEnvironment = commands.some(({ argv, env }) => Object.keys(env ?? {}).some((name) => GIT_RUNS_PROGRAM.test(name)) || (['export', 'declare', 'typeset', 'env', 'set'].includes(basename(argv[0] ?? '')) && argv.slice(1).some((token) => GIT_RUNS_PROGRAM.test(token.replace(/^-\w+$/, '')))));
  verdicts.push(loopEnvironmentVerdict(commands, command));
  for (const simple of commands) {
    // `cd` changes the directory of the commands after it on the same line.
    if (['cd', 'pushd'].includes(simple.argv[0]) && simple.argv[1] && !simple.argv[1].startsWith('-')) cwd = resolve(cwd, simple.argv[1].replace(/^~(?=\/|$)/, context.deps.env.HOME ?? '~'));
    verdicts.push(evaluateSimple(simple, { ...context, cwd, branchSwitched }));
    // The nightly admission session pushes one reviewed docs commit; it never merges.
    if (context.deps.env[LOOP_ENV.nightly] === '1' && basename(simple.argv[0] ?? '') === 'gh' && ((simple.argv[1] === 'pr' && simple.argv[2] === 'merge') || (simple.argv[1] === 'api' && simple.argv.some((token) => /\/merges?\b|mergePullRequest|enablePullRequestAutoMerge/.test(token))))) verdicts.push(verdict('deny', `The nightly admission session pushes its reviewed documentation commit to ${integrationBranch(context)} and never merges a pull request. Standard: docs/agent-harness.md#self-healing-loop`));
    // Journal paths resolve from the directory this command runs in.
    verdicts.push(journalVerdict([simple], { ...context, cwd, gitEnvironment }));
    // The guard reads the current branch before the line runs, so a later
    // implicit push after a checkout would be judged against the wrong branch.
    if (switchesBranch(simple.argv, { ...context, cwd })) branchSwitched = true;
  }
  verdicts.push(approvalPostVerdict(commands, command, context), graphqlMergeVerdict(commands, context), stampStoreVerdict(commands));
  return worst(verdicts);
}

// ------------------------------------------------------------ approval store

// Only the review-stamp hook writes approvals. An agent may read them, never
// write, move or delete them, nor run the code that writes them.
const STORE_READERS = new Set(['cat', 'ls', 'head', 'tail', 'jq', 'stat', 'less', 'bat', 'wc', 'file']);
const INTERPRETERS = new Set(['node', 'deno', 'bun', 'tsx', 'python', 'python3', 'ruby', 'perl', 'bash', 'sh', 'zsh']);
const STORE_WRITER_MODULES = /\b(?:stamps|review-stamp)\.mjs\b/;

function stampWrite(what) {
  return verdict('deny', `Approvals under .git/${STAMP_DIRECTORY}/ are recorded by the review-stamp hook when a reviewer subagent finishes; an agent never writes, moves or deletes them (${what}). Get an independent review instead. Standard: docs/agent-harness.md#direct-push-to-the-integration-branch`);
}

// A path segment, not a substring: `x-agent-review-stamps-y` is not the store.
const inStampStore = (token) => token.split(/[\\/]/).includes(STAMP_DIRECTORY);

function stampStoreVerdict(commands) {
  for (const { argv, redirects } of commands) {
    const head = basename(argv[0] ?? '');
    const touches = [...argv, ...redirects.map((redirect) => redirect.target)].some(inStampStore);
    if (touches && (!STORE_READERS.has(head) || redirects.some((redirect) => redirect.op.includes('>')))) return stampWrite(argv.join(' ').slice(0, 120));
    if (INTERPRETERS.has(head) && argv.slice(1).some((token) => STORE_WRITER_MODULES.test(token))) return stampWrite(argv.join(' ').slice(0, 120));
  }
  return PASS;
}

// ------------------------------------------------------------- agent journal

// The agent journal (design decision 23) is evidence the self-healing loop learns
// from; hooks and the self-healing scripts write it. An agent reads it, never
// writes, moves or deletes it, nor runs the hook code that appends to it.
const JOURNAL_READERS = new Set([...STORE_READERS, 'grep', 'rg', 'find']);
const JOURNAL_WRITER_MODULES = /\b(?:journal|healing)\.mjs\b/;
const GIT_RUNS_PROGRAM = /^(?:GIT_|PAGER|LESS|EDITOR|VISUAL)\w*/;

// The loop's own sessions draw their powers from these variables (nightly:
// L0 and the learned-rule docs push; healing: read-only; canary: muted
// journal). Only the nightly pass and the canary runner set them, as Node
// processes outside any agent session; an agent that set one would hand a
// child session the nightly powers without an issue the maintainer closed.
const LOOP_NAMES = Object.values(LOOP_ENV).join('|');
const LOOP_ENVIRONMENT = new RegExp(`^(?:${LOOP_NAMES})$`);
const DECLARES = new Set(['export', 'declare', 'typeset', 'readonly', 'local', 'env', 'set']);
// Also as code: process.env.X = '1', env['X']='1', { X: '1' }; comparisons pass.
const LOOP_ENVIRONMENT_CODE = new RegExp(`\\b(?:${LOOP_NAMES})\\b\\W{0,3}(?:(?<![=!<>])=(?!=)|:\\s*['"\`]?\\w)`);

function loopEnvironmentVerdict(commands, command) {
  const sets = commands.some(({ argv, env }) => Object.keys(env ?? {}).some((name) => LOOP_ENVIRONMENT.test(name)) || (DECLARES.has(basename(argv[0] ?? '')) && argv.slice(1).some((token) => LOOP_ENVIRONMENT.test(token.split('=')[0]))));
  if (!sets && !LOOP_ENVIRONMENT_CODE.test(command)) return PASS;
  return verdict('deny', `${Object.values(LOOP_ENV).join(', ')} are set only by the nightly pass and the canary runner, never from an agent session: they would give a child session the loop's powers. To change the loop's code, use the file edit tools. Standard: docs/agent-harness.md#self-healing-loop`);
}
// find options that delete, run a program or write a file.
const FIND_WRITES = /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

function expandHome(token, context) {
  const home = context.deps.env.HOME ?? '~';
  return token.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

// A path token only: `owner/agent-journal`, the private repository's GitHub
// name, is not the local clone.
const PATH_TOKEN = /^(?:\/|~(?:\/|$)|\$\{?HOME\}?(?:\/|$)|\.\.?(?:\/|$))/;

function touchesJournal(token, context) {
  if (!token || token.startsWith('-')) return false;
  // Inside the journal (after a cd), every operand is a journal path.
  if (context.cwd && inJournal(resolve(context.cwd), context.deps.env)) return true;
  if (PATH_TOKEN.test(token) && token.split(/[\\/]/).includes(JOURNAL_DIRECTORY)) return true;
  const expanded = expandHome(token, context);
  if (!expanded.includes('/') && !expanded.startsWith('.')) return false;
  const absolute = isAbsolute(expanded) ? expanded : resolve(context.cwd, expanded);
  return inJournal(absolute, context.deps.env);
}

// True when removing `token` recursively would remove the journal with it.
function containsJournal(token, context) {
  if (!token || token.startsWith('-')) return false;
  const absolute = resolve(context.cwd, expandHome(token, context)).replace(/(?<=.)\/+$/, '');
  const root = journalRoot(context.deps.env);
  return root === absolute || root.startsWith(`${absolute}/`);
}

function journalWrite(what) {
  return verdict('deny', `The agent journal is evidence the self-healing loop learns from: hooks and the .agents/healing scripts write it, an agent never writes, moves or deletes it (${what}). Read it, or run the self-healing script that owns the change. Standard: docs/agent-harness.md#self-healing-loop`);
}

function journalVerdict(commands, context) {
  for (const { argv, redirects, env } of commands) {
    const head = basename(argv[0] ?? '');
    const writesRedirect = redirects.some((redirect) => redirect.op.includes('>') && touchesJournal(redirect.target, context));
    const touches = argv.slice(1).some((token) => touchesJournal(token, context));
    const destructive = argv.some((token) => FIND_WRITES.test(token));
    const reads = JOURNAL_READERS.has(head) || (head === 'git' && !context.gitEnvironment && Object.keys(env ?? {}).length === 0 && journalGitRead(argv));
    if (writesRedirect || (touches && (!reads || destructive))) return journalWrite(argv.join(' ').slice(0, 120));
    // find from an ancestor of the journal reaches into it.
    if (head === 'find' && destructive && argv.slice(1).some((token) => containsJournal(token, context))) return journalWrite(argv.join(' ').slice(0, 120));
    if (REMOVERS.has(head) && argv.slice(1).some((token) => containsJournal(token, context))) return journalWrite(argv.join(' ').slice(0, 120));
    if (INTERPRETERS.has(head) && argv.slice(1).some((token) => JOURNAL_WRITER_MODULES.test(token) && /\.agents\/hooks|^(?:\.\/)?(?:journal|healing)\.mjs/.test(token))) return journalWrite(argv.join(' ').slice(0, 120));
  }
  return PASS;
}

// git subcommands and options that only read. Anything else on the journal
// counts as a write: -O, --open-files-in-pager, --output, --ext-diff or -c can
// write a file or run a program, and git accepts abbreviated long options.
const JOURNAL_GIT_READS = new Set(['log', 'show', 'diff', 'status', 'rev-parse', 'ls-files', 'blame', 'merge-base', 'rev-list', 'describe', 'shortlog']);
const JOURNAL_GIT_OPTION = /^(?:-C|--no-pager|-[nps]|-\d+|--(?:oneline|stat|name-only|name-status|porcelain|short|cached|all|graph|decorate|reverse|follow)|--(?:format|pretty|max-count|since|until|author|grep)=.*)$/;

function journalGitRead(argv) {
  const { sub } = gitSubcommand(argv);
  if (!JOURNAL_GIT_READS.has(sub)) return false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-C') index += 1;
    else if (token.startsWith('-') && !JOURNAL_GIT_OPTION.test(token)) return false;
  }
  return true;
}

// ------------------------------------------------------------ healing runs

// A self-healing run (the nightly pass sets its healing variable; the healer
// role) only reads files. The nightly pass starts the healer with the Read,
// Grep and Glob tools only; the guard backs that up by refusing every other
// call, shell included, so no option of a "read-only" command can write a
// file, run a program or reach GitHub. The pass records the candidates the
// healer returns.
function isHealingRun(context) {
  return context.deps.env[LOOP_ENV.healing] === '1' || context.input.agentType === 'healer';
}

function healingDeny(what) {
  return verdict('deny', `A self-healing run only reads files with Read, Grep and Glob and returns its candidates as JSON; it runs no command and changes nothing itself (${what}). Standard: docs/agent-harness.md#self-healing-loop`);
}

function healingVerdict(input, context) {
  if (input.kind === 'read' || input.kind === 'search') return evaluateReadOnly(input, context);
  if (input.kind === 'bash') return healingDeny(String(input.command ?? '').slice(0, 120));
  return healingDeny(`${input.kind}${input.paths?.length ? ` of ${input.paths.join(', ')}` : ''}`);
}

function evaluateReadOnly(input) {
  if (input.kind === 'read') return worst(input.paths.map((path) => envFileVerdict(path, 'read')));
  return worst([...input.paths.map((path) => envFileVerdict(path, 'search')), envGlobVerdict(input.glob ?? '', 'search')]);
}

function gitSubcommand(argv) {
  let index = 1;
  while (index < argv.length && argv[index].startsWith('-')) index += GIT_GLOBAL_WITH_VALUE.has(argv[index]) ? 2 : 1;
  return { sub: argv[index], args: argv.slice(index + 1) };
}

// True when a command changes which branch HEAD names, so a later implicit
// push on the same line would reach a branch the guard did not check.
function switchesBranch(argv, context) {
  const head = basename(argv[0] ?? '');
  if (head === 'gh') return argv[1] === 'pr' && argv[2] === 'checkout';
  if (head !== 'git') return false;
  const { sub, args } = gitSubcommand(argv);
  const positional = args.filter((token) => !token.startsWith('-'));
  if (sub === 'checkout' || sub === 'switch' || sub === 'worktree') return true;
  // `git rebase <upstream> <branch>` checks out <branch> first.
  if (sub === 'rebase') return positional.length >= 2;
  // `git symbolic-ref HEAD refs/heads/<x>` points HEAD elsewhere; with HEAD alone it only reads.
  if (sub === 'symbolic-ref') return positional[0] === 'HEAD' && (positional.length >= 2 || args.some((token) => token === '-d' || longOption(token, ['--delete'])));
  // `git branch -m <new>` renames the current branch; `-m <old> <new>` does when <old> is current.
  if (sub === 'branch' && args.some((token) => /^-[a-zA-Z]*[mM]/.test(token) || longOption(token, ['--move']))) {
    if (positional.length < 2) return true;
    const current = context.deps.currentBranch(context.cwd);
    return !current || positional[0] === current;
  }
  return false;
}

function evaluateSimple(simple, context) {
  const { argv } = simple;
  if (argv.length === 0) return fileWriteVerdict({ ...simple, argv: [''] }, context);
  const head = basename(argv[0]);
  const verdicts = [envReadVerdict(simple, context), fileWriteVerdict(simple, context), inlineCodeVerdict(simple, context)];
  if (head === 'git') verdicts.push(gitVerdict(simple, context));
  if (head === 'gh') verdicts.push(ghVerdict(simple, context));
  verdicts.push(productionVerdict(simple, context));
  return worst(verdicts);
}

// ---------------------------------------------------------------- .env files

function isEnvFile(path) {
  const name = basename(path);
  return ENV_FILE.test(name) && !ENV_TEMPLATE.test(name);
}

// A glob that matches a secret .env file. In a shell, a glob that does not
// start with a dot never matches a dotfile, so only dotted globs count there;
// a search tool's glob counts when it names env at all.
function globMatchesEnv(token, { shell }) {
  const name = basename(token);
  if (!/[*?[]/.test(name) || (shell ? !name.startsWith('.') : !name.includes('env'))) return false;
  const pattern = new RegExp(`^${name.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return ENV_SAMPLES.some((sample) => pattern.test(sample));
}

const isEnvGlob = (token) => globMatchesEnv(token, { shell: true });

function envFileVerdict(path, action) {
  if (!isEnvFile(path) && !isEnvGlob(path)) return PASS;
  return envDeny(basename(path), action);
}

function envDeny(name, action) {
  return verdict('deny', `Never ${action} ${name}: .env files hold secrets. Load a key into one command's environment instead (for example node --env-file-if-exists=.env.local ...). Standard: docs/agent-harness.md#external-action-boundaries`);
}

// The Grep tool's `glob` filter, such as `.env*` or `*.{env,local}`.
function envGlobVerdict(glob, action) {
  const hit = glob.split(/[{},\s]+/).filter(Boolean).find((pattern) => isEnvFile(pattern) || globMatchesEnv(pattern, { shell: false }));
  return hit ? envDeny(hit, action) : PASS;
}

function envReadVerdict({ argv, redirects }, context) {
  const head = basename(argv[0]);
  const reads = redirects.filter((redirect) => redirect.op.includes('<')).map((redirect) => redirect.target);
  if (PRINTERS.has(head) || (head === 'git' && ['show', 'diff', 'cat-file'].includes(argv[1]))) {
    const operands = argv.slice(1).filter((token) => !token.startsWith('-'));
    // The first operand of a search or edit tool is its pattern or script, not a file.
    reads.push(...(PATTERN_FIRST.has(head) && !argv.includes('-e') && !argv.includes('-f') ? operands.slice(1) : operands));
  }
  // Sourcing puts every key in the shell, where any later command can print it.
  if (head === 'source' || head === '.') reads.push(...argv.slice(1, 2));
  const hit = reads.find((path) => isEnvFile(path) || isEnvGlob(path));
  if (hit) return envFileVerdict(hit, head === 'source' || head === '.' ? 'source' : 'read or print');
  return recursiveSearchVerdict(argv, context);
}

// A recursive grep over the repository root reads .env.local with the rest.
// ripgrep skips it unless told to search hidden and ignored files.
function recursiveSearchVerdict(argv, context) {
  const head = basename(argv[0]);
  const flags = argv.slice(1).filter((token) => token.startsWith('-'));
  const cluster = (letter) => flags.some((flag) => /^-[a-zA-Z]+$/.test(flag) && flag.includes(letter));
  let recursive = false;
  if (['grep', 'egrep', 'fgrep'].includes(head)) recursive = cluster('r') || cluster('R') || flags.some((flag) => flag === '--recursive' || flag === '--dereference-recursive');
  if (head === 'rg' || head === 'ag') {
    const unrestricted = flags.some((flag) => /^-u{2,}$/.test(flag));
    recursive = unrestricted || ((flags.includes('--hidden') || flags.includes('-.')) && flags.includes('--no-ignore'));
  }
  if (!recursive || flags.some((flag) => /^--exclude(?:-dir)?=.*env/.test(flag))) return PASS;
  const operands = argv.slice(1).filter((token) => !token.startsWith('-'));
  const paths = head === 'rg' || head === 'ag' || !argv.includes('-e') ? operands.slice(1) : operands;
  const directories = paths.length > 0 ? paths : ['.'];
  const covers = directories.some((path) => {
    const absolute = isAbsolute(path) ? path : resolve(context.cwd, path.replace(/^~(?=\/|$)/, context.deps.env.HOME ?? '~'));
    const fromRoot = relative(absolute, context.root);
    return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
  });
  if (!covers) return PASS;
  return verdict('deny', `${argv.slice(0, 3).join(' ')} … searches the repository root recursively and reads .env.local with it. Search the directories you need (src/, docs/) or add --exclude='.env*'. Standard: docs/agent-harness.md#external-action-boundaries`);
}

// ------------------------------------ lint, test, build and TypeScript config

function relativeToRoot(path, context) {
  const absolute = isAbsolute(path) ? path : resolve(context.cwd, path);
  return relative(context.root, absolute).split('\\').join('/');
}

function isProtectedConfig(path, context) {
  const relativePath = relativeToRoot(path, context);
  return !relativePath.startsWith('..') && protectedConfigPatterns(context.config).some((pattern) => pattern.test(relativePath));
}

function configVerdict(path, context) {
  if (!isProtectedConfig(path, context)) return PASS;
  return verdict('ask', `${relativeToRoot(path, context)} is lint, test, build or TypeScript configuration. Agents never edit it to make a check pass; fix the code instead. Edit it only when the maintainer's request explicitly asks for this change, and say so. Standard: docs/agent-harness.md#external-action-boundaries`);
}

// cp, install, ln and mv: the destination, resolved inside a directory the
// way the tool does, plus every moved source.
function copyTargets(argv, context, foundPaths = false) {
  const operands = [];
  let destination;
  let targetDirectory = false;
  let asFile = false;
  let recursive = false;
  let options = true;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (options && token === '--') { options = false; continue; }
    if (options && (token === '-t' || token === '--target-directory')) {
      destination = argv[++index];
      targetDirectory = true;
    } else if (options && (token.startsWith('--target-directory=') || /^-t.+/.test(token))) {
      destination = token.startsWith('--') ? token.slice(token.indexOf('=') + 1) : token.slice(2);
      targetDirectory = true;
    } else if (options && token.startsWith('-')) {
      if (token === '--no-target-directory' || /^-[^-]*T/.test(token)) asFile = true;
      if (['--recursive', '--archive'].includes(token) || /^-[^-]*[rRa]/.test(token)) recursive = true;
      if (['-m', '-o', '-g', '-S', '--mode', '--owner', '--group', '--suffix'].includes(token)) index += 1;
    } else operands.push(token);
  }
  if (!targetDirectory) destination = operands.pop();
  const move = basename(argv[0]) === 'mv';
  const targets = move ? operands.map((path) => ({ path, whole: true })) : [];
  if (!destination) return targets;
  const expanded = destination.replace(/^~(?=\/|$)/, context.deps.env.HOME ?? '~');
  const directory = !asFile && (targetDirectory || destination.endsWith('/') || operands.length > 1 || context.deps.isDirectory?.(resolve(context.cwd, expanded)));
  if (directory) {
    targets.push(...operands.map((source) => ({ path: `${destination}/${basename(source)}`, whole: move || recursive })));
    // find supplies the discovered basename, not its starting directory's.
    if (foundPaths && operands.some((source) => basename(source).includes('{}'))) targets.push({ path: destination, whole: true });
  } else targets.push({ path: destination, whole: move || recursive });
  return targets;
}

const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const inPlaceWrite = (argv) => ['sed', 'gsed', 'perl'].includes(basename(argv[0])) && argv.some((token) => /^-[a-zA-Z]*i/.test(token) || token.startsWith('--in-place'));

// find writes through -fprint* and changes its starting points through
// -delete or an -exec action that writes, removes or runs a program.
function findTargets(argv, context) {
  const targets = [];
  let destructive = false;
  const firstExpression = argv.findIndex((token, index) => index > 0 && (token.startsWith('-') || token === '(' || token === '!'));
  const roots = argv.slice(1, firstExpression === -1 ? argv.length : firstExpression);
  for (let index = firstExpression; index > 0 && index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-delete') destructive = true;
    else if (['-fprint', '-fprint0', '-fprintf'].includes(token)) {
      targets.push({ path: argv[++index] });
      if (token === '-fprintf') index += 1;
    } else if (FIND_ACTIONS.has(token)) {
      const end = argv.findIndex((part, position) => position > index && (part === ';' || part === '+'));
      const action = argv.slice(index + 1, end < 0 ? argv.length : end);
      // Preserve argument quoting while unwrapping sudo/env and shell commands.
      const commands = parseCommands(action.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' '));
      for (const { argv: command } of commands) {
        if (COPIERS.has(basename(command[0])) || basename(command[0]) === 'mv') targets.push(...copyTargets(command, context, true));
      }
      destructive ||= commands.some(({ argv: command }) => {
        const head = basename(command[0]);
        return REMOVERS.has(head) || WRITERS.has(head) || COPIERS.has(head) || MODE_CHANGERS.has(head) || INTERPRETERS.has(head) || ['dash', 'ksh', 'fish'].includes(head) || inPlaceWrite(command);
      });
      index = end < 0 ? argv.length : end;
    }
  }
  if (destructive) targets.push(...(roots.length ? roots : ['.']).map((path) => ({ path, whole: true })));
  return targets;
}

// The files a shell command writes, removes or changes. `whole` marks the
// operands that act on a directory's contents too (`rm -r`, `mv`).
function writeTargets({ argv, redirects }, context) {
  const head = basename(argv[0]);
  const operands = argv.slice(1).filter((token) => token && !token.startsWith('-'));
  const targets = redirects.filter((redirect) => redirect.op.includes('>')).map((redirect) => ({ path: redirect.target }));
  const inPlace = inPlaceWrite(argv);
  if (head === 'mv' || COPIERS.has(head)) targets.push(...copyTargets(argv, context));
  else if (head === 'find') targets.push(...findTargets(argv, context));
  else if (REMOVERS.has(head) || MODE_CHANGERS.has(head)) targets.push(...operands.map((path) => ({ path, whole: true })));
  else if (head === 'dd') targets.push(...operands.filter((token) => token.startsWith('of=')).map((token) => ({ path: token.slice(3) })));
  else if (WRITERS.has(head) || inPlace) targets.push(...operands.map((path) => ({ path })));
  return targets;
}

function fileWriteVerdict(simple, context) {
  const what = basename(simple.argv[0]) || 'This redirect';
  return worst(writeTargets(simple, context).flatMap(({ path, whole }) => [configVerdict(path, context), harnessVerdict(path, context, what, whole)]));
}

// ------------------------------------------------------- the harness's own files

function isHarnessPath(path, context, whole = false) {
  if (!path) return false;
  const expanded = path.replace(/^~(?=\/|$)/, context.deps.env.HOME ?? '~');
  const absolute = (isAbsolute(expanded) ? expanded : resolve(context.cwd, expanded)).split('\\').join('/').replace(/(?<=.)\/+$/, '');
  if (HARNESS_FILES.some((pattern) => pattern.test(absolute))) return true;
  return whole && (absolute === context.root || HARNESS_PARENTS.test(absolute));
}

// Design decision 20: an agent never removes or weakens its own guard. Every edit,
// removal, move or restore of these files asks; Codex blocks it with a handoff.
function harnessVerdict(path, context, what, whole = false) {
  return isHarnessPath(path, context, whole) ? harnessAsk(path, what) : PASS;
}

function harnessAsk(path, what) {
  return verdict('ask', `${what} changes the harness's own enforcement (${path}): its hooks, their settings, manifest, hashes, generator or config, the reviewer role, the self-healing gate (its scripts, canary cases and admitted rules), or the git hooks. An agent never removes or weakens its own guard; change these files only when the maintainer's request asks for it, and say so. Standard: docs/agent-harness.md#external-action-boundaries`);
}

// `node -e`, `python3 -c` and the like writing a harness file.
function inlineCodeVerdict({ argv }, context) {
  if (!INTERPRETERS.has(basename(argv[0] ?? ''))) return PASS;
  const code = argv.filter((token, index) => index > 0 && INLINE_CODE_FLAGS.has(argv[index - 1])).join('\n');
  const head = basename(argv[0]);
  const call = code.match(NODE_RUNTIMES.has(head) ? NODE_WRITE_CALL : SCRIPT_WRITE_CALL);
  return call ? harnessAsk(call[0].match(HARNESS_MENTION)[0], `${head} inline code`) : PASS;
}

// `git rm`, `git mv`, and `git checkout` or `git restore` of paths rewrite
// the working tree. Unlike protected configuration, restoring a harness file
// asks too: it can bring back an older, weaker guard.
function gitPathVerdict(sub, args, context) {
  if (sub === 'restore' && args.some((token) => token === '--staged' || token === '-S') && !args.some((token) => token === '--worktree' || token === '-W')) return PASS;
  const dashes = args.indexOf('--');
  const operands = (sub === 'checkout' && dashes !== -1 ? args.slice(dashes + 1) : args).filter((token) => !token.startsWith('-'));
  return worst(operands.map((path) => harnessVerdict(path, context, `git ${sub}`, true)));
}

// Commands that rewrite working-tree files without naming them: a hard reset,
// a stash applied back, a patch or mailbox applied. When what they write
// reaches a harness file, they ask like a direct restore (design decision 20). The
// guard computes the paths with git; when it cannot, it asks. Switching
// branches, merging, rebasing, pulling and cherry-picking also rewrite files;
// they are the ordinary flow of work, shown in the pull request diff, and are
// a documented limit of the guard.
const PATCH_PATHS = /^diff --git a\/(\S+) b\/(\S+)|^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm;

function patchPaths(text) {
  const paths = new Set();
  for (const match of text.matchAll(PATCH_PATHS)) {
    for (const path of match.slice(1)) if (path && path !== '/dev/null') paths.add(path);
  }
  return [...paths];
}

function restoreAsk(what, path) {
  return verdict('ask', `${what} rewrites ${path}, one of the harness's own files, which can bring back an older, weaker guard. Confirm it with the maintainer, or restore only the files you need by name. Standard: docs/agent-harness.md#external-action-boundaries`);
}

function indirectRestoreVerdict(sub, args, simple, context) {
  const positional = args.filter((token) => !token.startsWith('-'));
  let paths;
  const what = `git ${sub}${sub === 'stash' && positional[0] ? ` ${positional[0]}` : ''}`;
  try {
    if (sub === 'reset') {
      if (!args.some((token) => ['--hard', '--merge', '--keep'].includes(token))) return PASS;
      paths = context.deps.gitLines(['diff', '--name-only', positional[0] ?? 'HEAD'], context.cwd);
    } else if (sub === 'stash') {
      if (!['apply', 'pop'].includes(positional[0])) return PASS;
      paths = context.deps.gitLines(['stash', 'show', '--name-only', '--include-untracked', positional[1] ?? 'stash@{0}'], context.cwd);
    } else {
      if (sub === 'apply' && !args.includes('--apply') && args.some((token) => ['--check', '--stat', '--numstat', '--summary'].includes(token))) return PASS;
      const files = positional.filter((token) => token !== '-');
      const fromStdin = simple.redirects.filter((redirect) => redirect.op === '<').map((redirect) => readText(context, redirect.target));
      const texts = files.length > 0 ? files.map((file) => readText(context, file)) : (fromStdin.length > 0 ? fromStdin : [simple.stdin]);
      if (texts.some((text) => !text)) return verdict('ask', `${what} reads a patch the guard cannot see, so it cannot tell whether it rewrites a harness file. Confirm it with the maintainer, or pass the patch as a file. Standard: docs/agent-harness.md#external-action-boundaries`);
      paths = texts.flatMap(patchPaths);
    }
  } catch (error) {
    return verdict('ask', `The guard could not list the files ${what} rewrites (${firstLine(error)}), so it needs the maintainer's confirmation. Standard: docs/agent-harness.md#external-action-boundaries`);
  }
  const hit = paths.find((path) => isHarnessPath(resolve(context.root, path), context));
  return hit ? restoreAsk(what, hit) : PASS;
}

// ------------------------------------------------------------------------ git

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

function gitVerdict(simple, context) {
  const { argv, env } = simple;
  let index = 1;
  let cwd = context.cwd;
  const verdicts = [];
  while (index < argv.length && argv[index].startsWith('-')) {
    const flag = argv[index];
    if (flag === '-C') cwd = resolve(cwd, argv[index + 1] ?? '.');
    if (flag === '-c' && /^core\.hookspath=/i.test(argv[index + 1] ?? '')) verdicts.push(hookBypass('-c core.hooksPath'));
    if (flag === '-c' && PUSH_ROUTING.test((argv[index + 1] ?? '').split('=')[0])) verdicts.push(pushRouting(`-c ${argv[index + 1]}`, context));
    index += GIT_GLOBAL_WITH_VALUE.has(flag) ? 2 : 1;
  }
  const sub = argv[index];
  const args = argv.slice(index + 1);
  const hooksDisabled = env.HUSKY === '0' || env.GIT_HOOKS === '0';
  if (sub === 'commit') {
    verdicts.push(commitVerdict(args));
    if (hooksDisabled) verdicts.push(hookBypass('HUSKY=0'));
  }
  if (sub === 'push') {
    verdicts.push(pushVerdict(args, { ...context, cwd }));
    if (hooksDisabled) verdicts.push(hookBypass('HUSKY=0'));
  }
  if (sub === 'add') verdicts.push(addVerdict(args));
  if (['rm', 'mv', 'checkout', 'restore'].includes(sub)) verdicts.push(gitPathVerdict(sub, args, { ...context, cwd }));
  if (['reset', 'stash', 'apply', 'am'].includes(sub)) verdicts.push(indirectRestoreVerdict(sub, args, simple, { ...context, cwd }));
  if (sub === 'config' && configWrites(args)) {
    if (args.some((token) => /^core\.hookspath$/i.test(token))) verdicts.push(hookBypass('git config core.hooksPath'));
    const key = args.find((token) => PUSH_ROUTING.test(token));
    if (key) verdicts.push(pushRouting(`git config ${key}`, context));
  }
  if (sub === 'merge' || sub === 'rebase' || sub === 'cherry-pick' || sub === 'am') {
    if (args.some((token) => longOption(token, ['--no-verify']))) verdicts.push(hookBypass('--no-verify'));
  }
  return worst(verdicts);
}

// Git accepts any unambiguous prefix of a long option (`--no-verif`,
// `--mirr`). Returns the guarded option `token` abbreviates, or null.
function longOption(token, names) {
  if (!token.startsWith('--')) return null;
  const name = token.split('=')[0];
  if (name.length < 4) return names.includes(name) ? name : null;
  return names.find((candidate) => candidate.startsWith(name)) ?? null;
}

// Config that decides where an implicit push lands.
const PUSH_ROUTING = /^(?:remote\.[^.]+\.push|push\.default|remote\.pushdefault|branch\..+\.(?:merge|pushremote)|branch\.autosetupmerge)$/i;
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list']);

function configWrites(args) {
  if (args.some((token) => CONFIG_READS.has(token))) return false;
  const positional = args.filter((token) => !token.startsWith('-'));
  const verb = ['set', 'unset'].includes(positional[0]);
  return verb || positional.length >= 2 || args.some((token) => /^--(?:unset|unset-all|add|replace-all)$/.test(token));
}

function pushRouting(what, context) {
  return verdict('deny', `${what} changes where a push lands, around the guard's checks on ${[...protectedBranches(context)].join(' and ')}. Name the destination in the push instead (git push origin <branch>). Standard: docs/agent-harness.md#direct-push-to-the-integration-branch`);
}

function hookBypass(what) {
  return verdict('deny', `Hook bypass (${what}) is never allowed. Fix what the hook reports instead; if a hook is flaky, rerun it. Standard: docs/agent-harness.md#external-action-boundaries`);
}

const COMMIT_WITH_VALUE = new Set(['-m', '-F', '-C', '-c', '-t', '--message', '--file', '--author', '--date', '--template', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--trailer', '--cleanup', '--pathspec-from-file']);

function commitVerdict(args) {
  const verdicts = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') break;
    if (COMMIT_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    const long = longOption(token, ['--no-verify', '--all']);
    if (long === '--no-verify') verdicts.push(hookBypass(`git commit ${token}`));
    if (long === '--all') verdicts.push(stageAll(`git commit ${token}`));
    if (/^-[a-zA-Z]+$/.test(token)) {
      // A value-taking short option ends the cluster; the rest is its value.
      const cluster = token.slice(1).split(/[mFCct]/)[0];
      if (cluster.includes('n')) verdicts.push(hookBypass('git commit -n'));
      if (cluster.includes('a')) verdicts.push(stageAll('git commit -a'));
      if (/[mFCct]$/.test(token)) index += 1;
    }
  }
  return worst(verdicts);
}

function stageAll(what) {
  return verdict('deny', `${what} stages every change in the worktree, including another session's work: concurrent sessions share one git index. Stage explicit paths (git add path/to/file). Standard: docs/agent-harness.md#external-action-boundaries`);
}

function addVerdict(args) {
  for (const token of args) {
    if (token === '--') continue;
    if (['-A', '-u', '.', './', ':/', ':/*', ':(top)', '*'].includes(token) || longOption(token, ['--all', '--no-ignore-removal', '--update'])) return stageAll(`git add ${token}`);
    if (/^-[a-zA-Z]+$/.test(token) && /[Au]/.test(token)) return stageAll(`git add ${token}`);
  }
  return PASS;
}

const PUSH_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec']);

function pushVerdict(args, context) {
  const verdicts = [];
  const positional = [];
  let repo;
  let force = false;
  let remove = false;
  let all = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    // --repo names the remote; every positional after it is a refspec.
    if (longOption(token, ['--repo']) === '--repo') {
      repo = token.includes('=') ? token.slice(token.indexOf('=') + 1) : args[++index];
      continue;
    }
    if (PUSH_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    const long = longOption(token, ['--no-verify', '--mirror', '--force', '--force-with-lease', '--delete', '--prune', '--all', '--branches']);
    if (long === '--no-verify') verdicts.push(hookBypass(`git push ${token}`));
    else if (long === '--mirror') {
      // --mirror force-updates and prunes every ref, the protected branches included.
      force = true;
      all = true;
    } else if (long === '--force' || long === '--force-with-lease') force = true;
    else if (long === '--delete' || long === '--prune') remove = true;
    else if (long === '--all' || long === '--branches') all = true;
    else if (/^-[a-zA-Z]+$/.test(token)) {
      if (token.includes('f')) force = true;
      if (token.includes('d')) remove = true;
    } else if (!token.startsWith('-')) positional.push(token);
  }
  const remote = repo ?? positional[0] ?? 'origin';
  const refspecs = repo === undefined ? positional.slice(1) : positional;
  const branches = protectedBranches(context);
  const integration = integrationBranch(context);
  const release = releaseBranch(context);
  // Each update as { source, destination }; a wildcard or --all reaches every branch.
  const updates = [];
  const current = () => context.deps.currentBranch(context.cwd);
  if (all) branches.forEach((branch) => updates.push({ source: null, destination: branch }));
  const implicit = refspecs.length === 0 && !all;
  if (implicit) updates.push({ source: 'HEAD', destination: current(), implicit: true });
  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) force = true;
    const bare = refspec.replace(/^\+/, '');
    if (bare.startsWith(':')) remove = true;
    const [source, target] = bare.includes(':') ? [bare.slice(0, bare.indexOf(':')), bare.slice(bare.indexOf(':') + 1)] : [bare, bare];
    const destination = target.replace(/^(?:refs\/)?heads\//, '');
    if (destination.includes('*')) branches.forEach((branch) => updates.push({ source: null, destination: branch }));
    else if (destination === 'HEAD' || destination === '@') updates.push({ source: 'HEAD', destination: current(), implicit: true });
    else updates.push({ source: source || null, destination });
  }
  // Where an implicit push lands depends on state the guard reads before the
  // line runs (the current branch) or does not model (a configured refspec).
  if (updates.some((update) => update.implicit)) {
    if (context.branchSwitched) verdicts.push(verdict('deny', 'This push has no explicit destination and follows a branch switch on the same line, so the guard cannot tell where it lands. Push in a separate command, naming the branch: git push origin <branch>. Standard: docs/agent-harness.md#direct-push-to-the-integration-branch'));
    else if (implicit && context.deps.configGet(`remote.${remote}.push`, context.cwd)) verdicts.push(verdict('ask', `remote.${remote}.push is configured, so this push may not land on the current branch. Name the destination (git push ${remote} <branch>), or confirm. Standard: docs/agent-harness.md#direct-push-to-the-integration-branch`));
  }
  const protectedUpdates = updates.filter(({ destination }) => branches.has(destination));
  if (protectedUpdates.length === 0) return worst(verdicts);
  const names = [...new Set(protectedUpdates.map(({ destination }) => destination))].join(' and ');
  if (force || remove) {
    verdicts.push(verdict('deny', `Force-pushing or deleting ${names} is never allowed. Standard: docs/agent-harness.md#external-action-boundaries`));
  } else if (protectedUpdates.some(({ destination, source }) => destination === release || source === null)) {
    verdicts.push(verdict('deny', `No agent pushes directly to ${release}, at any level: a change reaches ${release} only through the ${integration} to ${release} release pull request, which the maintainer confirms. A push that can reach every branch (--all, --mirror, a wildcard) is denied for the same reason. Standard: docs/agent-harness.md#direct-push-to-the-integration-branch`));
  } else {
    verdicts.push(...protectedUpdates.map(({ source }) => integrationPushVerdict(source, remote, context)));
  }
  return worst(verdicts);
}

const PUSH_HANDOFF = 'Otherwise push a feature branch and open a pull request, or give the maintainer the exact command and let them run it. Standard: docs/agent-harness.md#direct-push-to-the-integration-branch';

// Design decision 17: a direct push to the integration branch passes only at
// L0, for a commit that a hook-recorded independent review approved, that a
// dispatched CI run on a feature branch passed, and that the integration
// branch fast-forwards to.
function integrationPushVerdict(source, remote, context) {
  const integration = integrationBranch(context);
  const workflow = context.config.ci.workflow;
  const deny = (why) => verdict('deny', `Direct push to ${integration} denied: ${why}. A direct push to ${integration} needs L0, an independent reviewer's APPROVE recorded by the review-stamp hook for the exact commit, a green workflow_dispatch run of ${workflow} on a feature branch at that commit, and a fast-forward. ${PUSH_HANDOFF}`);
  try {
    if (levelOf(context) !== 0) return deny(`this session is at ${levelLabel(context)}`);
    // A literal commit, so nothing earlier on the line can move what is pushed.
    if (!FULL_SHA.test(source ?? '')) return deny(`name the exact reviewed commit: git push ${remote} <40-character sha>:refs/heads/${integration}`);
    const sha = context.deps.revParse(source, context.cwd);
    if (!FULL_SHA.test(sha ?? '')) return deny(`${source} does not resolve to a commit`);
    const label = sha.slice(0, 12);
    const missing = missingApproval(sha, context);
    if (missing) return deny(missing);
    const base = `refs/remotes/${remote}/${integration}`;
    if (!context.deps.revParse(base, context.cwd)) return deny(`${remote}/${integration} is unknown locally; fetch it first`);
    if (!context.deps.isAncestor(base, sha, context.cwd)) return deny(`${label} does not fast-forward ${remote}/${integration}; rebase on it, then review and run CI again`);
    // Design decision 24: a commit range that touches documentation only
    // needs the review and a clean docs check, not a dispatched CI run.
    const files = context.deps.gitLines(['diff', '--name-only', '--no-renames', `${base}..${sha}`], context.cwd);
    // A learned rule reaches the integration branch as documentation only from
    // the nightly admission, which applies an issue the maintainer closed.
    const learnedOutsideNightly = context.deps.env[LOOP_ENV.nightly] !== '1' && files.some((file) => file.startsWith('.agents/rules/learned/'));
    if (files.length > 0 && !learnedOutsideNightly && files.every(isDocumentationPath) && readByCode(files, context).length === 0) return docsPushVerdict(sha, files, context);
    // The nightly admission session may push its documentation-only commit and nothing else.
    if (context.deps.env[LOOP_ENV.nightly] === '1') return deny(`the nightly admission session pushes only documentation-only commits, and ${label} is not one`);
    const runs = JSON.parse(context.deps.gh(['run', 'list', '--workflow', workflow, '--commit', sha, '--json', 'conclusion,event,headSha,headBranch,status', '--limit', '20'], context.cwd));
    const branches = protectedBranches(context);
    const green = runs.some((run) => run.event === 'workflow_dispatch' && run.headSha === sha && run.conclusion === 'success' && !branches.has(run.headBranch));
    if (!green) return deny(`no successful workflow_dispatch run of ${workflow} on a feature branch at ${label} (dispatch one with gh workflow run ${workflow} --ref <feature-branch>, then watch it); a commit that touches documentation only needs none`);
    return PASS;
  } catch (error) {
    return deny(`the guard could not check it (${firstLine(error)})`);
  }
}

// Design decision 24: documentation, for a direct push to the integration
// branch, is Markdown and the docs/ tree, plus rules the self-healing loop
// admitted. Harness Markdown (AGENTS.md, CLAUDE.md, .agents/ rules, levels,
// roles and skills) drives agent behaviour, so it keeps the full decision-17
// path.
const NOT_DOCUMENTATION = /^(?:\.agents\/(?!rules\/learned\/)|\.claude\/|\.codex\/|\.github\/)|(?:^|\/)(?:AGENTS|CLAUDE)\.md$/;
// Only the documentation tooling that docsPushVerdict runs may read a file
// and keep it documentation. The role adapters name documentation paths as
// plain strings; they never read them.
const DOCUMENTATION_TOOLING = ['docs/', '*.md', '.agents/check.mjs', '.claude/agents/', '.codex/agents/'];

// The tooling paths, plus the script the config's docs check runs (an
// operand of its argv that names a file).
function documentationTooling(config) {
  const scripts = (Array.isArray(config.docsCheck) ? config.docsCheck : []).filter((token, index) => typeof token === 'string' && !token.startsWith('-') && (index > 0 || token.includes('/')) && /[/\\]|\.\w+$/.test(token));
  return [...DOCUMENTATION_TOOLING, ...scripts.map((script) => script.replace(/^\.\//, ''))];
}

// The code, tests, workflows and scripts that name one of `files`. A file a
// check or a test reads can break a required CI job, so it is not
// documentation for design decision 24. A lookup that fails counts as a
// reader. The admission files are exempt: the loop's review script writes
// them and names the records index, and the anchor loads the learned rules by
// design.
function readByCode(files, context) {
  const admission = admissionFiles(context.config);
  const looked = files.filter((file) => !admission.test(file));
  if (looked.length === 0) return [];
  try {
    return context.deps.codeReferences(looked, documentationTooling(context.config), context.cwd);
  } catch {
    return ['(lookup failed)'];
  }
}

export function isDocumentationPath(path) {
  return !NOT_DOCUMENTATION.test(path) && (path.startsWith('docs/') || /\.md$/i.test(path));
}

// Design decision 24's clean docs check: a finding blocks when it names a
// pushed file. Findings the push did not cause (other files, audit dates that
// expire with time) stay advisory.
export function blockingDocFindings(findings, files) {
  return findings.filter((finding) => files.some((file) => finding.startsWith(`${file}:`)) && !/content audit expired/.test(finding));
}

// The files the nightly admission session may push (design decision 5
// records, in the config's records directory, and the learned rules the
// maintainer admitted).
export function admissionFiles(config) {
  const records = String(config.recordsDirectory ?? 'docs/records').replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:\\.agents/rules/learned/[^/]+\\.md|${records}/\\d{4}-\\d{2}-\\d{2}-assessment-self-healing-decisions\\.md|${records}/index\\.md)$`);
}

function docsPushVerdict(sha, files, context) {
  const label = sha.slice(0, 12);
  const integration = integrationBranch(context);
  const argv = Array.isArray(context.config.docsCheck) && context.config.docsCheck.length > 0 ? context.config.docsCheck : null;
  const deny = (why) => verdict('deny', `Direct docs-only push to ${integration} denied: ${why}. A commit that touches documentation only reaches ${integration} at L0 with an independent reviewer's APPROVE recorded for the exact commit, a fast-forward${argv ? ' and no docs check finding on the pushed files' : ''}, without a dispatched CI run (design decision 24). ${PUSH_HANDOFF}`);
  const admission = admissionFiles(context.config);
  const outside = context.deps.env[LOOP_ENV.nightly] === '1' ? files.filter((file) => !admission.test(file)) : [];
  if (outside.length > 0) return deny(`the nightly admission session may push only learned rules and self-healing decision records, not ${outside.slice(0, 3).join(', ')}`);
  if (context.deps.revParse('HEAD', context.cwd) !== sha) return deny(`check out ${label} first, so the guard can check it`);
  if (context.deps.gitLines(['status', '--porcelain', '--untracked-files=no'], context.cwd).length > 0) return deny('the working tree has uncommitted changes, so the guard would not read the pushed commit');
  // No docs check configured: the review and the fast-forward are the proof.
  if (!argv) return PASS;
  let findings;
  try {
    findings = context.deps.checkDocs(context.cwd, argv);
  } catch (error) {
    return deny(`the docs check (${argv.join(' ')}) could not run on ${label} (${firstLine(error)})`);
  }
  const blocking = blockingDocFindings(findings, files);
  if (blocking.length > 0) return deny(`the docs check reports ${blocking.length} finding(s) on the pushed files: ${blocking.slice(0, 3).join('; ')}`);
  return PASS;
}

// Design decision 19: an L0 merge or direct push needs the review-stamp
// hook's APPROVE for the commit, from a reviewer subagent this session
// spawned in this worktree. Returns why it is missing, or null.
function missingApproval(sha, context) {
  const label = sha.slice(0, 12);
  const review = context.deps.review(sha, context.cwd);
  if (!review) return `no recorded independent review approves ${label} in this worktree`;
  if (review.verdict !== 'APPROVE') return `the latest recorded review of ${label} requests changes`;
  if (!context.input.sessionId || review.sessionId !== context.input.sessionId) return `the recorded approval of ${label} comes from another session's reviewer`;
  return null;
}

// ---------------------------------------------------------------------- level

function levelOf(context) {
  // The nightly admission session is L0 by construction: it records decisions
  // the maintainer took, and the guard confines it to those files. Reading its
  // level from the transcript let a rule title such as announce-l2-... block it.
  if (context.deps.env[LOOP_ENV.nightly] === '1') return 0;
  if (context.level === undefined) context.level = effectiveLevel(context.deps.transcript(context.input.transcriptPath));
  return context.level;
}

function levelLabel(context) {
  const level = levelOf(context);
  return level === null ? 'no announced level (treated as L2)' : `L${level}`;
}

// ----------------------------------------------------------------- production

function productionAsk(command, effect) {
  return verdict('ask', `Production confirmation: ${command} (${effect}). It needs the maintainer's explicit approval every time, at every level. State the exact command and its effect before running it. Standard: docs/agent-harness.md#production-confirmations`);
}

// `--flag=value` counts as the two words `--flag value`.
function commandWords(argv) {
  return argv.flatMap((token) => (/^--[^=]+=/.test(token) ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token]));
}

// True when `tokens` holds the configured `words`: a word starting with `-`
// anywhere, every other word in order. With `pairValues`, a word right after
// a flag in the config is that flag's value and must follow it directly, so
// `kubectl --context production apply` also matches `kubectl apply --context
// production`.
function wordsMatch(words, tokens, pairValues) {
  const used = new Set();
  const ordered = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word.startsWith('-')) {
      ordered.push(word);
      continue;
    }
    const value = pairValues && words[index + 1] && !words[index + 1].startsWith('-') ? words[index + 1] : null;
    const at = tokens.findIndex((token, position) => token === word && !used.has(position) && (value === null || tokens[position + 1] === value));
    if (at === -1) return false;
    used.add(at);
    if (value !== null) {
      used.add(at + 1);
      index += 1;
    }
  }
  let cursor = 0;
  for (const word of ordered) {
    while (cursor < tokens.length && (used.has(cursor) || tokens[cursor] !== word)) cursor += 1;
    if (cursor === tokens.length) return false;
    cursor += 1;
  }
  return true;
}

/** True when the simple command `argv` is the configured production `command`. */
export function matchesProductionCommand(argv, command) {
  const [program, ...words] = command.trim().split(/\s+/);
  if (!program || basename(argv[0] ?? '') !== basename(program)) return false;
  const tokens = commandWords(argv.slice(1));
  return wordsMatch(words, tokens, false) || wordsMatch(words, tokens, true);
}

// The config's production commands ask every time, at every level
// (docs/agent-harness.md#production-confirmations).
function productionVerdict({ argv }, context) {
  const entry = productionEntries(context.config).find((candidate) => matchesProductionCommand(argv, candidate.command));
  return entry ? productionAsk(entry.command.trim(), entry.effect ?? 'a production change') : PASS;
}

// ------------------------------------------------------------------------- gh

const GH_MERGE_WITH_VALUE = new Set(['-t', '--subject', '-b', '--body', '-F', '--body-file', '--match-head-commit', '-A', '--author-email', '-R', '--repo']);
const API_MERGE_ASK = 'Merging a pull request through gh api skips the guard\'s L0 checks. Use gh pr merge, or confirm this call. Standard: docs/agent-harness.md#independent-review';

// The maintainer decides a self-healing candidate by closing its issue
// (design decision 23): completed admits it, not planned rejects it. Every
// agent acts as the maintainer on GitHub, so an agent that closes, reopens or
// relabels such an issue asks.
const ISSUE_STATE_CHANGES = new Set(['close', 'reopen', 'edit', 'delete', 'transfer']);

function issueDecisionVerdict(argv, context) {
  const number = argv.slice(3).find((token) => /^#?\d+$/.test(token) || /\/issues\/\d+$/.test(token));
  const ask = (why) => verdict('ask', `gh issue ${argv[2]} ${number ?? ''} ${why}: the maintainer decides self-healing candidates by closing their issue. Confirm with them first. Standard: docs/agent-harness.md#self-healing-loop`);
  if (!number) return PASS;
  try {
    const labels = JSON.parse(context.deps.gh(['issue', 'view', number.replace(/^#/, ''), '--json', 'labels'], context.cwd)).labels ?? [];
    return labels.some((label) => /^self-healing(?::|$)/.test(label.name ?? '')) ? ask('changes a self-healing decision issue') : PASS;
  } catch (error) {
    return ask(`could not be checked (${firstLine(error)}) and may change a self-healing decision issue`);
  }
}

function ghVerdict({ argv }, context) {
  if (argv[1] === 'pr' && argv[2] === 'merge') return mergeVerdict(argv.slice(3), context);
  if (argv[1] === 'issue' && ISSUE_STATE_CHANGES.has(argv[2])) return issueDecisionVerdict(argv, context);
  if (argv[1] === 'api') {
    let method = '';
    argv.forEach((token, index) => {
      if (['-X', '--method'].includes(argv[index - 1])) method = token;
      else if (/^-X./.test(token)) method = token.slice(2);
      else if (token.startsWith('--method=')) method = token.slice('--method='.length);
    });
    if (argv.some((token) => /pulls\/\d+\/merge\b/.test(token)) && method.toUpperCase() === 'PUT') return verdict('ask', API_MERGE_ASK);
    // Without -X, gh api posts as soon as it sends a field.
    const sendsFields = argv.some((token) => /^(?:-[fF]|--field|--raw-field|--input)(?:=|$)/.test(token));
    const writes = method ? method.toUpperCase() !== 'GET' : sendsFields;
    if (writes && argv.some((token) => /(?:^|\/)(?:git\/refs|merges|contents)(?:\/|$)/.test(token))) {
      return verdict('ask', 'This gh api call writes a branch, a merge or a file on GitHub directly, around the guard\'s push and merge checks. Push or merge through git and gh pr, or confirm this call. Standard: docs/agent-harness.md#direct-push-to-the-integration-branch');
    }
  }
  return PASS;
}

// GraphQL mutations that merge or arm auto-merge, inline or from a file.
function graphqlMergeVerdict(commands, context) {
  const calls = commands.filter(({ argv }) => basename(argv[0] ?? '') === 'gh' && argv[1] === 'api' && argv.includes('graphql'));
  if (calls.length === 0) return PASS;
  const texts = calls.flatMap(({ argv, stdin }) => [...argv, stdin, ...referencedFiles(argv).map((file) => readText(context, file) ?? '')]);
  return texts.some((text) => /\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch|updateRefs?|createCommitOnBranch)\b/.test(text ?? '')) ? verdict('ask', API_MERGE_ASK) : PASS;
}

function mergeVerdict(args, context) {
  const positional = [];
  let matchHead = null;
  let repo = null;
  let auto = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--admin') return verdict('deny', 'gh pr merge --admin bypasses branch protection and is never allowed. Standard: docs/agent-harness.md#external-action-boundaries');
    if (token === '--auto') auto = true;
    if (token.startsWith('--match-head-commit=')) matchHead = token.split('=')[1];
    else if (token.startsWith('--repo=')) repo = token.split('=')[1];
    else if (GH_MERGE_WITH_VALUE.has(token)) {
      if (token === '--match-head-commit') matchHead = args[index + 1];
      if (token === '-R' || token === '--repo') repo = args[index + 1];
      index += 1;
    } else if (!token.startsWith('-')) positional.push(token);
  }

  try {
    const view = ['pr', 'view', ...positional.slice(0, 1), ...(repo ? ['--repo', repo] : []), '--json', 'number,baseRefName,headRefOid,isDraft,mergeStateStatus,comments,reviews'];
    const pull = JSON.parse(context.deps.gh(view, context.cwd));
    return mergeConditions(pull, { matchHead, auto }, context);
  } catch (error) {
    return verdict('ask', `Could not verify this merge (${firstLine(error)}), so it needs the maintainer's confirmation. Standard: docs/agent-harness.md#independent-review`);
  }
}

// Design decision 22: the grant is a line of its own in the maintainer's first message of
// the session, reading `auto-merge ok`, `auto-merge allowed` or
// `auto-merge autorisé`, and nothing else. A sentence that mentions
// auto-merge, a question, a negation, a later message and pasted text never
// grant it.
export const AUTO_MERGE_GRANT_PHRASE = 'auto-merge allowed';
const AUTO_MERGE_GRANT = /^[ \t]*auto[-\u2010\u2011\u2013]merge[ \t]+(?:ok|allowed|autoris[ée]e?)[ \t]*[.!]?[ \t]*$/im;
const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g;

export function grantsAutoMerge(text) {
  return AUTO_MERGE_GRANT.test(String(text ?? '').replace(PASTED, ' '));
}

function autoMergeGranted(context) {
  const first = context.deps.transcript(context.input.transcriptPath).find((message) => message.role === 'user');
  return Boolean(first) && grantsAutoMerge(first.text);
}

function mergeConditions(pull, { matchHead, auto }, context) {
  const label = `PR #${pull.number}`;
  const integration = integrationBranch(context);
  const release = releaseBranch(context);
  if (pull.baseRefName === release) return productionAsk(`gh pr merge into ${release} (${label})`, 'the release merge deploys production');
  if (pull.baseRefName !== integration) return verdict('ask', `${label} targets ${pull.baseRefName}, not ${integration}; only merges into ${integration} can pass without the maintainer.`);
  if (!FULL_SHA.test(pull.headRefOid ?? '')) throw new Error(`${label} has no readable head commit`);

  const level = levelOf(context);
  if (level !== 0) return verdict('ask', `${label}: this session is at ${levelLabel(context)}. L1 and L2 never merge; the maintainer merges. Standard: docs/agent-harness.md#difficulty-levels`);

  const approval = latestReview(pull.comments ?? [], pull.reviews ?? []);
  if (!approval) return verdict('ask', `${label} has no independent review comment ("Independent review: APPROVE <head sha>"). Run the pre-merge review from a fresh session first. Standard: docs/agent-harness.md#independent-review`);
  if (approval.verdict !== 'APPROVE') return verdict('ask', `${label}: the latest independent review requests changes (${approval.sha.slice(0, 12)}). Fix, then get a new review of the fix.`);
  if (approval.sha !== pull.headRefOid) return verdict('ask', `${label}: the approval covers ${approval.sha.slice(0, 12)} but the head is now ${pull.headRefOid.slice(0, 12)}. A commit pushed after the review needs a new review.`);
  // The same proof as a direct push: the review-stamp hook recorded a reviewer
  // subagent's APPROVE for this head. The comment alone can be posted by anyone.
  const missing = missingApproval(pull.headRefOid, context);
  if (missing) return verdict('ask', `${label}: ${missing}. Run the review with a reviewer subagent from this session. Standard: docs/agent-harness.md#independent-review`);
  if (pull.isDraft) return verdict('ask', `${label} is still a draft.`);
  if (auto) {
    // Design decision 22: GitHub then waits for the required checks on the pinned commit.
    if (!autoMergeGranted(context)) return verdict('ask', `${label}: an agent arms auto-merge only when the maintainer's opening instruction for the task grants it with a line of its own reading "${AUTO_MERGE_GRANT_PHRASE}". Otherwise wait for green checks, then merge with --match-head-commit ${pull.headRefOid}. Standard: docs/agent-harness.md#independent-review`);
  } else if (pull.mergeStateStatus !== 'CLEAN') return verdict('ask', `${label} is not mergeable yet (mergeStateStatus ${pull.mergeStateStatus}); required checks must be green and the branch up to date.`);
  if (!matchHead) return verdict('deny', `Add --match-head-commit ${pull.headRefOid} so GitHub refuses the merge if the head moves after this check.`);
  if (matchHead !== pull.headRefOid) return verdict('deny', `--match-head-commit ${matchHead} does not match the head ${pull.headRefOid} of ${label}.`);
  return PASS;
}

// The latest verdict across pull request comments and reviews, by time. A
// comment or review counts when its first line is a verdict line; a review
// submitted as "changes requested" counts as REQUEST_CHANGES on its commit.
// A newer REQUEST_CHANGES cancels an older APPROVE.
export function latestReview(comments, reviews = []) {
  const entries = [
    ...comments.map((comment) => ({ body: comment.body, at: comment.createdAt })),
    ...reviews.map((review) => ({ body: review.body, at: review.submittedAt, state: review.state, commit: review.commit?.oid })),
  ];
  const verdicts = entries
    .map((entry) => {
      const match = APPROVAL_LINE.exec(String(entry.body ?? '').trimStart().split('\n')[0]);
      if (match) return { at: entry.at, verdict: match[1], sha: match[2] };
      if (entry.state === 'CHANGES_REQUESTED') return { at: entry.at, verdict: 'REQUEST_CHANGES', sha: String(entry.commit ?? 'unknown') };
      return null;
    })
    .filter(Boolean)
    .sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const last = verdicts.at(-1);
  return last ? { verdict: last.verdict, sha: last.sha } : null;
}

// Only a reviewer-role subagent may publish an approval. This is a tripwire:
// every agent shares the maintainer's gh identity, so it proves no identity.
const BODY_FILE_FLAGS = new Set(['-F', '--body-file', '--input', '--field', '-f', '--raw-field']);

function isPosting(argv) {
  if (basename(argv[0] ?? '') !== 'gh') return false;
  if (argv[1] === 'pr') return ['comment', 'review', 'create', 'edit'].includes(argv[2]);
  if (argv[1] === 'issue') return argv[2] === 'comment';
  return argv[1] === 'api';
}

// Files a gh command reads its body or fields from: --body-file f, -F body=@f.
function referencedFiles(argv) {
  return argv.flatMap((token, index) => {
    const field = /^(?:--?[a-z-]+=)?[\w.-]+=@(.+)$/.exec(token)?.[1];
    if (field) return [field];
    if (/^(?:--body-file|--input)=(.+)$/.test(token)) return [token.slice(token.indexOf('=') + 1)];
    if (['--body-file', '--input'].includes(argv[index - 1]) || (argv[index - 1] === '-F' && argv[1] !== 'api')) return [token];
    return [];
  }).filter((file) => file !== '-');
}

function approvalPostVerdict(commands, rawText, context) {
  const posting = commands.filter(({ argv }) => isPosting(argv));
  if (posting.length === 0) return PASS;
  // A body can also come from a file read elsewhere on the line: $(cat f),
  // `-F - < f`, or `cat f | gh pr comment -F -`.
  const readElsewhere = commands.flatMap(({ argv, redirects }) => [
    ...redirects.filter((redirect) => redirect.op.includes('<')).map((redirect) => redirect.target),
    ...(FILE_READERS.has(basename(argv[0] ?? '')) ? argv.slice(1).filter((token) => !token.startsWith('-')) : []),
  ]);
  const fromStdin = posting.some(({ argv }) => argv.some((token, index) => token === '-' && BODY_FILE_FLAGS.has(argv[index - 1])));
  const bodies = [
    ...(fromStdin ? [rawText] : []),
    ...posting.flatMap(({ argv, stdin }) => [
      ...argv.map((token) => token.replace(/^--?[a-z-]+=|^body=/, '')),
      stdin,
      ...referencedFiles(argv).map((file) => readText(context, file) ?? ''),
    ]),
    ...readElsewhere.map((file) => readText(context, file) ?? ''),
  ];
  if (!bodies.some((body) => APPROVAL_MARKER.test(body ?? ''))) return PASS;
  if (context.input.agentType === 'reviewer') return PASS;
  return verdict('deny', 'Only a reviewer subagent started from a fresh session may publish "Independent review: APPROVE". The author never approves its own work. Standard: docs/agent-harness.md#independent-review');
}

// ------------------------------------------------------------------------ CLI

// A stable key for the protection that fired: the standard section it cites
// and the first words of its reason, without paths, numbers or quotes. The
// nightly pass counts events per key to spot a protection that keeps blocking.
export function guardRule(reason) {
  const anchor = /Standard: docs\/[\w./-]+#([\w-]+)/.exec(reason)?.[1] ?? 'unknown';
  // Drop a quoted command before the ellipsis and keep plain words only, so two
  // commands the same protection stops share a key.
  const head = reason.replace(/^.*? … /, '').split(/[.:(]/)[0].replace(/`[^`]*`|"[^"]*"/g, ' ').split(/\s+/).filter((word) => /^[A-Za-z][a-z']*$/.test(word)).join(' ').toLowerCase().split(' ').slice(0, 8).join(' ');
  return `${anchor}: ${head}`;
}

export function guardEvent(input, result) {
  return {
    kind: 'guard',
    decision: result.decision,
    rule: guardRule(result.reason ?? ''),
    reason: truncate(result.reason ?? '', 300),
    command: truncate(input.command ?? '', 300),
    paths: (input.paths ?? []).slice(0, 5),
    sessionId: input.sessionId,
    tool: input.tool,
    agentType: input.agentType,
    cwd: input.cwd,
  };
}

if (isEntrypoint(import.meta.url)) {
  const tool = toolFromArgv();
  let result = PASS;
  let input = null;
  try {
    input = normalize(readStdin(), tool);
    if (input.event === 'PreToolUse' || input.event === '') result = evaluate(input);
  } catch (error) {
    process.stderr.write(`agent guard error: ${error?.stack ?? error}\n`);
    result = nightlyVerdict(fallbackVerdict(input, error), process.env);
  }
  respondPreToolUse(tool, result);
  if (input && (result.decision === 'ask' || result.decision === 'deny') && !journalMuted()) {
    try {
      appendRecord('events', guardEvent(input, result));
    } catch {
      // The journal is evidence, never a gate.
    }
  }
}
