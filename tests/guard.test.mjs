// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../harness/hooks/config.mjs';
import { admissionFiles, blockingDocFindings, defaultDeps, evaluate, fallbackVerdict, grantsAutoMerge, guardEvent, guardRule, isDocumentationPath, latestReview, matchesProductionCommand, nightlyVerdict } from '../harness/hooks/guard.mjs';
import { normalize } from '../harness/hooks/lib.mjs';
import { parseCommands } from '../harness/hooks/shell.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const guardScript = path.join(repoRoot, 'harness/hooks/guard.mjs');
const fixtures = path.join(import.meta.dirname, 'fixtures', 'agent-hooks');
const fixture = (name) => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const SESSION = '00000000-0000-4000-8000-00000000000a';

const L0 = [{ role: 'assistant', text: 'Level L0: one-word fix.' }];
const L1 = [{ role: 'assistant', text: 'Level L1: one script.' }];

// The production commands of a sample repository.
const PRODUCTION = [
  { command: 'deploy-cli deploy --prod', effect: 'deploys production' },
  { command: 'terraform apply', effect: 'changes production infrastructure' },
  { command: 'kubectl --context production apply', effect: 'changes the production cluster' },
  { command: 'db-cli migrate --remote', effect: 'migrates the production database' },
];
const CONFIG = { ...DEFAULT_CONFIG, productionCommands: PRODUCTION, docsCheck: ['node', 'scripts/check-docs.mjs', '--strict'] };

const GREEN_RUN = { event: 'workflow_dispatch', headSha: HEAD, headBranch: 'feature/x', conclusion: 'success', status: 'completed' };
const REFS = { HEAD, [HEAD]: HEAD, dev: HEAD, 'feature/x': HEAD, 'refs/remotes/origin/dev': OLD };

function deps({ transcript = L1, pull, ghError, files = {}, branch = 'feature/x', env = {}, reviews = {}, runs = [GREEN_RUN], refs = REFS, ancestor = true, gitConfig = {}, settings = {}, diff = ['src/app.ts'], status = [], lines = {}, docFindings = [], issue = { labels: [] }, readers = [] } = {}) {
  const calls = [];
  return {
    calls,
    env,
    repoRoot: () => '/repo',
    config: () => {
      if (settings instanceof Error) throw settings;
      return { ...CONFIG, ...settings };
    },
    currentBranch: () => branch,
    readFile: (file) => {
      if (files[file] instanceof Error) throw files[file];
      return files[file] ?? null;
    },
    gh: (args) => {
      calls.push(args);
      if (ghError) throw new Error(ghError);
      if (args[0] === 'issue') return JSON.stringify(issue);
      return JSON.stringify(args[0] === 'run' ? runs : pull);
    },
    gitLines: (args) => {
      calls.push(['git', ...args]);
      const key = args.join(' ');
      if (lines[key] instanceof Error) throw lines[key];
      if (lines[key]) return lines[key];
      if (args[0] === 'diff' && args.includes('--no-renames')) return diff;
      if (args[0] === 'status') return status;
      return [];
    },
    checkDocs: (cwd, argv) => {
      calls.push(['checkDocs', ...argv]);
      if (docFindings instanceof Error) throw docFindings;
      return docFindings;
    },
    codeReferences: (paths, excluded) => {
      calls.push(['codeReferences', ...excluded]);
      if (readers instanceof Error) throw readers;
      return readers;
    },
    revParse: (ref) => refs[ref] ?? '',
    isAncestor: () => {
      if (ancestor instanceof Error) throw ancestor;
      return ancestor;
    },
    review: (sha) => reviews[sha] ?? null,
    configGet: (key) => gitConfig[key] ?? '',
    transcript: () => transcript,
  };
}

// A repository directory with its own harness config, for the CLI.
function configuredRepository(config = { productionCommands: PRODUCTION }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-guard-repo-'));
  mkdirSync(path.join(directory, '.agents'));
  writeFileSync(path.join(directory, '.agents/harness.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return directory;
}

const bash = (command, extra = {}) => ({ ...normalize({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/repo', session_id: SESSION }, 'claude'), ...extra });
const decide = (command, options, extra) => evaluate(bash(command, extra), deps(options)).decision;

// The guard CLI records each ask and deny in the agent journal; a test run
// writes to its own temporary journal, never to the real one.
function isolatedJournal() {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-guard-journal-'));
  return { directory, env: { ...process.env, HARNESS_JOURNAL_DIR: directory } };
}

const APPROVED = { sha: HEAD, verdict: 'APPROVE', agentId: 'a1', sessionId: SESSION, at: '2026-09-27T10:00:00Z' };
const approval = (verdict, sha, createdAt = '2026-09-27T10:00:00Z') => ({ body: `Independent review: ${verdict} ${sha}\nReviewer session: s2`, createdAt });
const pull = (overrides = {}) => ({ number: 7, baseRefName: 'dev', headRefOid: HEAD, isDraft: false, mergeStateStatus: 'CLEAN', comments: [approval('APPROVE', HEAD)], ...overrides });

describe('copy, move and find destinations', () => {
  it.each([
    'cp /tmp/settings.json .claude/',
    'mv /tmp/settings.json .claude/',
    'install -m 600 /tmp/settings.json .claude/',
    'ln -s /tmp/settings.json .claude/',
    'cp /tmp/a /tmp/settings.json .claude',
    'cp -t .claude /tmp/settings.json',
    'mv --target-directory=.claude /tmp/settings.json',
    'cp -r /tmp/dir/. .claude/',
    'cp -aT /tmp/dir .claude',
    'mv /tmp/.agents .',
    'find .agents/hooks -type f -delete',
    'find . -type f -delete',
    'find .claude -exec rm {} \\;',
    'find .claude -execdir chmod 600 {} +',
    'find .codex -ok cp /tmp/hooks.json {} \\;',
    'find .claude -okdir sed -i s/a/b/ {} \\;',
    'find .agents -exec python3 edit.py {} \\;',
    'find .claude -exec sh -c "touch ignored" \\;',
    'find src -fprint .claude/settings.json',
    'find src -fprint0 .codex/hooks.json',
    'find src -fprintf .claude/settings.json %p',
    'find src -name settings.json -exec cp {} .claude/ \\;',
    'find src -name hooks.json -exec mv -t .codex {} +',
  ])('asks for %s', (command) => {
    expect(decide(command)).toBe('ask');
  });

  it('resolves an existing destination directory without a trailing slash', () => {
    const injected = { ...deps(), isDirectory: (file) => file === '/repo/.claude' };
    expect(evaluate(bash('cp /tmp/settings.json .claude'), injected).decision).toBe('ask');
    expect(evaluate(bash('cp -T /tmp/settings.json .claude'), injected).decision).toBe('pass');
  });

  it.each([
    'cp /tmp/readme.md docs/', 'cp -T /tmp/a src/file',
    'mv src/a src/b', 'find src -delete',
    'find . -exec grep needle {} \\;', 'find . -exec sed -n 1p {} +',
    'find . -print', 'find . -fprint /tmp/files',
    'find src -exec cp {} docs/ \\;',
  ])('preserves harmless control: %s', (command) => expect(decide(command)).toBe('pass'));

  it('keeps the escaped find terminator in its argv', () => {
    expect(parseCommands('find . -exec rm {} \\;')[0].argv).toEqual(['find', '.', '-exec', 'rm', '{}', ';']);
  });
});

describe('push option equivalence', () => {
  it.each(['--repo origin', '--repo=origin', '--rep origin', '--signed origin', '--signed=true origin'])(
    'checks every refspec after %s', (option) => {
      for (const refspec of ['HEAD:main', 'HEAD:dev', 'HEAD:feature/x', '+HEAD:main', ':main', '+HEAD:dev', ':dev', '--delete main']) {
        expect(decide(`git push ${option} ${refspec}`), refspec).toBe(decide(`git push origin ${refspec}`));
      }
      const reviewed = { transcript: L0, reviews: { [HEAD]: APPROVED } };
      expect(decide(`git push ${option} ${HEAD}:dev`, reviewed)).toBe('pass');
    },
  );

  it('denies --repo pushes to a configured release branch', () => {
    const settings = { branches: { integration: 'develop', release: 'production' } };
    const refs = { ...REFS, develop: HEAD, 'refs/remotes/origin/develop': OLD };
    const options = { transcript: L0, reviews: { [HEAD]: APPROVED }, settings, refs };
    expect(decide('git push origin HEAD:production', options)).toBe('deny');
    for (const option of ['--repo origin', '--repo=origin', '--rep origin']) {
      expect(decide(`git push ${option} HEAD:production`, options), option).toBe('deny');
      expect(decide(`git push ${option} +HEAD:develop`, options), option).toBe('deny');
      expect(decide(`git push ${option} ${HEAD}:refs/heads/develop`, options), option).toBe('pass');
    }
  });
});

describe('shell parsing', () => {
  it('splits compound commands, unwraps wrappers and shells, and keeps heredoc bodies as data', () => {
    const commands = parseCommands(`cd /x && FOO=1 rtk git push -f origin dev; bash -lc 'git commit -n -m hi'\ncat > f.md <<'EOF'\ngit add -A\nEOF`);
    expect(commands.map((command) => command.argv.join(' '))).toEqual([
      'cd /x',
      'git push -f origin dev',
      "bash -lc git commit -n -m hi",
      'git commit -n -m hi',
      'cat',
    ]);
    expect(commands.at(-1).stdin).toBe('git add -A');
    expect(commands.at(-1).redirects).toEqual([{ op: '>', target: 'f.md' }]);
  });

  it('parses command substitutions as commands of their own', () => {
    expect(parseCommands('echo "$(cat .env.local)"').map((command) => command.argv[0])).toEqual(['echo', 'cat']);
  });
});

describe('never list', () => {
  it.each([
    'git commit --no-verify -m x',
    'git commit -nm "x"',
    'git -c core.hooksPath=/dev/null commit -m x',
    'HUSKY=0 git commit -m x',
    'git push --no-verify origin feature/x',
    'git config core.hooksPath /tmp/none',
  ])('blocks the hook bypass %s', (command) => {
    expect(decide(command)).toBe('deny');
  });

  it.each(['git add -A', 'git add .', 'git add --all', 'git -C sub add ./', 'git add :/', 'git add -u', 'git add --update', 'git commit -am "x"', 'git commit --all -m x'])('blocks staging everything: %s', (command) => {
    expect(decide(command)).toBe('deny');
  });

  it.each(['git add src/a.ts docs/b.md', 'git commit -m "git add -A is forbidden"', 'git commit -F msg.txt', 'git push -u origin feature/x'])('lets explicit staging and ordinary commits through: %s', (command) => {
    expect(decide(command)).toBe('pass');
  });

  it.each(['git push -f origin dev', 'git push --force-with-lease origin main', 'git push origin +dev', 'git push origin :main', 'git push --delete origin dev', 'git push origin HEAD:refs/heads/main --force'])('blocks force push and deletion of protected branches: %s', (command) => {
    expect(decide(command)).toBe('deny');
  });

  it('blocks a bare force push while on dev, and allows it on a feature branch', () => {
    expect(decide('git push --force', { branch: 'dev' })).toBe('deny');
    expect(decide('git push --force', { branch: 'feature/x' })).toBe('pass');
  });

  it.each([
    ['git push origin main', 'feature/x'],
    ['git push origin HEAD:refs/heads/main', 'feature/x'],
    ['git push origin HEAD', 'main'],
    ['git push', 'main'],
    ['git push --all origin', 'feature/x'],
    ['git push --mirror origin', 'feature/x'],
    ["git push origin 'refs/heads/*:refs/heads/*'", 'feature/x'],
  ])('denies every direct push to main, even at L0 with every proof: %s on %s', (command, branch) => {
    const result = evaluate(bash(command), deps({ transcript: L0, branch, reviews: { [HEAD]: APPROVED } }));
    expect(result.decision).toBe('deny');
  });

  it('lets a feature branch push through', () => {
    expect(decide('git push -u origin feature/x', { transcript: L0 })).toBe('pass');
    expect(decide('git push', { branch: 'feature/x' })).toBe('pass');
  });
});

describe('direct push to dev (decision 17)', () => {
  const push = (command = `git push origin ${HEAD}:refs/heads/dev`, options = {}) => evaluate(bash(command), deps({ transcript: L0, reviews: { [HEAD]: APPROVED }, ...options }));

  it.each([`git push origin ${HEAD}:refs/heads/dev`, `git push origin ${HEAD}:dev`])('passes at L0 with a recorded approval, a green dispatched CI run and a fast-forward: %s', (command) => {
    expect(push(command).decision).toBe('pass');
  });

  it.each([
    ['git push origin HEAD:dev', 'feature/x'],
    ['git push origin dev', 'feature/x'],
    ['git push origin feature/x:refs/heads/dev', 'feature/x'],
    ['git push', 'dev'],
    ['git push origin HEAD', 'dev'],
    [`git commit --amend --no-edit && git push origin HEAD:dev`, 'feature/x'],
  ])('denies a push to dev that does not name the commit literally, even with every proof: %s on %s', (command, branch) => {
    const result = push(command, { branch });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/40-character sha/);
  });

  it.each([
    'git checkout main && git merge feat && git push',
    'git switch dev && git merge --ff-only feat && git push',
    'git checkout -q main; git push origin HEAD',
    'git rebase origin/main main && git push',
    'gh pr checkout 12 && git push',
    'git branch -m dev && git push',
    'git branch --move dev && git push',
    'git branch -M feature/x main && git push origin HEAD',
    'git symbolic-ref HEAD refs/heads/dev && git push',
  ])('denies an implicit push after a branch switch on the same line: %s', (command) => {
    expect(push(command).decision).toBe('deny');
  });

  it('keeps ordinary feature-branch lines working', () => {
    expect(push('git commit -m x && git push').decision).toBe('pass');
    expect(push('git rebase origin/dev && git push --force-with-lease').decision).toBe('pass');
    expect(push('git checkout feature/y && git push origin feature/y').decision).toBe('pass');
    expect(push('git branch -m old-name other-name && git push').decision).toBe('pass');
    expect(push('git branch -d old && git push').decision).toBe('pass');
    expect(push('git symbolic-ref HEAD && git push').decision).toBe('pass');
    expect(push('gh pr view 12 && git push').decision).toBe('pass');
  });

  it('denies with a handoff above L0 or without a level', () => {
    expect(push(undefined, { transcript: L1 }).reason).toMatch(/L1.*pull request/s);
    expect(push(undefined, { transcript: [] }).decision).toBe('deny');
  });

  it('denies without an approval for the exact commit, or when the latest review requests changes', () => {
    expect(push(undefined, { reviews: {} }).reason).toMatch(/no recorded independent review/);
    expect(push(undefined, { reviews: { [OLD]: { ...APPROVED, sha: OLD } } }).decision).toBe('deny');
    expect(push(undefined, { reviews: { [HEAD]: { ...APPROVED, verdict: 'REQUEST_CHANGES' } } }).reason).toMatch(/requests changes/);
    // Decision 19: the approval comes from a reviewer this session spawned.
    expect(push(undefined, { reviews: { [HEAD]: { ...APPROVED, sessionId: 'other' } } }).reason).toMatch(/another session/);
    expect(push(undefined, { reviews: { [HEAD]: { ...APPROVED, sessionId: undefined } } }).decision).toBe('deny');
    expect(evaluate(bash(`git push origin ${HEAD}:refs/heads/dev`, { sessionId: '' }), deps({ transcript: L0, reviews: { [HEAD]: APPROVED } })).decision).toBe('deny');
  });

  it('denies without a green workflow_dispatch run on a feature branch at that commit', () => {
    expect(push(undefined, { runs: [] }).reason).toMatch(/workflow_dispatch/);
    expect(push(undefined, { runs: [{ ...GREEN_RUN, conclusion: 'failure' }] }).decision).toBe('deny');
    expect(push(undefined, { runs: [{ ...GREEN_RUN, event: 'pull_request' }] }).decision).toBe('deny');
    expect(push(undefined, { runs: [{ ...GREEN_RUN, headSha: OLD }] }).decision).toBe('deny');
    expect(push(undefined, { runs: [{ ...GREEN_RUN, headBranch: 'dev' }] }).decision).toBe('deny');
    expect(push(undefined, { runs: [{ ...GREEN_RUN, conclusion: null, status: 'in_progress' }] }).decision).toBe('deny');
  });

  it('denies when the run lookup fails, instead of passing', () => {
    expect(push(undefined, { ghError: 'HTTP 502' }).reason).toMatch(/could not check it \(HTTP 502\)/);
  });

  it('denies a push that does not fast-forward dev', () => {
    expect(push(undefined, { ancestor: false }).reason).toMatch(/fast-forward/);
    expect(push(undefined, { refs: { ...REFS, 'refs/remotes/origin/dev': '' } }).decision).toBe('deny');
    expect(push(undefined, { ancestor: new Error('bad object') }).decision).toBe('deny');
  });

  it('never lets a forced push through, whatever the proofs', () => {
    expect(push(`git push -f origin ${HEAD}:refs/heads/dev`).decision).toBe('deny');
    expect(push(`git push origin +${HEAD}:refs/heads/dev`).decision).toBe('deny');
    expect(push(`git push --forc origin ${HEAD}:refs/heads/dev`).decision).toBe('deny');
  });

  it.each([
    'git push origin HEAD:heads/main',
    'git -c remote.origin.push=HEAD:refs/heads/main push',
    'git -c push.default=upstream -c branch.feat.merge=refs/heads/dev push',
    'git config remote.origin.push HEAD:refs/heads/main',
    'git config --local push.default upstream',
    'git config set branch.feature/x.merge refs/heads/dev',
  ])('denies destinations spelled around the guard: %s', (command) => {
    expect(push(command).decision).toBe('deny');
  });

  it('asks before an implicit push when a push refspec is configured, and lets config reads through', () => {
    expect(push('git push', { gitConfig: { 'remote.origin.push': 'HEAD:refs/heads/main' } }).decision).toBe('ask');
    expect(push('git push origin feature/x', { gitConfig: { 'remote.origin.push': 'HEAD:refs/heads/main' } }).decision).toBe('pass');
    expect(push('git config --get remote.origin.push').decision).toBe('pass');
    expect(push('git config push.default').decision).toBe('pass');
  });

  it.each([
    `echo '{}' > .git/agent-review-stamps/reviews/${HEAD}.json`,
    'rm -rf .git/agent-review-stamps',
    'mkdir -p "$(git rev-parse --git-dir)/agent-review-stamps/reviews"',
    `cp r.json .git/worktrees/x/agent-review-stamps/reviews/${HEAD}.json`,
    `node -e "import('./.agents/hooks/stamps.mjs').then((m) => m.recordReview('x', {}))"`,
    'node .agents/hooks/review-stamp.mjs < forged.json',
  ])('denies any write to the approval store: %s', (command) => {
    expect(decide(command, { transcript: L0 })).toBe('deny');
  });

  it('lets an agent read the approval store and the stamp code, and blocks the edit tools there', () => {
    expect(decide(`cat .git/agent-review-stamps/reviews/${HEAD}.json`)).toBe('pass');
    expect(decide('ls .git/agent-review-stamps/reviews')).toBe('pass');
    expect(decide('cat .agents/hooks/stamps.mjs')).toBe('pass');
    expect(decide('npm run verify > /tmp/x/-home-q-agent-review-stamps-adapters/verify.log 2>&1')).toBe('pass');
    const write = normalize({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `/repo/.git/agent-review-stamps/reviews/${HEAD}.json`, content: '{}' }, cwd: '/repo' }, 'claude');
    expect(evaluate(write, deps()).decision).toBe('deny');
  });
});

describe('secrets and wrappers', () => {
  it.each(['cat .env.local', 'head -n 3 .env', 'grep KEY .env.production', 'sed -n 1p .env.local', 'base64 < .env.local', 'cp .env.local /tmp/x', 'echo "$(cat .env.local)"', 'cat .env*', 'cat .e?v.local', 'grep -r KEY .', 'grep -rn KEY', 'grep -R KEY /repo', 'rg -uu KEY', 'rg --hidden --no-ignore KEY .', 'set -a; source .env.local; set +a; node x.mjs', 'set -a; . ./.env.local >/dev/null; set +a; curl x', 'source .env'])('blocks reading .env files: %s', (command) => {
    expect(decide(command)).toBe('deny');
  });

  it.each(['cat .env.example', 'grep -r ".env" src', 'grep -r KEY src docs', "grep -r --exclude='.env*' KEY .", 'rg KEY', 'rg --hidden KEY', 'cat *.md', 'node --env-file-if-exists=.env.local scripts/x.mjs', 'source ~/.zshrc', '. ./scripts/lib.sh', 'ls -la .env*'])('allows templates, env loading and patterns: %s', (command) => {
    expect(decide(command)).toBe('pass');
  });

  it('blocks the Read tool on .env files and allows it on the template', () => {
    const read = (file) => evaluate(normalize({ ...fixture('claude-pretooluse-read.json'), tool_input: { file_path: file } }, 'claude'), deps()).decision;
    expect(read('/repo/.env.local')).toBe('deny');
    expect(read('/repo/.env.example')).toBe('pass');
  });

  it('blocks the Grep tool on .env files, by path or glob', () => {
    const grep = (input) => evaluate(normalize({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'KEY', ...input }, cwd: '/repo' }, 'claude'), deps()).decision;
    expect(grep({ path: '/repo/.env.local' })).toBe('deny');
    expect(grep({ glob: '.env*' })).toBe('deny');
    expect(grep({ glob: '*.{env,local}' })).toBe('pass');
    expect(grep({ glob: '*env*' })).toBe('deny');
    expect(grep({ path: '/repo/.env.example' })).toBe('pass');
    expect(grep({ path: '/repo/src', glob: '*.ts' })).toBe('pass');
  });

  it.each([
    ['(git push origin HEAD:main)', 'deny'],
    ['(terraform apply)', 'ask'],
    ['(deploy-cli deploy --prod)', 'ask'],
    ['(git add -A)', 'deny'],
    ['(cd x && git push origin main)', 'deny'],
  ])('sees commands inside a subshell: %s', (command, decision) => {
    expect(decide(command)).toBe(decision);
  });

  it.each(['git push --mirr origin', 'git commit --no-verif -m x', 'git commit --al -m x', 'git push --del origin dev', 'git add --al', 'git add --upd', 'git merge --no-verif feat'])('reads abbreviated long options as git does: %s', (command) => {
    expect(decide(command, { branch: 'feature/x' })).toBe('deny');
  });

  it('does not mistake longer options for guarded ones', () => {
    expect(decide('git commit --allow-empty -m x')).toBe('pass');
    expect(decide('git commit --no-edit --amend')).toBe('pass');
    expect(decide('git push --follow-tags origin feature/x')).toBe('pass');
  });

  it('sees through shell keywords and wrappers', () => {
    expect(decide('if git diff --quiet; then git add -A; fi')).toBe('deny');
    expect(decide('for f in a b; do git push -f origin dev; done')).toBe('deny');
    expect(decide('! git commit --no-verify -m x')).toBe('deny');
    expect(decide('timeout 600 terraform apply')).toBe('ask');
    expect(decide('gtimeout -k 5 60 terraform apply')).toBe('ask');
    expect(decide('rtk proxy git push -f origin dev')).toBe('deny');
    expect(decide('rtk proxy cat .env.local')).toBe('deny');
  });
});

describe("the harness's own files (decision 20)", () => {
  const edit = (file, tool = 'Edit') => evaluate(normalize({ ...fixture('claude-pretooluse-edit.json'), tool_name: tool, tool_input: { file_path: file, old_string: 'a', new_string: 'b', content: 'x' } }, 'claude'), deps()).decision;
  const HARNESS = ['/repo/.agents/hooks/guard.mjs', '/repo/.agents/hooks/lib.mjs', '/repo/.agents/hooks/journal.mjs', '/repo/.agents/hooks/config.mjs', '/repo/.agents/manifest.json', '/repo/.agents/manifest.state.json', '/repo/.agents/harness.config.json', '/repo/.agents/agents/reviewer.md', '/repo/.claude/agents/reviewer.md', '/repo/.agents/agents/healer.md', '/repo/.claude/agents/healer.md', '/repo/.codex/agents/reviewer.toml', '/repo/.agents/evals/clean-commit/check.mjs', '/repo/.agents/rules/learned/some-rule.md', '/repo/.agents/healing/lint.mjs', '/repo/.agents/sync-adapters.mjs', '/repo/.agents/check.mjs', '/repo/.claude/settings.json', '/repo/.claude/settings.local.json', '/repo/.codex/hooks.json', '/repo/.codex/config.toml', '/repo/.git/hooks/pre-commit', '/main/.git/hooks/pre-push', '/main/.codex/hooks.json'];

  it.each(HARNESS)('asks before editing or writing %s', (file) => {
    expect(edit(file)).toBe('ask');
    expect(edit(file, 'Write')).toBe('ask');
  });

  it('lets neighbours through', () => {
    for (const file of ['/repo/.agents/rules/base.md', '/repo/.agents/rules/docs.md', '/repo/.agents/agents/implementer.md', '/repo/.claude/agents/implementer.md', '/repo/scripts/check-docs.mjs', '/repo/scripts/sync-agent-adapters.mjs', '/repo/.agents/harness.config.example.json', '/repo/.agents/evaluations.md', '/repo/src/hooks/useThing.ts']) expect(edit(file)).toBe('pass');
  });

  it('asks before shell writes, removals, moves and mode changes', () => {
    for (const command of [
      'rm .agents/hooks/guard.mjs',
      'rm -rf .agents',
      'rm -rf .',
      'rm -f .git/hooks/pre-commit',
      'unlink .claude/settings.json',
      'mv .agents/hooks/guard.mjs /tmp/guard.mjs',
      'mv /tmp/empty.json .claude/settings.json',
      'cp /dev/null .codex/hooks.json',
      "sed -i '' 's/deny/pass/' .agents/hooks/guard.mjs",
      "perl -pi -e 's/a/b/' .agents/sync-adapters.mjs",
      'echo {} > .claude/settings.local.json',
      'printf x >> .git/hooks/pre-push',
      'tee .agents/manifest.json < m.json',
      'truncate -s 0 .agents/check.mjs',
      'echo {} > .agents/harness.config.json',
      'rm -rf .agents/healing',
      'chmod -x .git/hooks/pre-commit',
      'dd if=/dev/null of=.agents/hooks/lib.mjs',
      'cd .agents && rm -r hooks',
      "node -e \"require('fs').writeFileSync('.agents/hooks/guard.mjs', '')\"",
      "python3 -c \"open('.claude/settings.json', 'w').write('{}')\"",
      "node -e \"require('fs').rmSync('.agents/hooks', { recursive: true })\"",
      "node --input-type=module -e \"import { renameSync } from 'node:fs'; renameSync('.git/hooks/pre-commit', '/tmp/x')\"",
      "python3 -c \"import os; os.remove('.git/hooks/pre-push')\"",
      "python3 -c \"from pathlib import Path; Path('.codex/hooks.json').write_text('{}')\"",
    ]) expect(decide(command), command).toBe('ask');
  });

  it('asks before git removes, moves and restores them, unlike protected configuration', () => {
    for (const command of [
      'git rm .agents/hooks/guard.mjs',
      'git rm -r --cached .agents',
      'git mv .agents/sync-adapters.mjs .agents/old.mjs',
      'git checkout dev -- .agents/harness.config.json',
      'git checkout -- .agents/hooks/guard.mjs',
      'git checkout dev -- .claude/settings.json',
      'git checkout .',
      'git restore .codex/config.toml',
      'git restore --source HEAD~3 --worktree .agents/hooks',
    ]) expect(decide(command), command).toBe('ask');
  });

  it('keeps the everyday commands passing', () => {
    for (const command of [
      'cat .agents/hooks/guard.mjs',
      'cp .agents/hooks/guard.mjs /tmp/guard.mjs',
      'node .agents/hooks/guard.mjs --tool claude < payload.json',
      'npm run sync:adapters',
      'git add .agents/hooks/guard.mjs .claude/settings.json',
      'git diff .agents/hooks',
      'git checkout -b feature/y',
      'git checkout dev',
      'git restore --staged .agents/hooks/guard.mjs',
      'rm -rf node_modules/.vite',
      'mv notes.md docs/notes.md',
      "node -e \"console.log(require('./.agents/manifest.json').entries.length)\"",
      'cat .agents/harness.config.json',
      'node .agents/check.mjs',
    ]) expect(decide(command), command).toBe('pass');
  });

  it('lets inline code import, read or quote the guarded files', () => {
    for (const command of [
      "node --input-type=module -e \"import { parseCommands } from './.agents/hooks/shell.mjs'; console.log(JSON.stringify(parseCommands(process.argv[1])))\" 'git push'",
      // Quotes a write as data for the parser to split, and writes to stdout.
      "node --input-type=module -e \"import { parseCommands } from './.agents/hooks/shell.mjs'; process.stdout.write(JSON.stringify(parseCommands(\\`python3 -c \\\"open('.claude/settings.json', 'w').write('{}')\\\"\\`)))\"",
      "node -e \"import('./.agents/hooks/guard.mjs').then((m) => process.stdout.write(String(m.guardRule.length)))\"",
      "node -e \"console.log(require('fs').readFileSync('.agents/hooks/guard.mjs', 'utf8').length)\"",
      "python3 -c \"import json; print(json.load(open('.claude/settings.json'))['hooks'].keys())\"",
    ]) expect(decide(command), command).toBe('pass');
  });

  it('still denies a hooks path change as a bypass', () => {
    expect(decide('git config core.hooksPath /dev/null')).toBe('deny');
    expect(decide('git -c core.hooksPath=/dev/null commit -m x')).toBe('deny');
  });

  it('blocks with a handoff on Codex', () => {
    const patch = { ...fixture('codex-pretooluse-apply-patch.json'), tool_input: { command: '*** Begin Patch\n*** Delete File: /repo/.agents/hooks/guard.mjs\n*** End Patch' } };
    expect(evaluate(normalize(patch, 'codex'), deps()).decision).toBe('ask');
  });
});

describe('lint, test and TypeScript configuration', () => {
  const edit = (file, options) => evaluate(normalize({ ...fixture('claude-pretooluse-edit.json'), tool_input: { file_path: file, old_string: 'a', new_string: 'b' } }, 'claude'), deps(options)).decision;

  it.each(['/repo/eslint.config.js', '/repo/vite.config.ts', '/repo/tsconfig.app.json', '/repo/knip.json', '/repo/playwright.config.ts', '/repo/jest.config.js', '/repo/.eslintrc.json'])('asks before editing %s', (file) => {
    expect(edit(file)).toBe('ask');
  });

  it('lets other files through', () => {
    expect(edit('/repo/src/app.ts')).toBe('pass');
    expect(edit('/repo/.github/workflows/ci.yml')).toBe('pass');
  });

  it('asks before shell writes and Codex patches to protected configuration, and leaves restores alone', () => {
    expect(decide("sed -i '' 's/a/b/' eslint.config.js")).toBe('ask');
    expect(decide('echo {} > tsconfig.json')).toBe('ask');
    expect(decide('git checkout -- vite.config.ts')).toBe('pass');
    expect(decide('git restore --staged tsconfig.json')).toBe('pass');
    expect(decide('sed -n 1p eslint.config.js')).toBe('pass');
    const patch = { ...fixture('codex-pretooluse-apply-patch.json'), tool_input: { command: '*** Begin Patch\n*** Update File: /repo/knip.json\n@@\n-a\n+b\n*** End Patch' } };
    expect(evaluate(normalize(patch, 'codex'), deps()).decision).toBe('ask');
    expect(evaluate(normalize(fixture('codex-pretooluse-apply-patch.json'), 'codex'), deps()).decision).toBe('pass');
  });

  it('reads the protected patterns from the config', () => {
    const settings = { protectedConfig: ['^pyproject\\.toml$', '^config/lint/'] };
    expect(edit('/repo/pyproject.toml', { settings })).toBe('ask');
    expect(edit('/repo/config/lint/rules.json', { settings })).toBe('ask');
    expect(edit('/repo/eslint.config.js', { settings })).toBe('pass');
    expect(decide('echo x > pyproject.toml', { settings })).toBe('ask');
  });

  it('keeps the default patterns and the harness files guarded when the config cannot be read', () => {
    const settings = new Error('Unexpected token } in JSON');
    expect(edit('/repo/eslint.config.js', { settings })).toBe('ask');
    expect(edit('/repo/.agents/harness.config.json', { settings })).toBe('ask');
    expect(edit('/repo/.agents/hooks/guard.mjs', { settings })).toBe('ask');
    expect(edit('/repo/src/app.ts', { settings })).toBe('pass');
  });
});

describe('production confirmations', () => {
  it.each([
    'deploy-cli deploy --prod',
    'npx deploy-cli deploy --prod',
    'deploy-cli --prod deploy',
    'deploy-cli deploy web --prod --yes',
    'terraform apply',
    'terraform apply -auto-approve plan.out',
    'terraform -chdir=infra apply',
    'kubectl --context production apply -f app.yaml',
    'kubectl apply -f app.yaml --context production',
    'kubectl apply --context=production -f app.yaml',
    'db-cli migrate --remote',
    'db-cli --remote migrate up',
    '/usr/local/bin/terraform apply',
  ])('asks before a configured production command: %s', (command) => {
    expect(decide(command)).toBe('ask');
  });

  it.each(PRODUCTION.map((entry) => entry.command))('asks before every configured production command, even at L0: %s', (command) => {
    const result = evaluate(bash(command), deps({ transcript: L0 }));
    expect(result.decision).toBe('ask');
    expect(result.reason).toMatch(/^Production confirmation: .*maintainer's explicit approval/);
  });

  it.each([
    'deploy-cli deploy',
    'deploy-cli preview --prod',
    'terraform plan',
    'terraform validate',
    'kubectl --context staging apply -f app.yaml',
    'kubectl --context production get pods',
    'db-cli migrate',
    'echo terraform apply',
    'my-terraform apply',
  ])('lets commands that are not a configured production command through: %s', (command) => {
    expect(decide(command)).toBe('pass');
  });

  it('matches on words: the program, the later words in order, flags anywhere', () => {
    expect(matchesProductionCommand(['deploy-cli', 'deploy', '--prod'], 'deploy-cli deploy --prod')).toBe(true);
    expect(matchesProductionCommand(['deploy-cli', '--prod', 'deploy'], 'deploy-cli deploy --prod')).toBe(true);
    expect(matchesProductionCommand(['deploy-cli', 'deploy', '--production'], 'deploy-cli deploy --prod')).toBe(false);
    expect(matchesProductionCommand(['db-cli', 'up', 'migrate'], 'db-cli migrate up')).toBe(false);
    expect(matchesProductionCommand(['db-cli', 'migrate', 'x', 'up'], 'db-cli migrate up')).toBe(true);
    expect(matchesProductionCommand(['other', 'migrate', 'up'], 'db-cli migrate up')).toBe(false);
    expect(matchesProductionCommand(['vendor-cli', 'deploy', '--target=production'], 'vendor-cli deploy --target production')).toBe(true);
  });

  it('accepts bare strings and uses a default effect', () => {
    const result = evaluate(bash('npm publish --tag next'), deps({ settings: { productionCommands: ['npm publish'] } }));
    expect(result.decision).toBe('ask');
    expect(result.reason).toMatch(/npm publish \(a production change\)/);
  });

  it('asks for nothing when the config lists no production command', () => {
    expect(decide('terraform apply', { settings: { productionCommands: [] } })).toBe('pass');
  });

  it('lets read-only API calls through', () => {
    expect(decide('gh api repos/o/r/git/refs/heads/dev')).toBe('pass');
    expect(decide('gh api repos/o/r/contents/README.md --jq .content')).toBe('pass');
  });
});

describe('gh pr merge', () => {
  const merge = (options, command = `gh pr merge 7 --squash --match-head-commit ${HEAD}`) => {
    const dependencies = deps({ transcript: L0, pull: pull(), reviews: { [HEAD]: APPROVED }, ...options });
    return { ...evaluate(bash(command), dependencies), calls: dependencies.calls };
  };

  it('passes an L0 merge into dev with a head-bound approval, green checks and --match-head-commit', () => {
    const result = merge();
    expect(result.decision).toBe('pass');
    expect(result.calls[0]).toEqual(['pr', 'view', '7', '--json', 'number,baseRefName,headRefOid,isDraft,mergeStateStatus,comments,reviews']);
  });

  it('asks at L1 and L2, and when no level was announced', () => {
    expect(merge({ transcript: L1 }).decision).toBe('ask');
    expect(merge({ transcript: [{ role: 'assistant', text: 'Level L2: money.' }] }).decision).toBe('ask');
    expect(merge({ transcript: [] }).decision).toBe('ask');
  });

  it('asks once the level was raised during the session, whoever tries to lower it back', () => {
    expect(merge({ transcript: [...L1, ...L0] }).decision).toBe('ask');
    expect(merge({ transcript: [...L1, { role: 'user', text: 'Passe en niveau L0 pour la suite.' }] }).decision).toBe('ask');
    expect(merge({ transcript: [...L0, { role: 'user', text: 'This is level L2 work now.' }] }).decision).toBe('ask');
    expect(merge({ transcript: [...L0, { role: 'user', text: "c'est du L2 en fait, ne merge pas" }] }).decision).toBe('ask');
    expect(merge({ transcript: [...L0, { role: 'assistant', text: 'This touches RLS, so I raise to L2.' }] }).decision).toBe('ask');
    expect(merge({ transcript: [...L0, { role: 'user', text: 'on passe en l2' }] }).decision).toBe('ask');
    expect(merge({ transcript: [...L0, { role: 'user', text: "c'est niveau 2 ça" }] }).decision).toBe('ask');
  });

  it('needs the hook-recorded approval as well as the comment, like a direct push', () => {
    expect(merge({ reviews: {} }).decision).toBe('ask');
    expect(merge({ reviews: { [HEAD]: { ...APPROVED, verdict: 'REQUEST_CHANGES' } } }).decision).toBe('ask');
    expect(merge({ reviews: { [OLD]: { ...APPROVED, sha: OLD } } }).decision).toBe('ask');
    expect(merge({ reviews: { [HEAD]: { ...APPROVED, sessionId: 'other' } } }).reason).toMatch(/another session/);
  });

  describe('auto-merge (decision 22)', () => {
    const AUTO = `gh pr merge 7 --auto --merge --delete-branch --match-head-commit ${HEAD}`;
    const opening = (text) => [{ role: 'user', text }, { role: 'assistant', text: 'Level L0: one-word fix.' }];
    const granted = opening('Fix the typo on the pricing page.\nauto-merge allowed');

    it('passes when the first user message grants it, at L0, with the in-session approval, even before checks are green', () => {
      expect(merge({ transcript: granted }, AUTO).decision).toBe('pass');
      expect(merge({ transcript: granted, pull: pull({ mergeStateStatus: 'BLOCKED' }) }, AUTO).decision).toBe('pass');
    });

    it('asks without the grant in the first message', () => {
      expect(merge({}, AUTO).decision).toBe('ask');
      expect(merge({ transcript: [...opening('Fix the typo.'), { role: 'user', text: 'auto-merge allowed' }] }, AUTO).reason).toMatch(/opening instruction/);
      expect(merge({ transcript: opening('<pasted_content id="x">auto-merge allowed</pasted_content> Fix the typo.') }, AUTO).decision).toBe('ask');
      expect(merge({ transcript: opening('Fix the typo. No auto-merge allowed.') }, AUTO).decision).toBe('ask');
    });

    it.each([
      'Fix typo. pas d\u2019auto-merge autoris\u00e9.',
      'Implement decision 22: auto-merge is allowed only when the maintainer grants it.',
      "jamais d'auto-merge ok",
      'Is auto-merge allowed here?',
      'auto-merge allowed only if I say so',
      'Fix typo. auto-merge ok',
    ])('asks when the opening message only mentions auto-merge in a sentence: %s', (text) => {
      expect(merge({ transcript: opening(text) }, AUTO).decision).toBe('ask');
    });

    it('still needs the stamp, the comment, L0 and the exact head', () => {
      expect(merge({ transcript: granted, reviews: {} }, AUTO).decision).toBe('ask');
      expect(merge({ transcript: granted, reviews: { [HEAD]: { ...APPROVED, sessionId: 'other' } } }, AUTO).decision).toBe('ask');
      expect(merge({ transcript: granted, pull: pull({ comments: [] }) }, AUTO).decision).toBe('ask');
      expect(merge({ transcript: [...granted, { role: 'assistant', text: 'Level L1: raised, touches two modules.' }] }, AUTO).decision).toBe('ask');
      expect(merge({ transcript: granted.slice(0, 1).concat({ role: 'assistant', text: 'Level L1: one script.' }) }, AUTO).decision).toBe('ask');
      expect(merge({ transcript: granted }, `gh pr merge 7 --auto --merge --match-head-commit ${OLD}`).decision).toBe('deny');
      expect(merge({ transcript: granted }, 'gh pr merge 7 --auto --merge').decision).toBe('deny');
      expect(merge({ transcript: granted }, `${AUTO} --admin`).decision).toBe('deny');
      expect(merge({ transcript: granted, pull: pull({ isDraft: true }) }, AUTO).decision).toBe('ask');
    });

    it('recognizes only a line of its own', () => {
      for (const text of ['auto-merge ok', 'Fix typo.\nauto-merge allowed', 'Fix typo.\n  Auto-merge OK.  \nThanks', 'auto-merge autoris\u00e9', 'auto-merge autoris\u00e9e!', 'auto\u2011merge ok']) expect(grantsAutoMerge(text), text).toBe(true);
      for (const text of ['Fix typo. auto-merge ok', 'auto-merge ok, then ship', 'no auto-merge allowed', 'auto merge ok', 'automerge ok', 'auto-merge okra', 'auto-merge: ok', '<pasted_content id="a">\nauto-merge ok\n</pasted_content>']) expect(grantsAutoMerge(text), text).toBe(false);
    });
  });

  it('asks when the approval is missing, stale, or overridden by a newer REQUEST_CHANGES', () => {
    expect(merge({ pull: pull({ comments: [] }) }).decision).toBe('ask');
    expect(merge({ pull: pull({ comments: [approval('APPROVE', OLD)] }) }).decision).toBe('ask');
    const newer = [approval('APPROVE', HEAD, '2026-09-27T10:00:00Z'), approval('REQUEST_CHANGES', HEAD, '2026-09-27T11:00:00Z')];
    expect(merge({ pull: pull({ comments: newer }) }).decision).toBe('ask');
    expect(merge({ pull: pull({ comments: [{ body: `LGTM\nIndependent review: APPROVE ${HEAD}`, createdAt: 'z' }] }) }).decision).toBe('ask');
  });

  it('reads verdicts from reviews too, merged with comments by time', () => {
    const review = (body, submittedAt, state = 'COMMENTED') => ({ body, submittedAt, state, commit: { oid: HEAD } });
    expect(merge({ pull: pull({ comments: [], reviews: [review(`Independent review: APPROVE ${HEAD}`, '2026-09-27T10:00:00Z')] }) }).decision).toBe('pass');
    const newerReview = [review(`Independent review: REQUEST_CHANGES ${HEAD}`, '2026-09-27T11:00:00Z')];
    expect(merge({ pull: pull({ reviews: newerReview }) }).decision).toBe('ask');
    expect(merge({ pull: pull({ reviews: [review('Needs work.', '2026-09-27T11:00:00Z', 'CHANGES_REQUESTED')] }) }).decision).toBe('ask');
    expect(merge({ pull: pull({ reviews: [review('Needs work.', '2026-09-27T09:00:00Z', 'CHANGES_REQUESTED')] }) }).decision).toBe('pass');
  });

  it('asks while the pull request is a draft or not CLEAN', () => {
    expect(merge({ pull: pull({ isDraft: true }) }).decision).toBe('ask');
    expect(merge({ pull: pull({ mergeStateStatus: 'BLOCKED' }) }).decision).toBe('ask');
    expect(merge({ pull: pull({ mergeStateStatus: 'UNSTABLE' }) }).decision).toBe('ask');
  });

  it('denies without a matching --match-head-commit, and denies --admin outright', () => {
    expect(merge({}, 'gh pr merge 7 --squash').decision).toBe('deny');
    expect(merge({}, `gh pr merge 7 --match-head-commit ${OLD}`).decision).toBe('deny');
    expect(merge({}, `gh pr merge 7 --admin --match-head-commit ${HEAD}`).decision).toBe('deny');
  });

  it('treats a release merge into main as a production confirmation, even at L0', () => {
    expect(merge({ pull: pull({ baseRefName: 'main' }) }).decision).toBe('ask');
    expect(merge({ pull: pull({ baseRefName: 'main' }) }).reason).toMatch(/^Production confirmation: gh pr merge into main/);
    expect(merge({ pull: pull({ baseRefName: 'release/1.2' }) }).reason).toMatch(/targets release\/1\.2, not dev/);
  });

  it('follows the configured branch names', () => {
    const settings = { branches: { integration: 'develop', release: 'production' } };
    expect(merge({ settings, pull: pull({ baseRefName: 'develop' }) }).decision).toBe('pass');
    expect(merge({ settings, pull: pull({ baseRefName: 'production' }) }).reason).toMatch(/^Production confirmation: gh pr merge into production/);
    expect(merge({ settings, pull: pull({ baseRefName: 'dev' }) }).reason).toMatch(/targets dev, not develop/);
    expect(merge({ settings, pull: pull({ baseRefName: 'main' }) }).decision).toBe('ask');
  });

  it('asks when the pull request cannot be read or lacks a head commit', () => {
    expect(merge({ ghError: 'timed out' }).decision).toBe('ask');
    expect(merge({ pull: pull({ headRefOid: undefined }) }).decision).toBe('ask');
  });

  it.each([
    'gh api -X PUT repos/o/r/pulls/7/merge',
    'gh api -XPUT repos/o/r/pulls/7/merge',
    'gh api --method=PUT repos/o/r/pulls/7/merge',
    'gh api graphql -f query=\'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }\'',
    'gh api graphql -f query=\'mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }\'',
    'gh api -X PATCH repos/o/r/git/refs/heads/dev -f sha=abc',
    'gh api repos/o/r/git/refs -f ref=refs/heads/dev -f sha=abc',
    'gh api repos/o/r/merges -f base=dev -f head=feat',
    'gh api -X PUT repos/o/r/contents/src/a.ts --input body.json',
    'gh api graphql -f query=\'mutation { updateRefs(input: {}) { clientMutationId } }\'',
    'gh api graphql -f query=\'mutation { createCommitOnBranch(input: {}) { commit { oid } } }\'',
  ])('asks before merging or writing a branch through the API: %s', (command) => {
    expect(decide(command)).toBe('ask');
  });

  it('reads the latest verdict line only', () => {
    expect(latestReview([approval('APPROVE', OLD, '1'), approval('APPROVE', HEAD, '2')])).toEqual({ verdict: 'APPROVE', sha: HEAD });
    expect(latestReview([{ body: 'no verdict' }])).toBeNull();
  });
});

describe('approval comments', () => {
  const post = `gh pr comment 7 --body "Independent review: APPROVE ${HEAD}"`;

  it('lets only a reviewer subagent publish an approval', () => {
    expect(evaluate(normalize({ ...fixture('claude-pretooluse-subagent-bash.json'), tool_input: { command: post } }, 'claude'), deps()).decision).toBe('pass');
    expect(decide(post)).toBe('deny');
    expect(decide('gh pr comment 7 --body-file review.md', { files: { '/repo/review.md': `Independent review: APPROVE ${HEAD}` } })).toBe('deny');
    expect(decide(`gh pr comment 7 --body-file - <<'EOF'\nIndependent review: APPROVE ${HEAD}\nEOF`)).toBe('deny');
  });

  it.each([
    'gh api repos/o/r/issues/7/comments -F body=@r.md',
    'gh pr comment 7 --body "$(cat r.md)"',
    'gh pr comment 7 -F - < r.md',
    'cat r.md | gh pr comment 7 -F -',
    'gh pr review 7 --approve --body-file r.md',
  ])('catches an approval read from a file: %s', (command) => {
    expect(decide(command, { files: { '/repo/r.md': `Independent review: APPROVE ${HEAD}\n` } })).toBe('deny');
    expect(decide(command, { files: { '/repo/r.md': 'Looks fine.\n' } })).toBe('pass');
  });

  it('does not flag documentation that mentions the format', () => {
    expect(decide('gh pr create --draft --body-file body.md', { files: { '/repo/body.md': 'The reviewer posts `Independent review: APPROVE <sha>` as its first line.' } })).toBe('pass');
    expect(decide(`gh api repos/o/r/issues/7/comments -f body='Independent review: APPROVE ${HEAD}'`)).toBe('deny');
    expect(decide(`cat > docs/x.md <<'EOF'\nIndependent review: APPROVE <sha>\nEOF`)).toBe('pass');
    expect(decide(`gh pr comment 7 --body "Independent review: REQUEST_CHANGES ${HEAD}"`)).toBe('pass');
  });
});

describe('tool payloads', () => {
  it('normalizes the captured Claude and Codex payloads', () => {
    expect(normalize(fixture('claude-pretooluse-bash.json'), 'claude')).toMatchObject({ kind: 'bash', command: 'echo PROBE_ASK' });
    expect(normalize(fixture('claude-pretooluse-subagent-bash.json'), 'claude')).toMatchObject({ kind: 'bash', agentType: 'reviewer' });
    expect(normalize(fixture('codex-pretooluse-bash.json'), 'codex')).toMatchObject({ kind: 'bash', command: 'echo PROBE_ASK' });
    expect(normalize(fixture('codex-pretooluse-apply-patch.json'), 'codex')).toMatchObject({ kind: 'patch', paths: ['/repo/note.txt'] });
  });

  // End to end through the CLI: Claude receives `ask`; Codex cannot ask, so the
  // same verdict becomes a deny that hands the command to the maintainer. The
  // guard reads the config of the repository it runs in.
  it.each([
    ['claude', 'claude-pretooluse-bash.json', 'ask'],
    ['codex', 'codex-pretooluse-bash.json', 'deny'],
  ])('answers in the %s wire format', (tool, name, decision) => {
    const repository = configuredRepository();
    const payload = { ...fixture(name), cwd: repository, tool_input: { command: 'terraform apply' } };
    const journal = isolatedJournal();
    try {
      const output = execFileSync('node', [guardScript, '--tool', tool], { input: JSON.stringify(payload), encoding: 'utf8', env: journal.env });
      const answer = JSON.parse(output).hookSpecificOutput;
      expect(answer).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: decision });
      if (tool === 'codex') expect(answer.permissionDecisionReason).toMatch(/let them run it/);
      const events = readdirSync(path.join(journal.directory, 'events')).flatMap((file) => readFileSync(path.join(journal.directory, 'events', file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
      // The journal keeps the guard's own verdict, before Codex turns an ask into a deny.
      expect(events).toEqual([expect.objectContaining({ kind: 'guard', decision: 'ask', tool, rule: 'production-confirmations: production confirmation', command: 'terraform apply' })]);
    } finally {
      rmSync(journal.directory, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('asks nothing for a production command the config does not list', () => {
    const repository = configuredRepository({ productionCommands: [] });
    const journal = isolatedJournal();
    try {
      const payload = { ...fixture('claude-pretooluse-bash.json'), cwd: repository, tool_input: { command: 'terraform apply' } };
      expect(execFileSync('node', [guardScript, '--tool', 'claude'], { input: JSON.stringify(payload), encoding: 'utf8', env: journal.env })).toBe('');
    } finally {
      rmSync(journal.directory, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('asks for git and gh, and passes the rest, when the config cannot be read', () => {
    const repository = configuredRepository('{ "branches": ');
    const journal = isolatedJournal();
    const run = (command) => execFileSync('node', [guardScript, '--tool', 'claude'], { input: JSON.stringify({ ...fixture('claude-pretooluse-bash.json'), cwd: repository, tool_input: { command } }), encoding: 'utf8', env: journal.env });
    try {
      for (const command of ['git push origin feature/x', 'gh pr merge 7']) {
        const answer = JSON.parse(run(command)).hookSpecificOutput;
        expect(answer.permissionDecision, command).toBe('ask');
        expect(answer.permissionDecisionReason).toMatch(/The guard failed on this command/);
      }
      expect(run('npm test')).toBe('');
    } finally {
      rmSync(journal.directory, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('records nothing during a canary, healing or admission run of the loop', () => {
    const repository = configuredRepository();
    const payload = { ...fixture('claude-pretooluse-bash.json'), cwd: repository, tool_input: { command: 'terraform apply' } };
    const journal = isolatedJournal();
    try {
      const output = execFileSync('node', [guardScript, '--tool', 'claude'], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...journal.env, HARNESS_CANARY: '1' } });
      expect(JSON.parse(output).hookSpecificOutput.permissionDecision).toBe('ask');
      expect(existsSync(path.join(journal.directory, 'events'))).toBe(false);
    } finally {
      rmSync(journal.directory, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('runs through a symlinked path instead of skipping silently', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'agent-guard-link-'));
    const repository = configuredRepository();
    try {
      const link = path.join(directory, 'guard.mjs');
      symlinkSync(guardScript, link);
      const payload = { ...fixture('claude-pretooluse-bash.json'), cwd: repository, tool_input: { command: 'terraform apply' } };
      const output = execFileSync('node', [link, '--tool', 'claude'], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, HARNESS_JOURNAL_DIR: directory } });
      expect(JSON.parse(output).hookSpecificOutput.permissionDecision).toBe('ask');
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('asks when the guard itself fails on a command that reaches a remote or production', () => {
    const fallbackDeps = { repoRoot: () => '/repo', config: () => CONFIG };
    expect(fallbackVerdict({ command: 'gh pr merge 7' }, new Error('boom'), fallbackDeps).decision).toBe('ask');
    expect(fallbackVerdict({ command: 'cd x && git push' }, new Error('boom'), fallbackDeps).decision).toBe('ask');
    expect(fallbackVerdict({ command: 'terraform apply' }, new Error('boom'), fallbackDeps).decision).toBe('ask');
    expect(fallbackVerdict({ command: 'npx deploy-cli deploy --prod' }, new Error('boom'), fallbackDeps).decision).toBe('ask');
    expect(fallbackVerdict({ command: 'npm test' }, new Error('boom'), fallbackDeps).decision).toBe('pass');
    expect(fallbackVerdict({ command: 'terraform-docs .' }, new Error('boom'), fallbackDeps).decision).toBe('ask');
    // Eighth review: a guard crash in the headless nightly session refuses too.
    expect(nightlyVerdict(fallbackVerdict({ command: 'gh pr merge 7' }, new Error('boom'), fallbackDeps), { HARNESS_NIGHTLY: '1' }).decision).toBe('deny');
    expect(fallbackVerdict(null, new Error('boom'), fallbackDeps).decision).toBe('pass');
  });

  it('still asks for git and gh when the config itself fails to load', () => {
    const broken = { repoRoot: () => '/repo', config: () => { throw new SyntaxError('Unexpected end of JSON input'); } };
    expect(() => evaluate(bash('git push origin feature/x'), deps({ settings: new SyntaxError('Unexpected end of JSON input') }))).toThrow(/JSON/);
    expect(fallbackVerdict({ command: 'git push origin feature/x' }, new Error('config'), broken).decision).toBe('ask');
    expect(fallbackVerdict({ command: 'gh pr merge 7' }, new Error('config'), broken).decision).toBe('ask');
    expect(fallbackVerdict({ command: 'terraform apply' }, new Error('config'), broken).decision).toBe('pass');
    expect(fallbackVerdict({ command: 'ls' }, new Error('config'), broken).decision).toBe('pass');
  });

  it('stays silent for an ordinary command', () => {
    const repository = configuredRepository();
    const payload = { ...fixture('codex-pretooluse-bash.json'), cwd: repository };
    const journal = isolatedJournal();
    try {
      expect(execFileSync('node', [guardScript, '--tool', 'codex'], { input: JSON.stringify(payload), encoding: 'utf8', env: journal.env })).toBe('');
      expect(existsSync(path.join(journal.directory, 'events'))).toBe(false);
    } finally {
      rmSync(journal.directory, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });
});

describe('docs-only direct push to the integration branch (decision 24)', () => {
  const DOCS = ['docs/standards/testing.md', 'docs/records/2026-09-28-assessment-self-healing-decisions.md', 'src/features/search/README.md'];
  const DOCS_REFS = { ...REFS, HEAD };
  const push = (options = {}) => evaluate(bash(`git push origin ${HEAD}:refs/heads/dev`), deps({ transcript: L0, reviews: { [HEAD]: APPROVED }, refs: DOCS_REFS, diff: DOCS, runs: [], ...options }));

  it('passes a documentation-only range with the approval, a fast-forward and no docs check finding, without a CI run', () => {
    const context = deps({ transcript: L0, reviews: { [HEAD]: APPROVED }, refs: DOCS_REFS, diff: DOCS, runs: [] });
    expect(evaluate(bash(`git push origin ${HEAD}:refs/heads/dev`), context).decision).toBe('pass');
    expect(context.calls.some((call) => call[0] === 'run')).toBe(false);
  });

  it('still needs L0, the approval of this session and a fast-forward', () => {
    expect(push({ transcript: L1 }).decision).toBe('deny');
    expect(push({ reviews: {} }).reason).toMatch(/no recorded independent review/);
    expect(push({ ancestor: false }).reason).toMatch(/fast-forward/);
  });

  it('denies unless the pushed commit is checked out on a clean tree', () => {
    expect(push({ refs: { ...DOCS_REFS, HEAD: OLD } }).reason).toMatch(/check out/);
    expect(push({ status: [' M docs/standards/testing.md'] }).reason).toMatch(/uncommitted changes/);
  });

  it('denies on a docs check finding about a pushed file, or when the check cannot run', () => {
    expect(push({ docFindings: ['docs/standards/testing.md: broken link ./missing.md'] }).reason).toMatch(/1 finding/);
    expect(push({ docFindings: new Error('timed out') }).reason).toMatch(/could not run/);
  });

  it('ignores findings the push did not cause', () => {
    expect(push({ docFindings: ['docs/decisions/README.md: broken link ./x.md'] }).decision).toBe('pass');
    expect(push({ diff: ['docs/health.json'], docFindings: ['docs/health.json: guides/README.md content audit expired on 2026-09-23'] }).decision).toBe('pass');
  });

  it.each([
    [['docs/a.md', 'src/app.ts']],
    [['AGENTS.md']],
    [['.agents/levels/L1.md']],
    [['.agents/skills/seo/SKILL.md']],
    [['.claude/agents/reviewer.md']],
    [['.github/pull_request_template.md']],
    [['package.json']],
    [[]],
  ])('keeps the full decision-17 path for %j', (diff) => {
    expect(push({ diff }).reason).toMatch(/workflow_dispatch/);
  });

  it('classifies documentation paths', () => {
    for (const file of ['docs/x.json', 'docs/records/a.md', 'README.md', 'src/features/search/README.md', '.agents/rules/learned/a.md', 'public/notes.md']) expect(isDocumentationPath(file)).toBe(true);
    for (const file of ['CLAUDE.md', 'src/AGENTS.md', '.agents/rules/base.md', '.codex/x.md', '.github/pull_request_template.md', 'src/app.ts', 'package.json']) expect(isDocumentationPath(file)).toBe(false);
  });

  it('keeps the full path for a document that code, a test or a check reads, or when the lookup fails', () => {
    expect(push({ readers: ['src/features/search/readme.test.ts'] }).reason).toMatch(/workflow_dispatch/);
    expect(push({ readers: new Error('git grep failed') }).reason).toMatch(/workflow_dispatch/);
  });

  // Found by the independent review: the loop's review script names the
  // records index, so with the real lookup the admission push always took the
  // CI path and was denied every night. A mocked lookup had hidden it. The
  // repository here is the installed layout: the harness copied to .agents/.
  it('lets the nightly admission through with the real code lookup', () => {
    const repository = mkdtempSync(path.join(tmpdir(), 'agent-guard-lookup-'));
    try {
      cpSync(path.join(repoRoot, 'harness'), path.join(repository, '.agents'), { recursive: true });
      mkdirSync(path.join(repository, 'scripts'));
      writeFileSync(path.join(repository, 'scripts/build-guide.mjs'), "readFileSync('docs/guide.md', 'utf8');\n");
      writeFileSync(path.join(repository, 'scripts/check-docs.mjs'), "// reads docs/guide.md and docs/checked.md\n");
      mkdirSync(path.join(repository, '.agents/healing'), { recursive: true });
      writeFileSync(path.join(repository, '.agents/healing/review-fixture.mjs'), "const INDEX = 'docs/records/index.md';\n");
      execFileSync('git', ['init', '-q'], { cwd: repository });
      execFileSync('git', ['add', '--', '.agents', 'scripts'], { cwd: repository });
      const real = (paths, excluded) => defaultDeps.codeReferences(paths, excluded, repository);
      const admission = ['.agents/rules/learned/keep-node-24.md', 'docs/records/2026-09-28-assessment-self-healing-decisions.md', 'docs/records/index.md'];
      const context = deps({ transcript: L0, reviews: { [HEAD]: APPROVED }, refs: DOCS_REFS, diff: admission, runs: [], env: { HARNESS_NIGHTLY: '1' } });
      context.codeReferences = real;
      expect(evaluate(bash(`git push origin ${HEAD}:refs/heads/dev`), context).decision).toBe('pass');
      expect(real(['docs/guide.md'], [])).toEqual(['scripts/build-guide.mjs', 'scripts/check-docs.mjs']);
      // A document other code reads keeps the CI path; one only the configured
      // docs check reads stays documentation.
      const tooling = deps({ transcript: L0, reviews: { [HEAD]: APPROVED }, refs: DOCS_REFS, diff: ['docs/guide.md'], runs: [] });
      tooling.codeReferences = real;
      expect(evaluate(bash(`git push origin ${HEAD}:refs/heads/dev`), tooling).reason).toMatch(/workflow_dispatch/);
      const onlyTooling = deps({ transcript: L0, reviews: { [HEAD]: APPROVED }, refs: DOCS_REFS, diff: ['docs/checked.md'], runs: [] });
      onlyTooling.codeReferences = real;
      expect(evaluate(bash(`git push origin ${HEAD}:refs/heads/dev`), onlyTooling).decision).toBe('pass');
      expect(real(['docs/checked.md'], [])).toEqual(['scripts/check-docs.mjs']);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  // Sixth review: an ordinary L0 session could push a learned rule as
  // documentation, with no issue the maintainer closed; and nothing stopped the
  // nightly session from merging a pull request.
  it('takes the full path for a learned rule outside the nightly admission, and refuses merges in it', () => {
    expect(push({ diff: ['.agents/rules/learned/keep-node-24.md'] }).reason).toMatch(/workflow_dispatch/);
    const nightly = deps({ transcript: L0, env: { HARNESS_NIGHTLY: '1' } });
    expect(evaluate(bash('gh pr merge 12 --merge'), nightly).decision).toBe('deny');
    expect(evaluate(bash('gh api -X PUT repos/o/r/pulls/12/merge'), nightly).decision).toBe('deny');
  });

  it('confines the nightly admission session to learned rules and decision records', () => {
    const nightly = { env: { HARNESS_NIGHTLY: '1' } };
    expect(push({ ...nightly, diff: ['.agents/rules/learned/keep-node-24.md', 'docs/records/2026-09-28-assessment-self-healing-decisions.md', 'docs/records/index.md'] }).decision).toBe('pass');
    expect(push({ ...nightly, diff: ['docs/standards/testing.md'] }).reason).toMatch(/only learned rules and self-healing decision records/);
    expect(push({ ...nightly, diff: ['src/app.ts'] }).reason).toMatch(/nightly admission session pushes only documentation-only commits/);
  });

  // Seventh review: a rule titled announce-l2-... put its file name in the
  // admission prompt, the transcript read L2, and the push was denied every
  // night. The nightly session is L0 whatever its transcript says, and it has
  // nobody to answer an ask.
  it('holds the nightly admission session at L0 and turns its asks into refusals', () => {
    const L2 = [{ role: 'user', text: 'Level L0: push.\n- .agents/rules/learned/announce-l2-before-grants.md' }, { role: 'assistant', text: 'Level L2: grants.' }];
    const admission = ['.agents/rules/learned/announce-l2-before-grants.md', 'docs/records/2026-09-28-assessment-self-healing-decisions.md', 'docs/records/index.md'];
    expect(push({ transcript: L2, diff: admission }).decision).toBe('deny');
    expect(push({ transcript: L2, diff: admission, env: { HARNESS_NIGHTLY: '1' } }).decision).toBe('pass');
    expect(evaluate(bash('terraform apply'), deps({ transcript: L0 })).decision).toBe('ask');
    const refused = evaluate(bash('terraform apply'), deps({ transcript: L0, env: { HARNESS_NIGHTLY: '1' } }));
    expect(refused.decision).toBe('deny');
    expect(refused.reason).toMatch(/nobody to ask/);
  });

  // Found by the coordinator after seven reviews: nothing stopped an agent
  // from starting a child session with the nightly powers.
  it('refuses any command that sets the loop variables, in every form', () => {
    for (const command of [
      'HARNESS_NIGHTLY=1 claude -p "push it"',
      'export HARNESS_NIGHTLY=1 && claude -p x',
      'HARNESS_NIGHTLY=1; export HARNESS_NIGHTLY; claude -p x',
      'declare -x HARNESS_HEALING=1',
      'typeset -x HARNESS_CANARY=1',
      'set -a; HARNESS_CANARY=1 node x.mjs',
      'env HARNESS_NIGHTLY=1 node scripts/x.mjs',
      'env -i HOME=/h HARNESS_NIGHTLY=1 claude -p x',
      'bash -c "HARNESS_NIGHTLY=1 claude -p x"',
      'HARNESS_NIGHT""LY=1 claude -p x',
      `node -e "process.env.HARNESS_NIGHTLY = '1'; require('child_process').spawnSync('claude')"`,
      `node -e "spawnSync('claude', [], { env: { ...process.env, HARNESS_NIGHTLY: '1' } })"`,
      `python3 -c "import os; os.environ['HARNESS_NIGHTLY']='1'"`,
    ]) expect(evaluate(bash(command), deps({ transcript: L0 })).decision, command).toBe('deny');
    for (const command of ['grep -n "HARNESS_NIGHTLY === \'1\'" .agents/hooks/guard.mjs', 'printenv HARNESS_NIGHTLY', 'echo $HARNESS_HEALING', 'unset HARNESS_CANARY']) expect(evaluate(bash(command), deps({ transcript: L0 })).decision, command).toBe('pass');
  });

  it('runs the configured docs check and treats its script as documentation tooling', () => {
    const context = deps({ transcript: L0, reviews: { [HEAD]: APPROVED }, refs: DOCS_REFS, diff: DOCS, runs: [] });
    expect(evaluate(bash(`git push origin ${HEAD}:refs/heads/dev`), context).decision).toBe('pass');
    expect(context.calls).toContainEqual(['checkDocs', 'node', 'scripts/check-docs.mjs', '--strict']);
    expect(context.calls.find((call) => call[0] === 'codeReferences')).toEqual(['codeReferences', 'docs/', '*.md', '.agents/check.mjs', '.claude/agents/', '.codex/agents/', 'scripts/check-docs.mjs']);
  });

  it('skips the check step when no docs check is configured, and still needs the clean checkout', () => {
    const settings = { docsCheck: null };
    const context = deps({ transcript: L0, reviews: { [HEAD]: APPROVED }, refs: DOCS_REFS, diff: DOCS, runs: [], settings, docFindings: ['docs/standards/testing.md: broken link'] });
    expect(evaluate(bash(`git push origin ${HEAD}:refs/heads/dev`), context).decision).toBe('pass');
    expect(context.calls.some((call) => call[0] === 'checkDocs')).toBe(false);
    expect(push({ settings, refs: { ...DOCS_REFS, HEAD: OLD } }).reason).toMatch(/check out/);
    expect(push({ settings, status: [' M docs/a.md'] }).reason).toMatch(/uncommitted changes/);
  });

  it('confines the nightly admission to the configured records directory', () => {
    const settings = { recordsDirectory: 'handbook/decisions' };
    const nightly = { env: { HARNESS_NIGHTLY: '1' }, settings };
    expect(push({ ...nightly, diff: ['.agents/rules/learned/a.md', 'handbook/decisions/2026-09-28-assessment-self-healing-decisions.md', 'handbook/decisions/index.md'] }).decision).toBe('pass');
    expect(push({ ...nightly, diff: ['docs/records/index.md'] }).reason).toMatch(/only learned rules and self-healing decision records/);
    expect(admissionFiles({ recordsDirectory: 'docs/records/' }).test('docs/records/index.md')).toBe(true);
    expect(admissionFiles({ recordsDirectory: 'docs/records' }).test('docs/recordsXindex.md')).toBe(false);
  });


  it('keeps only the findings on pushed files that time did not cause', () => {
    expect(blockingDocFindings(['a.md: x', 'b.md: y', 'docs/health.json: a.md content audit expired on 2026-01-01'], ['a.md', 'docs/health.json'])).toEqual(['a.md: x']);
  });
});

describe('the agent journal (decision 23)', () => {
  const env = { HOME: '/home/q' };
  const journal = '/home/q/.local/state/agent-journal';
  const run = (command, extra = {}) => decide(command, { env, ...extra });
  const edit = (file, options = {}) => evaluate(normalize({ ...fixture('claude-pretooluse-edit.json'), tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }, 'claude'), deps({ env, ...options })).decision;

  // Found by the independent review: paths after a cd resolved against the
  // starting directory, and git read options that run a program.
  it.each([
    'cd ~/.local/state/agent-journal && rm -rf events',
    'cd /home/q/.local/state/agent-journal && echo x > events/a.jsonl',
    'pushd /home/q/.local/state/agent-journal',
    'git -C /home/q/.local/state/agent-journal grep -nO"sh -c id" x',
    'git -C /home/q/.local/state/agent-journal diff --outp=/tmp/x',
    'git -C /home/q/.local/state/agent-journal log --ext-diff -p',
    'git -C /home/q/.local/state/agent-journal push --force',
    // Third review: paths after a cd to a parent, find from an ancestor, and
    // environment variables that make a git read run a program.
    'cd ~/.local/state && rm -rf agent-journal',
    'cd /home/q/.local && echo x > state/agent-journal/events/a.jsonl',
    'cd /home/q/.local && sed -i "" d state/agent-journal/candidates/c1.json',
    'find /home/q/.local/state -path "*journal/events*" -delete',
    'find /tmp -fprint /home/q/.local/state/agent-journal/events/x.jsonl',
    'GIT_EXTERNAL_DIFF="rm -f" git -C /home/q/.local/state/agent-journal diff',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=x git -C /home/q/.local/state/agent-journal status',
    'export GIT_EXTERNAL_DIFF=x; git -C /home/q/.local/state/agent-journal diff',
    // Fourth review: bare operands once inside the journal.
    'cd ~/.local/state && cd agent-journal && echo x > c1.json',
  ])('denies %s on the journal', (command) => {
    expect(decide(command, { env: { HOME: '/home/q' } })).toBe('deny');
  });

  it('denies writes, moves and removals of the journal', () => {
    expect(edit(`${journal}/events/2026-09.mac.jsonl`)).toBe('deny');
    expect(edit('/tmp/elsewhere/agent-journal/x.json')).toBe('deny');
    expect(edit('/srv/j/events/x.jsonl', { env: { ...env, HARNESS_JOURNAL_DIR: '/srv/j' } })).toBe('deny');
    for (const command of [`echo x >> ${journal}/ledger/2026-09.mac.jsonl`, `rm -rf ${journal}`, 'rm -rf ~/.local/state', `mv ${journal}/state /tmp/s`, `sed -i s/a/b/ ${journal}/state/detect.json`, `find ${journal} -name '*.json' -delete`, 'node .agents/hooks/journal.mjs', 'echo {} | node .agents/hooks/healing.mjs', `git -C ${journal} commit -am x`, `git -C ${journal} reset --hard HEAD~1`]) expect(run(command)).toBe('deny');
  });

  it('lets agents read it and leaves neighbours alone', () => {
    for (const command of [`cat ${journal}/state/detect.json`, `grep -r ci-red ${journal}/events`, `ls ~/.local/state/agent-journal`, 'rm -rf ~/.local/state/other-tool', 'node .agents/healing/ledger.mjs report', 'gh repo view owner/agent-journal --json name', 'node .agents/healing/journal-sync.mjs init', `git -C ${journal} log --oneline -3`, `git -C ${journal} ls-files`, `git -C ${journal} log --format=%h -n 3`]) expect(run(command)).toBe('pass');
    expect(edit('/home/q/.local/state/other/x.json')).toBe('pass');
  });
});

describe('self-healing runs', () => {
  const healing = (command, extra = {}) => decide(command, { env: { HOME: '/home/q', HARNESS_HEALING: '1' } }, extra);

  // A read-only allowlist of shell commands leaked twice in review (awk
  // system(), sort --outp, git grep -nO, gh api -fbody=): a healing run gets
  // no shell at all, only the Read, Grep and Glob tools.
  it.each([
    'cat docs/standards/testing.md',
    'git log --oneline -5',
    'gh issue list --label ci-red',
    "node .agents/healing/candidate.mjs add <<'EOF'\n{\"type\":\"rule\"}\nEOF",
    `awk 'BEGIN{system("gh issue close 12 --reason completed")}'`,
    'sort --outp=x package.json',
    'git grep -nO"sh -c id" hello',
    'gh api repos/o/r/issues/1/comments -fbody=hi',
    'gh auth status --show-token',
    'file -C -m x',
    'true',
  ])('refuses every shell command in a healing run: %s', (command) => {
    expect(healing(command)).toBe('deny');
  });

  it('treats Glob as a search, so a healing run may use it', () => {
    const glob = normalize({ ...fixture('claude-pretooluse-bash.json'), tool_name: 'Glob', tool_input: { pattern: '**/*.md', path: '/repo/docs' } }, 'claude');
    expect(glob).toMatchObject({ kind: 'search', paths: ['/repo/docs'], glob: '**/*.md' });
    expect(evaluate(glob, deps({ env: { HARNESS_HEALING: '1' } })).decision).toBe('pass');
  });

  it('lets a healing run read and search files, except .env files', () => {
    const read = (paths, extra = {}) => evaluate({ kind: 'read', paths, cwd: '/repo', ...extra }, deps({ env: { HARNESS_HEALING: '1' } })).decision;
    expect(read(['/repo/docs/standards/testing.md'])).toBe('pass');
    expect(read(['/repo/.env.local'])).toBe('deny');
    expect(evaluate({ kind: 'search', paths: ['/repo/src'], glob: '*.ts', cwd: '/repo' }, deps({ env: { HARNESS_HEALING: '1' } })).decision).toBe('pass');
    expect(evaluate({ kind: 'fetch', paths: [], cwd: '/repo' }, deps({ env: { HARNESS_HEALING: '1' } })).decision).toBe('deny');
  });

  it('denies edits, and applies to the healer subagent without the environment flag', () => {
    const write = evaluate(normalize({ ...fixture('claude-pretooluse-edit.json'), tool_name: 'Write', tool_input: { file_path: '/repo/docs/x.md', content: 'x' } }, 'claude'), deps({ env: { HARNESS_HEALING: '1' } }));
    expect(write.decision).toBe('deny');
    expect(decide('git commit -m x', {}, { agentType: 'healer' })).toBe('deny');
    expect(decide('git commit -m x', {}, { agentType: 'implementer' })).toBe('pass');
  });
});

describe('indirect restores of harness files', () => {
  it('asks when a hard reset, a stash or a patch rewrites a harness file', () => {
    expect(decide('git reset --hard origin/dev', { lines: { 'diff --name-only origin/dev': ['.agents/hooks/guard.mjs'] } })).toBe('ask');
    expect(decide('git stash pop', { lines: { 'stash show --name-only --include-untracked stash@{0}': ['.agents/manifest.json'] } })).toBe('ask');
    expect(decide('git apply fix.patch', { files: { '/repo/fix.patch': 'diff --git a/.agents/hooks/shell.mjs b/.agents/hooks/shell.mjs\n' } })).toBe('ask');
    expect(decide('git apply < fix.patch', { files: { '/repo/fix.patch': '--- a/.agents/harness.config.json\n+++ b/.agents/harness.config.json\n' } })).toBe('ask');
    expect(decide("git am <<'EOF'\ndiff --git a/.agents/hooks/lib.mjs b/.agents/hooks/lib.mjs\nEOF")).toBe('ask');
  });

  it('asks when the files cannot be listed', () => {
    expect(decide('git reset --hard HEAD~1', { lines: { 'diff --name-only HEAD~1': new Error('bad revision') } })).toBe('ask');
    expect(decide('git apply missing.patch')).toBe('ask');
  });

  it('lets ordinary resets, stashes and patches through', () => {
    expect(decide('git reset --hard origin/dev', { lines: { 'diff --name-only origin/dev': ['src/app.ts'] } })).toBe('pass');
    expect(decide('git reset --soft HEAD~1')).toBe('pass');
    expect(decide('git stash list')).toBe('pass');
    expect(decide('git apply --check fix.patch', { files: { '/repo/fix.patch': 'diff --git a/.agents/hooks/guard.mjs b/.agents/hooks/guard.mjs\n' } })).toBe('pass');
    expect(decide('git apply fix.patch', { files: { '/repo/fix.patch': 'diff --git a/src/a.ts b/src/a.ts\n' } })).toBe('pass');
  });
});

describe('self-healing decision issues', () => {
  it('asks before an agent closes, reopens or relabels a self-healing issue', () => {
    const labelled = { issue: { labels: [{ name: 'self-healing' }, { name: 'needs-human' }] } };
    for (const command of ['gh issue close 12', 'gh issue reopen 12', 'gh issue edit 12 --add-label self-healing:applied', 'gh issue close https://github.com/o/r/issues/12']) expect(decide(command, labelled)).toBe('ask');
    expect(decide('gh issue close 12', { issue: { labels: [{ name: 'self-healing:rule' }] } })).toBe('ask');
    expect(decide('gh issue close 12', { ghError: 'HTTP 502' })).toBe('ask');
  });

  it('lets other issues and read or comment calls through', () => {
    expect(decide('gh issue close 12', { issue: { labels: [{ name: 'ci-red' }] } })).toBe('pass');
    for (const command of ['gh issue list --label self-healing', 'gh issue view 12', 'gh issue comment 12 -b ok', 'gh issue create --title x --body y']) expect(decide(command)).toBe('pass');
  });
});

describe('configured branch names', () => {
  const settings = { branches: { integration: 'develop', release: 'production' }, ci: { workflow: 'checks.yml' } };
  const refs = { ...REFS, 'refs/remotes/origin/develop': OLD };
  const push = (command, options = {}) => evaluate(bash(command), deps({ transcript: L0, reviews: { [HEAD]: APPROVED }, settings, refs, ...options }));

  it('guards the configured branches and leaves the defaults alone', () => {
    expect(push('git push origin production').reason).toMatch(/^No agent pushes directly to production, at any level: a change reaches production only through the develop to production release pull request/);
    expect(push('git push -f origin develop').decision).toBe('deny');
    expect(push('git push --all origin').decision).toBe('deny');
    expect(push('git push', { branch: 'production' }).decision).toBe('deny');
    expect(push('git push origin main').decision).toBe('pass');
    expect(push('git push -f origin dev').decision).toBe('pass');
    expect(push('git -c remote.origin.push=HEAD:refs/heads/x push').reason).toMatch(/checks on develop and production/);
  });

  it('runs the direct push checks against the configured integration branch and workflow', () => {
    const dependencies = deps({ transcript: L0, reviews: { [HEAD]: APPROVED }, settings, refs, runs: [GREEN_RUN] });
    expect(evaluate(bash(`git push origin ${HEAD}:refs/heads/develop`), dependencies).decision).toBe('pass');
    expect(dependencies.calls.find((call) => call[0] === 'run')).toEqual(expect.arrayContaining(['--workflow', 'checks.yml']));
    expect(push(`git push origin ${HEAD}:refs/heads/develop`, { runs: [] }).reason).toMatch(/^Direct push to develop denied: no successful workflow_dispatch run of checks\.yml/);
    expect(push(`git push origin ${HEAD}:refs/heads/develop`, { runs: [{ ...GREEN_RUN, headBranch: 'develop' }] }).decision).toBe('deny');
    expect(push('git push origin HEAD:develop').reason).toMatch(/<40-character sha>:refs\/heads\/develop/);
    expect(push(`git push origin ${HEAD}:refs/heads/develop`, { refs: REFS }).reason).toMatch(/origin\/develop is unknown locally/);
  });
});

describe('guard events', () => {
  it('keys a protection by its standard anchor and first words, without paths or numbers', () => {
    const rule = guardRule('Production confirmation: terraform apply (applies 3 changes). It needs the maintainer. Standard: docs/agent-harness.md#production-confirmations');
    expect(rule).toBe('production-confirmations: production confirmation');
    expect(guardRule('Direct push to dev denied: x. Standard: docs/agent-harness.md#direct-push-to-the-integration-branch')).toBe('direct-push-to-the-integration-branch: direct push to dev denied');
    expect(guardRule('No anchor here.')).toBe('unknown: no anchor here');
    const search = (command) => guardRule(`${command} … searches the repository root recursively and reads .env.local with it. Standard: docs/agent-harness.md#external-action-boundaries`);
    expect(search('grep -rln blog-rss')).toBe(search('grep -rn sitemap'));
  });

  it('records the decision, the rule and a truncated command', () => {
    const event = guardEvent({ command: 'x'.repeat(1000), paths: [], sessionId: 's', tool: 'claude', cwd: '/repo' }, { decision: 'deny', reason: 'No. Standard: docs/agent-harness.md#external-action-boundaries' });
    expect(event).toMatchObject({ kind: 'guard', decision: 'deny', rule: 'external-action-boundaries: no', sessionId: 's' });
    expect(event.command.length).toBeLessThanOrEqual(300);
  });

  it('cites the standard sections of the published harness', () => {
    const anchors = ['sources-and-adapters', 'configuration', 'difficulty-levels', 'independent-review', 'direct-push-to-the-integration-branch', 'production-confirmations', 'external-action-boundaries', 'self-healing-loop', 'safety-nets'];
    const source = readFileSync(guardScript, 'utf8');
    const cited = [...source.matchAll(/Standard: docs\/agent-harness\.md#([\w-]+)/g)].map((match) => match[1]);
    expect(cited.length).toBeGreaterThan(20);
    for (const anchor of cited) expect(anchors, anchor).toContain(anchor);
    expect(source).not.toMatch(/docs\/standards\//);
  });
});

describe('shell unwrapping for the guard', () => {
  it.each([
    ['doas git push origin main', 'deny'],
    ['stdbuf -oL git push origin main', 'deny'],
    ['watch -n 5 git push origin main', 'deny'],
    ['parallel git push origin ::: main', 'deny'],
    ['find . -name x -exec git push origin main \;', 'deny'],
    ['case "$1" in go) git push origin main;; esac', 'deny'],
    ['case "$1" in go) echo ok;; esac', 'pass'],
    ['stdbuf -oL echo hi', 'pass'],
  ])('%s -> %s', (command, expected) => {
    expect(decide(command)).toBe(expected);
  });
});
