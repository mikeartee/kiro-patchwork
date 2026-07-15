// Golden-path integration test (task 14.1).
//
// ONE end-to-end test that carries a seeded incident (INC-2024-001) from first
// report all the way to a compiled postmortem.md, driving the load-bearing
// guarantees together (design "Testing Strategy › Golden-path integration
// test"; Requirement 16.4).
//
// ===========================================================================
// HONEST SCOPE — what this test drives, and what it deliberately does NOT
// ===========================================================================
// This exercises the DETERMINISTIC ENGINE (engine/core/{validate,gate,verdict,
// schema,postmortem}.js) against a CONSTRUCTED in-memory workspace snapshot. It
// does NOT invoke the LLM agents (SRE/Reviewer/Scribe) and does NOT touch disk,
// the wall-clock, git, or the network. Agent PROSE is non-deterministic model
// text and is out of scope here by design — its correctness is validated
// indirectly through exactly these deterministic gates (design "Testing
// Strategy › Agent behavior and the demo"): whatever a model writes, an
// incident simply cannot reach RESOLVED through an unreviewed or malformed path.
//
// The grammar and gate logic are NOT re-implemented here — the test reuses the
// engine's own parseBoardEntry / validate / gate / verdict / validatePostmortem
// so it pins the real behaviour, not a paraphrase of it.
//
// The four asserted guarantees (one focused block each, plus one true
// report-to-postmortem walk that ties them together):
//   1. Happy-path walk: REPORTED → INVESTIGATING → ANALYSIS_READY →
//      AWAITING_APPROVAL → APPROVED → FIX_STAGED → RESOLVED, gate() ALLOWED per
//      edge, building the artifact chain + a Board entry per transition + a
//      human HITL-clear audit entry (Req 8.5, 11.4).
//   2. RESOLVED reachability (core): the FIX_STAGED → RESOLVED guard OPENS only
//      with a non-author PASS bound to the current fix_version AND every [HITL]
//      step cleared; breaking exactly one of those three keeps it CLOSED
//      (Req 8.5, 11.4).
//   3. Board completeness/attribution/chronology: every timeline line parses
//      via parseBoardEntry into a well-formed, role-attributed entry (a human
//      Commander + agent roles) in non-decreasing time order (Req 2.5).
//   4. Post-mortem: the compiled postmortem.md references the incident id, root
//      cause, applied fix, and review outcome and links all five source
//      artifacts (validatePostmortem + POSTMORTEM_SOURCE_ARTIFACTS), and the
//      resolution-stage workspace passes validate() with the full artifact set
//      (Req 7.3, 7.4, 1.4).
//
// _Requirements: 16.4, 8.5, 11.4, 2.5, 7.3, 7.4_

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../core/validate.js';
import { gate } from '../core/gate.js';
import { verdict } from '../core/verdict.js';
import { parseBoardEntry, isSchemaError } from '../core/schema.js';
import {
  validatePostmortem,
  POSTMORTEM_SOURCE_ARTIFACTS,
} from '../core/postmortem.js';

const DOT = '\u00B7'; // middle-dot separator between board-entry fields
const DASH = '\u2014'; // em dash used before a remediation verify: clause

const INC = 'INC-2024-001';
const COMMANDER = 'alice';
const SRE = 'patchwork-sre';
const REVIEWER = 'patchwork-reviewer';
const SCRIBE = 'patchwork-scribe';

// Golden/happy path: no NEEDS_WORK revision cycles, so the fix ships at its
// INITIAL fix_version 1 (revisionCycleCount = fix_version - 1 = 0). A review
// bound to any OTHER fix_version is therefore not the current one.
const FIX_VERSION = 1;

const RESOLVED_EDGE = { incidentId: INC, from: 'FIX_STAGED', to: 'RESOLVED' };

// ---------------------------------------------------------------------------
// Artifact factories (fresh strings each call, so per-case mutations never leak)
// ---------------------------------------------------------------------------

/** Incident frontmatter for a given status + fix_version (all fields present). */
function incidentMd(status, fixVersion = FIX_VERSION) {
  return [
    '---',
    `id: ${INC}`,
    'title: Checkout endpoint returns 500 under coupon stacking',
    `status: ${status}`,
    `fix_version: ${fixVersion}`,
    '---',
    '',
    'Seeded incident carried end-to-end from report to a compiled post-mortem.',
  ].join('\n');
}

/** SRE root-cause analysis. */
function analysisMd() {
  return [
    `# Analysis - ${INC}`,
    '',
    'Coupon stacking multiplied discounts instead of adding them, driving the',
    'order total negative and tripping a 500 in /checkout. Introduced by commit',
    'a1b2c3d and reproduced by the sample-app failing test.',
  ].join('\n');
}

// The remediation steps in the two clear-states the gate distinguishes. A HITL
// step is CLEARED only when its task checkbox is checked (`- [x] [HITL] …`); an
// unchecked box (`- [ ] [HITL] …`) is uncleared. The AFK step needs no human.
const AFK_STEP = `- [AFK] Apply the additive-discount patch reverting commit a1b2c3d ${DASH} verify: reproduction test passes`;
const HITL_UNCLEARED = `- [ ] [HITL] Rotate the leaked coupon-service API key ${DASH} verify: Commander confirms new key deployed`;
const HITL_CLEARED = `- [x] [HITL] Rotate the leaked coupon-service API key ${DASH} verify: Commander confirms new key deployed`;

/** A fix-proposal.md with an `Author:` line and the given remediation steps. */
function fixProposal(steps, author = SRE) {
  return [
    `# Fix Proposal - ${INC}`,
    `Author: ${author}`,
    '',
    'Proposed fix with tagged remediation steps.',
    '',
    ...steps,
  ].join('\n');
}

/** A review.md recording a reviewer, the fix version it evaluated, and a verdict. */
function reviewMd(reviewer, fixVersion, verdictValue) {
  return [
    `Reviewer: ${reviewer}`,
    `Fix-Version: ${fixVersion}`,
    '',
    `# Review - ${INC}`,
    'Adversarial findings: the additive-discount fix addresses the null branch',
    'and clamps the order total at zero. No further defects found.',
    `VERDICT: ${verdictValue}`,
  ].join('\n');
}

/** A realistic append-only decision log with a header and two entries. */
function decisionLog() {
  return [
    `# Decision Log - ${INC}`,
    '',
    'Append-only decision log maintained by the Scribe agent.',
    '',
    '## [2024-06-01T14:03Z] Open incident',
    '- Decision: Open INC-2024-001 for the /checkout 500 under coupon stacking.',
    '- Made by: @alice (Incident Commander)',
    '',
    '## [2024-06-01T14:25Z] Approve additive-discount fix',
    '- Decision: Approve the SRE fix after a non-author PASS.',
    '- Made by: @alice (Incident Commander)',
    '',
  ].join('\n');
}

/**
 * A compiled post-mortem matching the exact headings the Scribe prompt / the
 * postmortem validator require: the `# Post-mortem - INC-<id>` title, the
 * `Incident: INC-<id>` identifier line, the three required sections, and a
 * `## Source artifacts` list naming all five sources.
 */
function postmortemMd(incidentId = INC) {
  return [
    `# Post-mortem - ${incidentId}`,
    '',
    `Incident: ${incidentId}`,
    'Status: RESOLVED',
    '',
    '## Summary',
    '',
    'The /checkout endpoint returned 500 under coupon stacking; the additive-',
    'discount fix was reviewed, approved, staged, and the incident resolved.',
    '',
    '## Root cause',
    '',
    'From analysis.md: coupon stacking multiplied discounts instead of adding',
    'them, driving the total negative (commit a1b2c3d).',
    '',
    '## Applied fix',
    '',
    'From fix-proposal.md: switch coupon composition to additive discounts and',
    'clamp the order total at zero.',
    '',
    '## Review outcome',
    '',
    'From review.md: the Reviewer (@patchwork-reviewer) returned a non-author',
    'PASS bound to fix_version 1.',
    '',
    '## Timeline and decisions',
    '',
    'From decision-log.md: opened 14:03Z, approved 14:25Z, resolved 14:40Z.',
    '',
    '## Source artifacts',
    '',
    '- incident.md',
    '- analysis.md',
    '- fix-proposal.md',
    '- review.md',
    '- decision-log.md',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Board: an entry per lifecycle contribution. Times strictly increase so a
// chronological timeline is unambiguous; @who authors are all distinct and the
// roles cover a HUMAN Incident Commander plus AGENT roles (SRE/Reviewer/Scribe).
// ---------------------------------------------------------------------------

const BOARD_ENTRIES = [
  { time: '2024-06-01T14:03Z', who: COMMANDER, role: 'Incident Commander', kind: 'human', type: 'report', desc: '/checkout 500s on coupon stacking' },
  { time: '2024-06-01T14:07Z', who: SRE, role: 'SRE', kind: 'agent', type: 'triage', desc: 'begins investigation from the seeded logs and git history' },
  { time: '2024-06-01T14:12Z', who: SRE, role: 'SRE', kind: 'agent', type: 'analysis', desc: 'root cause traced to commit a1b2c3d; fix proposed' },
  { time: '2024-06-01T14:20Z', who: REVIEWER, role: 'Reviewer', kind: 'agent', type: 'verdict', desc: 'PASS after adversarial review of the additive-discount fix' },
  { time: '2024-06-01T14:25Z', who: COMMANDER, role: 'Incident Commander', kind: 'human', type: 'approval', desc: 'approved the proposed fix' },
  { time: '2024-06-01T14:30Z', who: COMMANDER, role: 'Incident Commander', kind: 'human', type: 'stage', desc: 'staged the fix on a branch' },
  { time: '2024-06-01T14:35Z', who: COMMANDER, role: 'Incident Commander', kind: 'human', type: 'hitl-cleared', desc: 'rotated the leaked coupon-service API key' },
  { time: '2024-06-01T14:40Z', who: SCRIBE, role: 'Scribe', kind: 'agent', type: 'postmortem', desc: 'compiled the post-mortem from the artifact chain' },
];

/** Render a Board entry object as a schema-valid Board_Entry line. */
function boardLine(e) {
  return `[${e.time}] @${e.who} ${DOT} ${e.role} (${e.kind}) ${DOT} ${e.type}: ${e.desc}`;
}

/** The full golden-path Board (header + prose + every lifecycle entry). */
function goldenBoard() {
  return [
    '# Patchwork Board',
    '',
    `Entry format: [time] @who ${DOT} Role (human|agent) ${DOT} type: desc.`,
    '',
    ...BOARD_ENTRIES.map(boardLine),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Workspace factories
// ---------------------------------------------------------------------------

/**
 * The "ready to resolve" FIX_STAGED workspace: the full artifact chain (minus
 * the not-yet-compiled postmortem.md), a non-author PASS bound to the current
 * fix_version, and the HITL step CLEARED. Each RESOLVED-reachability case below
 * mutates exactly one facet of this.
 */
function stagedResolvableWorkspace() {
  return {
    board: goldenBoard(),
    incidents: {
      [INC]: {
        'incident.md': incidentMd('FIX_STAGED'),
        'analysis.md': analysisMd(),
        'fix-proposal.md': fixProposal([AFK_STEP, HITL_CLEARED]),
        'review.md': reviewMd(REVIEWER, FIX_VERSION, 'PASS'),
        'decision-log.md': decisionLog(),
      },
    },
  };
}

/** The end-state RESOLVED workspace holding the complete resolution artifact set. */
function resolvedWorkspace() {
  return {
    board: goldenBoard(),
    incidents: {
      [INC]: {
        'incident.md': incidentMd('RESOLVED'),
        'analysis.md': analysisMd(),
        'fix-proposal.md': fixProposal([AFK_STEP, HITL_CLEARED]),
        'review.md': reviewMd(REVIEWER, FIX_VERSION, 'PASS'),
        'decision-log.md': decisionLog(),
        'postmortem.md': postmortemMd(),
      },
    },
  };
}

// ===========================================================================
// 1. The end-to-end walk: report -> RESOLVED, every gate ALLOWED, chain built
// ===========================================================================

test('golden path: a seeded incident walks REPORTED -> RESOLVED with every gate ALLOWED, building the full artifact chain and Board', () => {
  const boardLines = [
    '# Patchwork Board',
    '',
    `Entry format: [time] @who ${DOT} Role (human|agent) ${DOT} type: desc.`,
    '',
  ];
  const ws = { board: '', incidents: { [INC]: {} } };
  const files = ws.incidents[INC];

  const appendBoard = (entry) => {
    boardLines.push(boardLine(entry));
    ws.board = boardLines.join('\n');
  };
  const setStatus = (status) => {
    files['incident.md'] = incidentMd(status);
  };
  // Assert the gate ALLOWS a transition against the workspace's current
  // (`from`) state, then return the decision so callers can inspect the reason.
  const mustAllow = (from, to) => {
    const d = gate(ws, { incidentId: INC, from, to });
    assert.equal(d.allowed, true, `gate must allow ${from} -> ${to}: ${d.reason}`);
    return d;
  };

  // Stage 0 — /incident: file the symptom (REPORTED) + the report Board entry.
  setStatus('REPORTED');
  appendBoard(BOARD_ENTRIES[0]);

  // REPORTED -> INVESTIGATING: the SRE begins triage.
  mustAllow('REPORTED', 'INVESTIGATING');
  setStatus('INVESTIGATING');
  appendBoard(BOARD_ENTRIES[1]);

  // INVESTIGATING -> ANALYSIS_READY: the SRE writes analysis.md + fix-proposal.md
  // (with an [AFK] step and a still-UNCLEARED [HITL] step) and the Scribe opens
  // the decision log.
  mustAllow('INVESTIGATING', 'ANALYSIS_READY');
  files['analysis.md'] = analysisMd();
  files['fix-proposal.md'] = fixProposal([AFK_STEP, HITL_UNCLEARED]);
  files['decision-log.md'] = decisionLog();
  setStatus('ANALYSIS_READY');
  appendBoard(BOARD_ENTRIES[2]);

  // ANALYSIS_READY -> AWAITING_APPROVAL: the Reviewer records a non-author PASS
  // bound to the current fix_version.
  mustAllow('ANALYSIS_READY', 'AWAITING_APPROVAL');
  files['review.md'] = reviewMd(REVIEWER, FIX_VERSION, 'PASS');
  setStatus('AWAITING_APPROVAL');
  appendBoard(BOARD_ENTRIES[3]);

  // AWAITING_APPROVAL -> APPROVED: the Commander approves.
  mustAllow('AWAITING_APPROVAL', 'APPROVED');
  setStatus('APPROVED');
  appendBoard(BOARD_ENTRIES[4]);

  // APPROVED -> FIX_STAGED: the fix is staged.
  mustAllow('APPROVED', 'FIX_STAGED');
  setStatus('FIX_STAGED');
  appendBoard(BOARD_ENTRIES[5]);

  // While FIX_STAGED, the guarded RESOLVED edge must still be CLOSED because the
  // [HITL] step is uncleared — even though a non-author PASS already exists. This
  // is the guardrail's fail-closed HITL requirement (Req 8.5, 11.4).
  const preClear = gate(ws, RESOLVED_EDGE);
  assert.equal(preClear.allowed, false, 'RESOLVED must be closed while a [HITL] step is uncleared');
  assert.match(preClear.reason, /RESOLVED gate/);
  assert.match(preClear.reason, /HITL/);

  // /human-itl: the Commander performs and clears the [HITL] step (checkbox
  // flipped to [x]) and appends an audit Board entry attributed to the Commander
  // (Req 8.4).
  files['fix-proposal.md'] = fixProposal([AFK_STEP, HITL_CLEARED]);
  appendBoard(BOARD_ENTRIES[6]);

  // FIX_STAGED -> RESOLVED: the guard is now fully satisfied and OPENS.
  const resolved = mustAllow('FIX_STAGED', 'RESOLVED');
  assert.match(resolved.reason, /non-author PASS/);
  assert.match(resolved.reason, /HITL cleared/);
  setStatus('RESOLVED');
  // The Scribe compiles the post-mortem now that the incident is resolved.
  files['postmortem.md'] = postmortemMd();
  appendBoard(BOARD_ENTRIES[7]);

  // The end state is a schema-valid resolution-stage workspace with the FULL
  // artifact set (Requirements 1.4, 16.4).
  const result = validate(ws);
  assert.equal(result.ok, true, `resolved workspace must validate cleanly: ${JSON.stringify(result.problems)}`);
  assert.deepEqual(result.problems, []);

  // And the compiled post-mortem is structurally valid + links the whole chain.
  assert.equal(validatePostmortem(files['postmortem.md'], { incidentId: INC }).ok, true);
});

// ===========================================================================
// 2. RESOLVED reachability (core): opens only via a non-author PASS bound to the
//    current fix_version with all HITL cleared; break exactly one -> stays CLOSED
// ===========================================================================

test('RESOLVED reachability: verdict.js confirms the review is a non-author PASS bound to the current fix_version', () => {
  // Reuse verdict.js (not a re-implementation) to pin the three facts the guard
  // depends on: PASS, a reviewer distinct from the fix author, at fix_version 1.
  const review = verdict(reviewMd(REVIEWER, FIX_VERSION, 'PASS'));
  assert.equal(review.verdict, 'PASS');
  assert.equal(review.author, REVIEWER);
  assert.equal(review.fixVersion, FIX_VERSION);
  assert.notEqual(review.author, SRE, 'the PASS must be authored by someone other than the fix author');
});

test('RESOLVED reachability: the guard OPENS with a non-author PASS bound to the current fix_version and all HITL cleared', () => {
  const decision = gate(stagedResolvableWorkspace(), RESOLVED_EDGE);
  assert.equal(decision.allowed, true, `base must open: ${decision.reason}`);
  assert.match(decision.reason, /permitted/);
  assert.match(decision.reason, /non-author PASS/);
});

// Each row removes/breaks EXACTLY ONE of the three RESOLVED conditions.
const closedCases = [
  {
    condition: 'non-author PASS exists',
    name: 'a self-authored PASS (reviewer === fix author) is not a non-author PASS',
    reason: /self-authored/,
    mutate(ws) {
      ws.incidents[INC]['review.md'] = reviewMd(SRE, FIX_VERSION, 'PASS');
    },
  },
  {
    condition: 'bound to the current fix_version',
    // The engine labels ANY fix-version mismatch as "stale" in its reason; here
    // the PASS is recorded against a DIFFERENT (non-current) fix_version.
    name: 'a PASS recorded against a non-current fix_version is not counted (review-to-fix binding)',
    reason: /stale|fix_version/,
    mutate(ws) {
      ws.incidents[INC]['review.md'] = reviewMd(REVIEWER, FIX_VERSION + 1, 'PASS');
    },
  },
  {
    condition: 'every [HITL] step cleared',
    name: 'an uncleared [HITL] step blocks RESOLVED despite a valid non-author PASS',
    reason: /HITL/,
    mutate(ws) {
      ws.incidents[INC]['fix-proposal.md'] = fixProposal([AFK_STEP, HITL_UNCLEARED]);
    },
  },
];

for (const { condition, name, reason, mutate } of closedCases) {
  test(`RESOLVED reachability: breaking "${condition}" keeps the gate CLOSED — ${name}`, () => {
    const ws = stagedResolvableWorkspace();
    mutate(ws);
    const d = gate(ws, RESOLVED_EDGE);

    assert.equal(d.allowed, false, `expected the gate to stay closed when breaking: ${condition}`);
    assert.match(d.reason, /RESOLVED gate/);
    assert.match(d.reason, reason);
  });
}

test('RESOLVED reachability: removing any one of the three conditions keeps it CLOSED; the base OPENS', () => {
  assert.equal(gate(stagedResolvableWorkspace(), RESOLVED_EDGE).allowed, true, 'the untouched base must open');
  for (const { condition, mutate } of closedCases) {
    const ws = stagedResolvableWorkspace();
    mutate(ws);
    assert.equal(gate(ws, RESOLVED_EDGE).allowed, false, `removing "${condition}" must keep RESOLVED closed`);
  }
});

// ===========================================================================
// 3. Board completeness / attribution / chronology (Req 2.5)
// ===========================================================================

test('Board (Req 2.5): every timeline entry is well-formed, role-attributed, and in non-decreasing chronological order', () => {
  const board = goldenBoard();

  // Timeline lines are those whose first non-whitespace char is "[" (mirrors
  // validate()'s isBoardTimelineLine); header/prose lines are skipped.
  const lines = board
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('['));

  assert.equal(lines.length, BOARD_ENTRIES.length, 'every lifecycle contribution must appear on the Board');

  // Well-formed: every line parses via the ENGINE's parseBoardEntry (Req 2.2/2.4).
  const parsed = lines.map((line) => {
    const entry = parseBoardEntry(line);
    assert.ok(!isSchemaError(entry), `Board entry must be well-formed: ${line}`);
    return entry;
  });

  // Attribution: a human Incident Commander plus two or more agent roles appear.
  const kinds = new Set(parsed.map((e) => e.kind));
  assert.ok(kinds.has('human'), 'a human contributor must appear');
  assert.ok(kinds.has('agent'), 'at least one agent contributor must appear');
  assert.ok(
    parsed.some((e) => e.role === 'Incident Commander' && e.kind === 'human'),
    'the human Incident Commander must be attributed on the Board',
  );
  const agentRoles = new Set(parsed.filter((e) => e.kind === 'agent').map((e) => e.role));
  assert.ok(agentRoles.size >= 2, `two or more agent roles must appear, saw: ${[...agentRoles].join(', ')}`);

  // Chronology: non-decreasing timestamps (ISO-8601 strings sort lexically).
  const times = parsed.map((e) => e.time);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i - 1] <= times[i], `Board must be chronological: ${times[i - 1]} then ${times[i]}`);
  }

  // The Board is also well-formed per the engine's own validator.
  assert.equal(
    validate({ board, incidents: {} }).ok,
    true,
    'the golden-path Board must pass validate()',
  );
});

// ===========================================================================
// 4. Post-mortem (Req 7.3/7.4) + full-set resolution workspace (Req 1.4/16.4)
// ===========================================================================

test('Post-mortem (Req 7.3/7.4): references the incident id, root cause, applied fix, review outcome, and links all five source artifacts', () => {
  const text = postmortemMd();

  // Structural validity: title + identifier + the three required sections
  // (Root cause / Applied fix / Review outcome), pinned to this incident.
  const result = validatePostmortem(text, { incidentId: INC });
  assert.equal(result.ok, true, `post-mortem must validate: ${JSON.stringify(result.problems)}`);
  assert.deepEqual(result.problems, []);

  // Explicitly references the incident id (Req 7.4).
  assert.ok(text.includes(INC), 'post-mortem must reference the incident id');

  // Links every source artifact it was compiled from (Req 7.3).
  for (const artifact of POSTMORTEM_SOURCE_ARTIFACTS) {
    assert.ok(text.includes(artifact), `post-mortem must link the source artifact ${artifact}`);
  }
});

test('Post-mortem (Req 1.4/16.4): a resolution-stage workspace with the full artifact set passes validate()', () => {
  const result = validate(resolvedWorkspace());
  assert.equal(result.ok, true, `resolution-stage workspace must validate: ${JSON.stringify(result.problems)}`);
  assert.deepEqual(result.problems, []);
});

// ===========================================================================
// Consistency: the fully-cleared `- [x] [HITL]` workspace that OPENS RESOLVED
// also passes validate() cleanly. validate() and gate() were made consistent so
// a checked-checkbox HITL step is NOT misreported as remediation.tag.missing.
// ===========================================================================

test('consistency: the fully-cleared workspace that opens RESOLVED also passes validate() cleanly (no remediation.tag.missing)', () => {
  const ws = stagedResolvableWorkspace(); // HITL cleared, non-author PASS at current fix_version

  // Gate OPENS...
  assert.equal(gate(ws, RESOLVED_EDGE).allowed, true, 'the fully-cleared workspace must open RESOLVED');

  // ...and validate() AGREES on the very same snapshot: a `- [x] [HITL]` step is
  // not misreported as missing its tag, and there are no problems at all.
  const result = validate(ws);
  assert.ok(
    !result.problems.some((p) => p.rule === 'remediation.tag.missing'),
    `a "- [x] [HITL]" step must not be reported as remediation.tag.missing, got: ${JSON.stringify(result.problems)}`,
  );
  assert.equal(result.ok, true, `cleared workspace must validate cleanly: ${JSON.stringify(result.problems)}`);
});
