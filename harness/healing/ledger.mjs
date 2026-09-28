#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSES, effectiveRecords } from '../hooks/healing.mjs';
import { appendRecord, readRecords } from '../hooks/journal.mjs';
import { isoWeek } from './lib.mjs';

// The interpretation ledger report (design decision 13): how often an L1 or
// L2 restatement (`Understood: ...`) was validated by the user's first reply,
// per week, level and tool. The hook classifies replies heuristically; a relabel
// appends a correction instead of rewriting the stream. Usage:
//   node .agents/healing/ledger.mjs report [--weeks 8]
//   node .agents/healing/ledger.mjs relabel <key> <validated|corrected|rejected|unclear>
// Owned by docs/agent-harness.md#self-healing-loop.

export { CLASSES, effectiveRecords };

const week = (at) => isoWeek(new Date(at));

/** Rows of { week, level, tool, validated, corrected, rejected, unclear, rate }; rate ignores unclear replies. */
export function ledgerReport(records) {
  const rows = new Map();
  for (const record of effectiveRecords(records)) {
    const id = `${week(record.at)}|L${record.level ?? '?'}|${record.tool}`;
    const row = rows.get(id) ?? { week: week(record.at), level: `L${record.level ?? '?'}`, tool: record.tool, validated: 0, corrected: 0, rejected: 0, unclear: 0 };
    row[record.class] += 1;
    rows.set(id, row);
  }
  return [...rows.values()]
    .map((row) => {
      const decided = row.validated + row.corrected + row.rejected;
      return { ...row, rate: decided === 0 ? null : row.validated / decided };
    })
    .sort((left, right) => `${left.week}${left.level}${left.tool}`.localeCompare(`${right.week}${right.level}${right.tool}`));
}

export function formatReport(rows) {
  const header = '| Week | Level | Tool | Validated | Corrected | Rejected | Unclear | First-time validation |\n|---|---|---|---|---|---|---|---|';
  const body = rows.map((row) => `| ${row.week} | ${row.level} | ${row.tool} | ${row.validated} | ${row.corrected} | ${row.rejected} | ${row.unclear} | ${row.rate === null ? 'n/a' : `${Math.round(row.rate * 100)}%`} |`);
  return [header, ...body].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'relabel') {
    const [key, label] = rest;
    if (!key || !CLASSES.includes(label)) {
      console.error(`usage: ledger.mjs relabel <key> <${CLASSES.join('|')}>`);
      process.exit(2);
    }
    appendRecord('ledger', { kind: 'relabel', key, class: label });
    console.log(`relabelled ${key} as ${label}`);
  } else {
    const weeks = Number(rest[rest.indexOf('--weeks') + 1]) || 8;
    const since = new Date(Date.now() - weeks * 7 * 24 * 3600 * 1000).toISOString();
    console.log(formatReport(ledgerReport(readRecords('ledger', { since }))));
  }
}
