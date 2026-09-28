import { ISSUE_LABELS, gh } from './lib.mjs';

// The GitHub side of the self-healing loop (design decision 23). The
// maintainer decides on issues, never in comments or Discussions: each candidate ready for a
// decision becomes an issue labelled `self-healing` and `needs-human`;
// closing it as completed admits it, as not planned rejects it. A decision is
// applied once and then labelled `self-healing:applied`.
// Owned by docs/agent-harness.md#self-healing-loop.

// A marker counts only as the whole last line of the body, where the loop
// writes it: a comment hidden anywhere else in the text is never read.
// Comments the nightly pass writes start with this; they are never read back
// as the maintainer's closing comment.
export const PASS_COMMENT_PREFIX = 'Self-healing pass:';

export const CANDIDATE_MARKER = /^<!-- self-healing-candidate: ([a-z0-9-]+) -->$/;
export const RETIRE_MARKER = /^<!-- self-healing-retire: ([a-z0-9-]+) -->$/;

export function issueMarkers(body) {
  const last = String(body ?? '').replace(/\r\n/g, '\n').trimEnd().split('\n').at(-1);
  return { candidateId: CANDIDATE_MARKER.exec(last)?.[1] ?? null, retireRule: RETIRE_MARKER.exec(last)?.[1] ?? null };
}

const LABEL_SPECS = [
  [ISSUE_LABELS.base, '5319e7', 'Self-healing loop: a candidate or rule decision'],
  [ISSUE_LABELS.rule, 'c5def5', 'Self-healing candidate: a learned rule'],
  [ISSUE_LABELS.skill, 'c5def5', 'Self-healing candidate: a skill change or a new skill'],
  [ISSUE_LABELS.loosening, 'fbca04', 'Self-healing candidate: loosening a protection (exceptional)'],
  [ISSUE_LABELS.retire, 'c5def5', 'Self-healing: retire or keep a learned rule past its review date'],
  [ISSUE_LABELS.applied, 'ededed', 'Self-healing decision already applied'],
];

export function ensureLabels(run = gh) {
  for (const [name, color, description] of LABEL_SPECS) run(['label', 'create', name, '--color', color, '--description', description, '--force']);
}

const quote = (text) => String(text).trim().split('\n').map((line) => `> ${line}`).join('\n');

const proposalHeading = (candidate) => ({ rule: 'Learned rule', skill: candidate?.newSkill ? 'New skill' : 'Skill change', loosening: 'Loosening a protection' })[candidate?.type];

export function candidateIssue(candidate, canaryReport) {
  const what = proposalHeading(candidate);
  const proposal = candidate.type === 'rule' ? candidate.body : candidate.proposal;
  const target = candidate.type === 'skill' ? `\n**Skill:** \`${candidate.skill}\`${candidate.targets?.length ? ` (${candidate.targets.map((file) => `\`${file}\``).join(', ')})` : ''}` : (candidate.type === 'loosening' ? `\n**Protection:** ${candidate.protection} (${candidate.justification})` : '');
  const canaries = canaryReport
    ? `${canaryReport.verdict} on \`${canaryReport.ref}\`: ${canaryReport.results.map((entry) => `${entry.case} ${entry.outcome}`).join(', ')}`
    : 'not run yet: the change runs them before it merges (`node .agents/healing/canary.mjs run --ref HEAD`)';
  return {
    title: `Self-healing ${what.toLowerCase()}: ${candidate.title}`,
    labels: [ISSUE_LABELS.base, ISSUE_LABELS[candidate.type], ISSUE_LABELS.human],
    body: [
      `**Decision for the maintainer.** Close this issue as **completed** to accept it, or as **not planned** to reject it (a one-line comment saying why helps the next proposal).`,
      '',
      `**Why:** ${candidate.why}`,
      `**${what}:**`,
      quote(proposal) + target,
      '',
      `**Evidence:**\n${candidate.evidence.map((item) => `- ${item}`).join('\n')}`,
      `**Lints:** clean`,
      `**Canaries:** ${canaries}`,
      candidate.type === 'rule' ? '\nOnce accepted, the nightly pass adds the rule to `.agents/rules/learned/` with a dated record, reviewed and pushed to the integration branch as documentation (design decision 24).' : '\nOnce accepted, the nightly pass opens an `agent-task` issue to implement it as a normal change, with its canaries.',
      '',
      `<!-- self-healing-candidate: ${candidate.id} -->`,
    ].join('\n'),
  };
}

/**
 * True when the maintainer closed the issue this candidate was published as, and the
 * issue still quotes the text the journal now holds: a rewritten candidate, an
 * issue an agent opened itself, or a candidate never published is not
 * admitted.
 */
const normalized = (text) => String(text ?? '').replace(/\r\n/g, '\n').trimEnd();

// Every field the loop applies (title, why, proposal, evidence, skill,
// targets, protection, justification) is rendered on the issue, so an issue
// rebuilt from the journal's candidate must equal the one the maintainer closed,
// title and body, character for character.
export function matchesIssue(candidate, decision) {
  const proposal = candidate.type === 'rule' ? candidate.body : candidate.proposal;
  if (candidate.status !== 'published' || candidate.issue !== decision.url || typeof proposal !== 'string') return false;
  const expected = candidateIssue(candidate, candidate.canary ?? null);
  return expected.title === String(decision.title ?? '') && normalized(expected.body) === normalized(decision.body) && issueProposal(candidate, decision.body) === proposal.trim();
}

/** Same check for a retire-or-keep issue: it must still show the rule as the file holds it. */
export function matchesRetireIssue(rule, decision) {
  const expected = retireIssue(rule);
  return expected.title === String(decision.title ?? '') && normalized(expected.body) === normalized(decision.body);
}

/** The exact text the issue quotes under its proposal heading, or null. */
export function issueProposal(candidate, body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf(`**${proposalHeading(candidate)}:**`);
  if (start === -1) return null;
  const quoted = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('> ')) break;
    quoted.push(line.slice(2));
  }
  return quoted.length > 0 ? quoted.join('\n') : null;
}

export function createIssue({ title, body, labels }, run = gh) {
  const url = run(['issue', 'create', '--title', title, '--body', body, ...labels.flatMap((label) => ['--label', label])]).trim().split('\n').at(-1);
  return { url, number: Number(/\/issues\/(\d+)/.exec(url)?.[1]) };
}

/** Closed, not yet applied self-healing issues, as decisions. */
export function pendingDecisions(run = gh) {
  // Filtered in the query: applied issues must not crowd out a late decision.
  const issues = JSON.parse(run(['issue', 'list', '--label', ISSUE_LABELS.base, '--state', 'closed', '--search', `-label:"${ISSUE_LABELS.applied}"`, '--limit', '100', '--json', 'number,title,body,labels,stateReason,closedAt,url,comments']));
  return issues
    .filter((issue) => !(issue.labels ?? []).some((label) => label.name === ISSUE_LABELS.applied))
    .map((issue) => ({
      number: issue.number,
      url: issue.url,
      closedAt: issue.closedAt,
      accepted: String(issue.stateReason).toUpperCase() === 'COMPLETED',
      body: issue.body ?? '',
      title: issue.title ?? '',
      ...issueMarkers(issue.body),
      reason: (issue.comments ?? []).map((comment) => String(comment.body ?? '').trim()).filter((body) => body && !body.startsWith(PASS_COMMENT_PREFIX)).at(-1) ?? '',
    }))
    .filter((decision) => decision.candidateId || decision.retireRule)
    // "Fixes #N" in a merged pull request or a pushed commit closes an issue
    // as completed: that is not the maintainer's decision.
    .map((decision) => ({ ...decision, closedByCode: closedByCode(issues.find((issue) => issue.number === decision.number), run) }));
}

// GraphQL names what closed the issue: a merged pull request or a pushed
// commit is code; a person closing it has no closer. The REST closed event
// leaves commit_id empty for a merged pull request, and an open pull request
// that links the issue closed nothing.
const CLOSER_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){timelineItems(itemTypes:CLOSED_EVENT,last:1){nodes{... on ClosedEvent{closer{__typename}}}}}}}';

function closedByCode(issue, run) {
  try {
    const closer = String(run(['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${issue.number}`, '-f', `query=${CLOSER_QUERY}`, '--jq', '.data.repository.issue.timelineItems.nodes[0].closer.__typename // ""'])).trim();
    return closer !== '' && closer !== 'null';
  } catch {
    // Unknown closer: not a decision either.
    return true;
  }
}

/** Reopens an issue that code closed, so the maintainer decides it. */
export function reopenForMaintainer(number, run = gh) {
  run(['issue', 'reopen', String(number), '--comment', `${PASS_COMMENT_PREFIX} closed by a commit or pull request, not by a decision: reopened. Close it yourself as completed to accept, or as not planned to reject.`]);
}

/** Tells the maintainer on the issue what became of their decision. */
export function commentOnDecision(number, text, run = gh) {
  run(['issue', 'comment', String(number), '--body', `${PASS_COMMENT_PREFIX} ${text}`]);
}

/** Learned rules that already have an open retire issue. */
export function openRetireReviews(run = gh) {
  const issues = JSON.parse(run(['issue', 'list', '--label', ISSUE_LABELS.retire, '--state', 'open', '--limit', '100', '--json', 'number,body']));
  return new Set(issues.map((issue) => issueMarkers(issue.body).retireRule).filter(Boolean));
}

export function retireIssue(rule) {
  return {
    title: `Self-healing review: retire the learned rule ${rule.name}?`,
    labels: [ISSUE_LABELS.base, ISSUE_LABELS.retire, ISSUE_LABELS.human],
    body: [
      `**Decision for the maintainer.** The learned rule \`${rule.name}\` reached its review date (${rule.data.reviewAfter}). Close this issue as **completed** to retire it, or as **not planned** to keep it for another 90 days.`,
      '',
      quote(rule.body),
      '',
      `Admitted ${rule.data.admitted} (${rule.data.issue}); record: \`${rule.data.record}\`. A rule that held for a whole period is a candidate to become a lint, hook or test instead (rule into gate).`,
      '',
      `<!-- self-healing-retire: ${rule.name} -->`,
    ].join('\n'),
  };
}

export function workIssue(candidate, decision) {
  return {
    title: `Implement self-healing ${candidate.type === 'skill' ? 'skill change' : 'loosening'}: ${candidate.title}`,
    labels: ['agent-task', ISSUE_LABELS.base, ISSUE_LABELS.applied],
    body: [
      `The maintainer accepted #${decision.number}. Implement it as a normal change at the level its paths require (L2 for a protection), with a pull request.`,
      '',
      quote(candidate.proposal),
      '',
      `Before the pull request is marked ready, run the canaries against the branch: \`node .agents/healing/canary.mjs run --ref HEAD${candidate.type === 'skill' ? ` --skill ${candidate.skill}` : ''}\`, and add a replay case under \`.agents/evals/skills/${candidate.skill ?? '<skill>'}/\` for the failure that triggered it.`,
      '',
      workMarker(candidate.id),
    ].join('\n'),
  };
}

export const workMarker = (id) => `<!-- self-healing-work: ${id} -->`;

/**
 * Recover a handoff even if its work issue has already been closed. The REST
 * issue list reads GitHub's database, where an issue exists as soon as it is
 * created; the search index (and `gh issue list`, which uses it once a label
 * or a query filters it) can lag, and a lagging lookup would open a second
 * work issue after a failed save.
 */
export function findWorkIssue(id, run = gh) {
  const labels = encodeURIComponent(`${ISSUE_LABELS.applied},agent-task`);
  const lines = run(['api', '--paginate', `repos/{owner}/{repo}/issues?state=all&per_page=100&labels=${labels}`, '--jq', '.[] | select(.pull_request == null) | {url: .html_url, body}']);
  const issues = String(lines).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  return issues.find((issue) => normalized(issue.body).split('\n').at(-1) === workMarker(id));
}

export function markApplied(numbers, run = gh) {
  for (const number of numbers) run(['issue', 'edit', String(number), '--add-label', ISSUE_LABELS.applied]);
}
