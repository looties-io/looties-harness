#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCandidate, setStatus } from './candidate.mjs';
import { readDocument } from '../hooks/journal.mjs';
import { markApplied, matchesIssue, matchesRetireIssue, pendingDecisions } from './github.mjs';
import { LEARNED_DIRECTORY, LIMITS, addDays, harnessConfig, isoDate, parseFrontmatter, repoRoot, slug } from './lib.mjs';
import { existingGuidance, forbiddenPathReasons, hiddenTextReasons, learnedRuleFiles, looseningReasons, ruleTextReasons } from './lint.mjs';

// Applies the maintainer's decisions (design decision 5): every candidate
// admitted or rejected and every learned rule retired or kept gets a line in
// a dated record under the config's `recordsDirectory`, and an admitted rule
// becomes a file in .agents/rules/learned/. The output is documentation only,
// so the nightly pass commits it in its worktree and pushes it to the
// integration branch under design decision 24 after an independent review. GitHub is only read here; issues are labelled once the push lands.
// Usage:
//   node .agents/healing/review.mjs apply --worktree <path>   (prints JSON)
//   node .agents/healing/review.mjs mark-applied <number>...
//   node .agents/healing/review.mjs due
// Owned by docs/agent-harness.md#self-healing-loop.

// The standard the records link to, as installed in every repository.
const STANDARD = 'docs/agent-harness.md';

/** The records directory of the repository at `root` (`recordsDirectory` in the config), without a trailing slash. */
export function recordsDirectory(root = repoRoot) {
  return path.posix.normalize(String(harnessConfig(root).recordsDirectory || 'docs/records')).replace(/\/+$/, '');
}

export const recordPath = (date, root = repoRoot) => `${recordsDirectory(root)}/${date}-assessment-self-healing-decisions.md`;

// Relative link from the records directory to the standard, whatever its depth.
const standardLink = (root) => path.posix.relative(recordsDirectory(root), STANDARD);

function recordHeader(date, root) {
  return [
    '---',
    'doc_type: assessment',
    'status: complete',
    `created: ${date}`,
    `current_document: ${standardLink(root)}`,
    '---',
    '',
    `# Self-Healing Decisions of ${date}`,
    '',
    `Written by the nightly self-healing pass from the issues the maintainer closed ([the loop](${standardLink(root)}#self-healing-loop)). An admitted rule lives in \`.agents/rules/learned/\`; this record keeps why it was admitted, rejected or retired.`,
    '',
  ].join('\n');
}

const indexParagraph = (date, root) => `The [self-healing decisions of ${date}](./${path.basename(recordPath(date, root))}) record which candidate rules, skill changes and loosening proposals the maintainer admitted or rejected on their issues that day, and which learned rules were retired or kept past their review date.`;

export function learnedRuleText(candidate, { name, date, issueUrl, root = repoRoot }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${candidate.title.replace(/\n/g, ' ')}`,
    `admitted: ${date}`,
    `reviewAfter: ${isoDate(addDays(new Date(`${date}T00:00:00Z`), LIMITS.reviewMaxDays))}`,
    `issue: ${issueUrl}`,
    `record: ${recordPath(date, root)}`,
    'evidence:',
    ...candidate.evidence.map((item) => `  - ${item}`),
    '---',
    '',
    candidate.body.trim(),
    '',
  ].join('\n');
}

// A name free on disk and in this batch's pending writes.
function uniqueName(root, base, writes) {
  let name = base;
  for (let suffix = 2; existsSync(path.join(root, LEARNED_DIRECTORY, `${name}.md`)) || writes.has(`${LEARNED_DIRECTORY}/${name}.md`); suffix += 1) name = `${base}-${suffix}`;
  return name;
}

const firstLine = (text) => String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 300) ?? '';

/**
 * Pure planning over the worktree: returns the files to write or remove, the
 * record entries and the issue numbers applied. `decisions` come from
 * pendingDecisions(); `candidates` maps id to candidate.
 */
export function planDecisions(decisions, { root, candidates, date, retireIssues = {} }) {
  const writes = new Map();
  const removals = [];
  const entries = [];
  const applied = [];
  const workItems = [];
  const statusChanges = [];
  let active = learnedRuleFiles(root).length;
  let learnedBytes = learnedRuleFiles(root).reduce((sum, rule) => sum + Buffer.byteLength(rule.body), 0);
  for (const decision of decisions) {
    // Code closed it (Fixes #N): not a decision; the pass reopens it.
    if (decision.closedByCode) continue;
    // The closing comment is recorded only when it hides nothing.
    const reason = hiddenTextReasons(firstLine(decision.reason)).length > 0 ? '' : firstLine(decision.reason);
    if (decision.retireRule) {
      const rule = learnedRuleFiles(root).find((entry) => entry.name === decision.retireRule);
      applied.push(decision.number);
      if (!rule) {
        entries.push(`- **${decision.retireRule}** ([#${decision.number}](${decision.url})): already gone from \`${LEARNED_DIRECTORY}\`; nothing to do.`);
        continue;
      }
      // Only the retire-or-keep issue the loop opened for this rule decides it.
      if (retireIssues[rule.name] !== decision.url || !matchesRetireIssue(rule, decision)) {
        entries.push(`- [#${decision.number}](${decision.url}) names \`${rule.name}\` but is not the retire-or-keep issue the loop opened for it, or the rule changed since; ignored.`);
        continue;
      }
      if (decision.accepted) {
        removals.push(rule.file);
        active -= 1;
        learnedBytes -= Buffer.byteLength(rule.body);
        entries.push(`- **Retired** \`${rule.name}\` ([#${decision.number}](${decision.url})), admitted ${rule.data?.admitted}.${reason ? ` Closing comment: "${reason}"` : ''}`);
      } else {
        const text = readFileSync(path.join(root, rule.file), 'utf8');
        const next = isoDate(addDays(new Date(`${date}T00:00:00Z`), LIMITS.reviewMaxDays));
        const renewed = /^renewed:.*$/m.test(text) ? text.replace(/^renewed:.*$/m, `renewed: ${date}`) : text.replace(/^(reviewAfter:.*)$/m, `$1\nrenewed: ${date}`);
        writes.set(rule.file, renewed.replace(/^reviewAfter:.*$/m, `reviewAfter: ${next}`));
        entries.push(`- **Kept** \`${rule.name}\` ([#${decision.number}](${decision.url})) until its next review on ${next}.${reason ? ` Closing comment: "${reason}"` : ''}`);
      }
      continue;
    }
    const candidate = candidates.get(decision.candidateId);
    applied.push(decision.number);
    if (!candidate) {
      entries.push(`- Candidate \`${decision.candidateId}\` ([#${decision.number}](${decision.url})) is missing from the agent journal; ${decision.accepted ? 'admission skipped, propose it again' : 'rejection noted'}.`);
      continue;
    }
    if (candidate.issue !== decision.url) {
      entries.push(`- [#${decision.number}](${decision.url}) names candidate \`${candidate.id}\`, which was published as another issue; ignored.`);
      continue;
    }
    if (!decision.accepted) {
      statusChanges.push([candidate, 'rejected', reason]);
      entries.push(`- **Rejected** ${candidate.type} candidate "${candidate.title}" ([#${decision.number}](${decision.url})).${reason ? ` Closing comment: "${reason}"` : ''} Why it was proposed: ${candidate.why}`);
      continue;
    }
    if (!matchesIssue(candidate, decision)) {
      entries.push(`- **Accepted but not admitted**: "${candidate.title}" ([#${decision.number}](${decision.url})) does not match the issue the maintainer closed (status ${candidate.status}, or its text differs from the issue); propose it again.`);
      continue;
    }
    if (candidate.type !== 'rule') {
      statusChanges.push([candidate, 'admitted', reason]);
      workItems.push({ candidate, decision });
      entries.push(`- **Accepted** ${candidate.type} candidate "${candidate.title}" ([#${decision.number}](${decision.url})); an \`agent-task\` issue carries the implementation as a normal change.${reason ? ` Closing comment: "${reason}"` : ''}`);
      continue;
    }
    // The rule is linted again against today's guidance: another rule may
    // have been admitted since the candidate was drafted.
    const blocked = [
      ...(active >= LIMITS.activeRules ? [`the ${LIMITS.activeRules}-rule cap is reached`] : []),
      ...(learnedBytes + Buffer.byteLength(candidate.body.trim()) > LIMITS.learnedTotalBytes ? [`the ${LIMITS.learnedTotalBytes}-byte budget of learned rules would be exceeded`] : []),
      ...hiddenTextReasons(`${candidate.title}\n${candidate.why}\n${candidate.body}\n${candidate.evidence.join('\n')}`),
      ...looseningReasons(candidate.title).map((why) => `title ${why}`),
      ...forbiddenPathReasons(candidate.title, root).map((why) => `title ${why}`),
      ...ruleTextReasons(candidate.body, [...existingGuidance(root), ...[...writes].filter(([file]) => file.startsWith(LEARNED_DIRECTORY)).map(([file, text]) => ({ source: file, text: text.split('\n---\n').at(-1) }))], root),
    ];
    if (blocked.length > 0) {
      statusChanges.push([candidate, 'lint-failed', blocked.join('; ')]);
      entries.push(`- **Accepted but not admitted**: "${candidate.title}" ([#${decision.number}](${decision.url})) no longer passes the lints: ${blocked.join('; ')}.`);
      continue;
    }
    const name = uniqueName(root, slug(candidate.title), writes);
    const file = `${LEARNED_DIRECTORY}/${name}.md`;
    const text = learnedRuleText(candidate, { name, date, issueUrl: decision.url, root });
    // Read the file back: its body must be exactly the text the issue quoted,
    // and its frontmatter exactly the fields written, so no field can carry
    // rule text the maintainer did not see.
    const parsed = parseFrontmatter(text);
    if (parsed.body.trim() !== candidate.body.trim() || JSON.stringify(parsed.data?.evidence) !== JSON.stringify(candidate.evidence) || Object.keys(parsed.data ?? {}).length !== 7) {
      entries.push(`- **Accepted but not admitted**: "${candidate.title.replace(/\s+/g, ' ')}" ([#${decision.number}](${decision.url})): the rule file would not hold exactly the text of the issue.`);
      continue;
    }
    writes.set(file, text);
    active += 1;
    learnedBytes += Buffer.byteLength(candidate.body.trim());
    statusChanges.push([candidate, 'applied', file]);
    entries.push(`- **Admitted** \`${name}\` ([#${decision.number}](${decision.url})): ${candidate.body.replace(/\n+/g, ' ')} Why: ${candidate.why} Evidence: ${candidate.evidence.join(', ')}.${reason ? ` Closing comment: "${reason}"` : ''}`);
  }
  if (entries.length > 0) {
    const record = recordPath(date, root);
    const existing = existsSync(path.join(root, record)) ? readFileSync(path.join(root, record), 'utf8') : recordHeader(date, root);
    writes.set(record, `${existing.trimEnd()}\n${existing.includes('\n- ') ? '' : '\n'}${entries.join('\n')}\n`);
    // A records index is optional: when the directory keeps one, the new
    // record is listed first under its heading, else at its end.
    const indexFile = `${recordsDirectory(root)}/index.md`;
    const index = existsSync(path.join(root, indexFile)) ? readFileSync(path.join(root, indexFile), 'utf8') : null;
    if (index !== null && !index.includes(path.basename(record))) {
      const heading = /^# [^\n]*\n\n/.exec(index);
      writes.set(indexFile, heading ? `${heading[0]}${indexParagraph(date, root)}\n\n${index.slice(heading[0].length)}` : `${index.trimEnd()}\n\n${indexParagraph(date, root)}\n`);
    }
  }
  // The maintainer hears on the issue itself when their decision was not carried out as they closed it.
  const notices = entries.filter((entry) => /Accepted but not admitted|; ignored\.|admission skipped/.test(entry)).map((entry) => ({ number: Number(/\[#(\d+)\]\(/.exec(entry)?.[1]), text: entry.replace(/^- /, '') })).filter((notice) => Number.isInteger(notice.number));
  // Rules whose retire-or-keep issue this plan settles: once it lands, the
  // same night must not ask about them again from the pass's stale checkout.
  const decidedRules = decisions.filter((decision) => decision.retireRule && !decision.closedByCode).map((decision) => decision.retireRule);
  return { writes, removals, entries, applied, workItems, statusChanges, notices, decidedRules };
}

export function applyPlan(plan, root) {
  for (const [file, text] of plan.writes) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  for (const file of plan.removals) rmSync(path.join(root, file));
  return [...plan.writes.keys(), ...plan.removals].sort();
}

/** Learned rules whose review date has passed. */
export function dueRules(root = repoRoot, today = new Date()) {
  return learnedRuleFiles(root).filter((rule) => rule.data?.reviewAfter && rule.data.reviewAfter <= isoDate(today));
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'apply') {
    const root = path.resolve(option('--worktree') ?? repoRoot);
    const decisions = pendingDecisions();
    const candidates = new Map(decisions.filter((decision) => decision.candidateId).map((decision) => [decision.candidateId, loadCandidate(decision.candidateId)]).filter(([, candidate]) => candidate));
    const plan = planDecisions(decisions, { root, candidates, date: isoDate(), retireIssues: readDocument('state/retire-issues.json') ?? {} });
    const files = applyPlan(plan, root);
    for (const [candidate, status, note] of plan.statusChanges) setStatus(candidate, status, note ? { note } : {});
    console.log(JSON.stringify({ files, applied: plan.applied, work: plan.workItems.map(({ candidate, decision }) => ({ candidateId: candidate.id, issue: decision.number })) }));
  } else if (command === 'mark-applied') {
    markApplied(rest.map(Number).filter(Number.isInteger));
  } else if (command === 'due') {
    for (const rule of dueRules()) console.log(`${rule.data.reviewAfter}\t${rule.name}`);
  } else {
    console.error('usage: review.mjs apply --worktree <path> | mark-applied <number>... | due');
    process.exit(2);
  }
}
