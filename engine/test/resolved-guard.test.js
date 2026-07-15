// Focused unit tests for the FIX_STAGED -> RESOLVED guard edge cases (task 3.5).
//
// gate() has three layers; this suite targets Step 2, the RESOLVED guard
// (resolvedGuard in engine/core/gate.js). The guard permits the
// FIX_STAGED -> RESOLVED edge ONLY when ALL of these hold, else it fails closed:
//   1. review.md records a PASS whose author DIFFERS from the fix-proposal
//      author (Non_Author_Rule; Requirements 6.3, 6.4),
//   2. that PASS is recorded against the incident's CURRENT fix_version — a
//      stale PASS from an earlier revision is ignored (Requirement 6.3,
//      review-to-fix binding),
//   3. every [HITL] remediation step is cleared (Requirement 8.5).
// Any missing/unreadable artifact or absent metadata line rejects fail-closed.
//
// Structure (mirrors validate.test.js): a single "valid resolvable" base
// fixture — a non-author PASS at the current fix_version with the HITL step
// cleared — that each negative case mutates by exactly ONE thing. This isolates
// the rule under test in every row.
//
// The round-cap edge case (CHANGES_REQUESTED routing at the cap) is listed for
// task 3.5 and pinned lightly below; its exhaustive per-fix_version coverage
// lives in roundcap.test.js (task 3.3) and is deliberately NOT duplicated here.
//
// _Requirements: 6.3, 6.4, 8.5, 12.2_

import test from 'node:test';
import assert from 'node:assert/strict';

import { gate, ROUND_CAP, isRoundCapReached } from '../core/gate.js';

const DASH = '\u2014'; // em dash used before a remediation verify: clause
const INC = 'INC-2024-001';
const FIX_AUTHOR = 'patchwork-sre';
const REVIEWER = 'patchwork-reviewer';
// The base incident sits at fix_version 2 (one completed revision cycle), so a
// stale PASS can be expressed as an earlier "Fix-Version: 1".
const BASE_FIX_VERSION = 2;

// ---------------------------------------------------------------------------
// Artifact factories (fresh strings each call, so table mutations never leak)
// ---------------------------------------------------------------------------

/** Incident frontmatter for a given status + fix_version (all fields present). */
function incidentMd(status, fixVersion) {
  return [
    '---',
    `id: ${INC}`,
    'title: Checkout 500s on coupon stacking',
    `status: ${status}`,
    `fix_version: ${fixVersion}`,
    '---',
  ].join('\n');
}

// The single remediation step in the three clear/uncleared forms the guard
// distinguishes: a checked box is cleared; an unchecked box or a plain
// (checkbox-less) step is uncleared.
const CLEARED_HITL = `- [x] [HITL] Rotate the API key ${DASH} verify: Commander confirms new key deployed`;
const UNCHECKED_HITL = `- [ ] [HITL] Rotate the API key ${DASH} verify: Commander confirms new key deployed`;
const PLAIN_HITL = `- [HITL] Rotate the API key ${DASH} verify: Commander confirms new key deployed`;

/** A fix-proposal.md with an `Author:` line and the given remediation steps. */
function fixProposal(author, steps) {
  return ['# Fix Proposal', `Author: ${author}`, '', ...steps].join('\n');
}

/** A fix-proposal.md that OMITS the `Author:` line (fail-closed case). */
function fixProposalNoAuthor(steps) {
  return ['# Fix Proposal', '', ...steps].join('\n');
}

/** A review.md recording a reviewer, a fix version, and a verdict. */
function reviewMd(reviewer, fixVersion, verdictValue) {
  return [
    `Reviewer: ${reviewer}`,
    `Fix-Version: ${fixVersion}`,
    '',
    '# Review',
    'Adversarial findings go here.',
    `VERDICT: ${verdictValue}`,
  ].join('\n');
}

/**
 * The base "valid resolvable" workspace: a FIX_STAGED incident at fix_version 2
 * with a non-author PASS bound to fix_version 2 and the HITL step cleared.
 * Each negative case below mutates exactly one facet of this.
 */
function validResolvableWorkspace() {
  return {
    incidents: {
      [INC]: {
        'incident.md': incidentMd('FIX_STAGED', BASE_FIX_VERSION),
        'fix-proposal.md': fixProposal(FIX_AUTHOR, [CLEARED_HITL]),
        'review.md': reviewMd(REVIEWER, BASE_FIX_VERSION, 'PASS'),
      },
    },
  };
}

/** Ask the gate about the guarded FIX_STAGED -> RESOLVED edge for our incident. */
function gateToResolved(workspace) {
  return gate(workspace, { incidentId: INC, from: 'FIX_STAGED', to: 'RESOLVED' });
}

/** A gate reason must always be a non-empty, human-readable string. */
function assertNonEmptyReason(result) {
  assert.equal(typeof result.reason, 'string', 'reason must be a string');
  assert.ok(result.reason.trim().length > 0, 'reason must be non-empty');
}

// ---------------------------------------------------------------------------
// The one ALLOWED path: a non-author PASS at the current fix_version, HITL clear
// ---------------------------------------------------------------------------

test('resolved-guard: valid non-author PASS at the current fix_version is ALLOWED', () => {
  const result = gateToResolved(validResolvableWorkspace());
  assert.equal(result.allowed, true, 'a fully satisfied guard must allow RESOLVED');
  assert.match(result.reason, /permitted/);
  assert.match(result.reason, /non-author PASS/);
  assertNonEmptyReason(result);
});

// ---------------------------------------------------------------------------
// Table-driven REJECTIONS: each row mutates the base by exactly one thing
// ---------------------------------------------------------------------------

const rejectionCases = [
  // --- the three core guard conditions ---------------------------------
  {
    name: 'stale PASS (review Fix-Version 1 < incident fix_version 2) is ignored',
    reason: /stale/,
    mutate(ws) {
      ws.incidents[INC]['review.md'] = reviewMd(REVIEWER, 1, 'PASS');
    },
  },
  {
    name: 'self-authored PASS (reviewer === fix author) violates the Non_Author_Rule',
    reason: /self-authored/,
    mutate(ws) {
      // Same handle authored both the fix proposal and the PASS.
      ws.incidents[INC]['review.md'] = reviewMd(FIX_AUTHOR, BASE_FIX_VERSION, 'PASS');
    },
  },
  {
    name: 'uncleared HITL — unchecked [ ] box — blocks RESOLVED despite a valid PASS',
    reason: /HITL/,
    mutate(ws) {
      ws.incidents[INC]['fix-proposal.md'] = fixProposal(FIX_AUTHOR, [UNCHECKED_HITL]);
    },
  },
  {
    name: 'uncleared HITL — plain (checkbox-less) step — blocks RESOLVED despite a valid PASS',
    reason: /HITL/,
    mutate(ws) {
      ws.incidents[INC]['fix-proposal.md'] = fixProposal(FIX_AUTHOR, [PLAIN_HITL]);
    },
  },

  // --- fail-closed paths (missing/unreadable artifact or metadata) ------
  {
    name: 'fail-closed: review.md is missing',
    reason: /review\.md is missing/,
    mutate(ws) {
      delete ws.incidents[INC]['review.md'];
    },
  },
  {
    name: 'fail-closed: review present but NEEDS_WORK',
    reason: /does not record a PASS/,
    mutate(ws) {
      ws.incidents[INC]['review.md'] = reviewMd(REVIEWER, BASE_FIX_VERSION, 'NEEDS_WORK');
    },
  },
  {
    name: 'fail-closed: fix-proposal.md is missing',
    reason: /fix-proposal\.md is missing/,
    mutate(ws) {
      delete ws.incidents[INC]['fix-proposal.md'];
    },
  },
  {
    name: 'fail-closed: fix-proposal.md has no Author: line',
    reason: /"Author:" line/,
    mutate(ws) {
      ws.incidents[INC]['fix-proposal.md'] = fixProposalNoAuthor([CLEARED_HITL]);
    },
  },
  {
    name: 'fail-closed: review.md has no Reviewer: line',
    reason: /"Reviewer:" line/,
    mutate(ws) {
      ws.incidents[INC]['review.md'] = ['Fix-Version: 2', '', 'VERDICT: PASS'].join('\n');
    },
  },
  {
    name: 'fail-closed: review.md has no Fix-Version: line',
    reason: /"Fix-Version:" line/,
    mutate(ws) {
      ws.incidents[INC]['review.md'] = ['Reviewer: patchwork-reviewer', '', 'VERDICT: PASS'].join(
        '\n',
      );
    },
  },
];

for (const { name, reason, mutate } of rejectionCases) {
  test(`resolved-guard: ${name} -> REJECTED`, () => {
    const ws = validResolvableWorkspace();
    mutate(ws);
    const result = gateToResolved(ws);

    assert.equal(result.allowed, false, `expected the guard to reject: ${name}`);
    // Every guard rejection is a RESOLVED-gate rejection...
    assert.match(result.reason, /RESOLVED gate/);
    // ...and carries the specific reason for this row.
    assert.match(result.reason, reason);
    assertNonEmptyReason(result);
  });
}

// Guard against a stale base fixture: the untouched base must itself be
// resolvable (so each rejection above is caused by its one mutation, not by a
// broken baseline).
test('resolved-guard: the base fixture is resolvable before any mutation (sanity)', () => {
  assert.equal(gateToResolved(validResolvableWorkspace()).allowed, true);
});

// ---------------------------------------------------------------------------
// Incident not found (fail-closed on an unresolvable incidentId)
// ---------------------------------------------------------------------------

test('resolved-guard: fail-closed when the incident is not in the workspace snapshot', () => {
  const result = gateToResolved({ incidents: {} });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /RESOLVED gate/);
  assert.match(result.reason, /not found/);
  assertNonEmptyReason(result);
});

// ---------------------------------------------------------------------------
// Round-cap reached routes CHANGES_REQUESTED to PARKED_FOR_HUMAN (task-3.5 item)
// ---------------------------------------------------------------------------
//
// This is one of task 3.5's listed edge cases, so it is pinned here with a
// couple of assertions. The exhaustive per-fix_version routing matrix lives in
// roundcap.test.js (task 3.3) and is intentionally not duplicated.

/** A CHANGES_REQUESTED incident whose fix_version puts it AT the round cap. */
function capReachedWorkspace() {
  // revisionCycleCount = fix_version - 1, so fix_version = ROUND_CAP + 1 gives
  // exactly ROUND_CAP completed cycles.
  return {
    incidents: { [INC]: { 'incident.md': incidentMd('CHANGES_REQUESTED', ROUND_CAP + 1) } },
  };
}

test('resolved-guard (round-cap): at the cap, CHANGES_REQUESTED -> PARKED_FOR_HUMAN is allowed', () => {
  const ws = capReachedWorkspace();
  assert.ok(isRoundCapReached(ws, INC), 'fixture sanity: incident must be at the round cap');

  const parked = gate(ws, { incidentId: INC, from: 'CHANGES_REQUESTED', to: 'PARKED_FOR_HUMAN' });
  assert.equal(parked.allowed, true);
  assert.match(parked.reason, /round-cap/);
  assertNonEmptyReason(parked);
});

test('resolved-guard (round-cap): at the cap, CHANGES_REQUESTED -> INVESTIGATING is rejected', () => {
  const ws = capReachedWorkspace();
  const investigating = gate(ws, {
    incidentId: INC,
    from: 'CHANGES_REQUESTED',
    to: 'INVESTIGATING',
  });
  assert.equal(investigating.allowed, false);
  assert.match(investigating.reason, /round-cap reached/);
  assertNonEmptyReason(investigating);
});
