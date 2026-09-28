#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isEntrypoint, readStdin } from './lib.mjs';
import { VERDICT_LINE, recordReview, stampRoot } from './stamps.mjs';

// Review-stamp hook (SubagentStop, Claude only). When a `reviewer` subagent
// finishes with a verdict line, it records that verdict for the commit and the
// session that spawned the reviewer: the approval an L0 merge or direct push
// to the integration branch needs from that same session (design decision
// 19). Owned by docs/agent-harness.md#independent-review.
//
// Verified against Claude Code 2.1.283: the SubagentStop payload carries
// `agent_type`, `agent_id` and `last_assistant_message`.

function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      const text = typeof content === 'string' ? content : (content ?? []).filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
      if (text) return text;
    }
  } catch {
    // An unreadable transcript records nothing.
  }
  return '';
}

/** The review record a SubagentStop payload proves, or null. */
export function reviewRecord(payload, now = new Date()) {
  if (payload?.hook_event_name !== 'SubagentStop' || payload?.agent_type !== 'reviewer') return null;
  const text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : lastAssistantText(payload.agent_transcript_path);
  // The last verdict line is the conclusion; earlier ones may quote an old verdict.
  const match = [...text.matchAll(new RegExp(VERDICT_LINE.source, 'gm'))].at(-1);
  if (!match) return null;
  return { sha: match[2], verdict: match[1], agentId: String(payload.agent_id ?? ''), sessionId: String(payload.session_id ?? ''), at: now.toISOString() };
}

if (isEntrypoint(import.meta.url)) {
  try {
    const payload = readStdin();
    const record = reviewRecord(payload);
    if (record) recordReview(stampRoot(payload.cwd || process.cwd()), record);
  } catch (error) {
    // A failed stamp only means the push will be denied; never block the session.
    process.stderr.write(`review stamp error: ${error?.stack ?? error}\n`);
  }
}
