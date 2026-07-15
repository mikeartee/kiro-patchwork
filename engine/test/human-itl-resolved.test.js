// Task 10.2 — "RESOLVED opens only after HITL cleared + PASS".
//
// This suite exercises the engine (gate + validate) against a constructed
// workspace that models the /human-itl flow (task 10.1): the Incident Commander
// clears each `[HITL]` remediation step by rewriting it to the CHECKED task
// checkbox form `- [x] [HITL] …`, and appends an audit Board_Entry per cleared
// step. It asserts the load-bearing guarantee that the FIX_STAGED → RESOLVED
// gate stays CLOSED until BOTH of these hold together, then OPENS:
//   • every `[HITL]` step is cleared (Requirements 8.5, 9.3), AND
//   • a non-author PASS is recorded at the incident's CURRENT fix_version
//     (Requirements 6.3, 6.4).
// Removing any single one of those conditions keeps the gate closed.
//
// Distinct from resolved-guard.test.js (task 3.5, single-HITL guard edge cases),
// this suite focuses on the /human-itl behaviour: MULTIPLE HITL steps cleared
// incrementally, the audit Board_Entry attributed to the Commander (Req 8.4),
// and the consistency guarantee that a validly-cleared `- [x] [HITL]` workspace
// is ALSO schema-valid — i.e. validate() and gate() agree on the same cleared
// workspace rather than validate() misreporting the checkbox step.
//
// _Requirements: 8.4, 8.5, 9.3_

import test from 'node:test';
import assert from 'node:assert/strict';

import { gate } from '../core/gate.js';
import { validate } from '../core/validate.js';

const DOT = '\u00B7'; // middle-dot separator used in board entries
const DASH = '\u2014'; // em dash used before a remediation verify: clause
const INC = 'INC-2024-050';
const COMMANDER = 'alice';
const FIX_AUTHOR = 'patchwork-sre';
const REVIEWER = 'patchwork-reviewer';
// The incident sits at fix_version 2 (one completed revision cycle), so a stale
// PASS can be expressed as an earlier "Fix-Version: 1".
const CURRENT_FIX_VERSION = 2;

// ---------------------------------------------------------------------------
// Remediation steps: one AFK plus two HITL steps in cleared / uncleared forms.
// A HITL step is CLEARED only when its task checkbox is checked (`- [x] …`);
// an unchecked box (`- [ ] …`) is uncleared. This mirrors the /human-itl marker.
// ---------------------------------------------------------------------------

const AFK_STEP = `- [AFK] Revert commit a1b2c3d on a fix branch ${DASH} verify: reproduction test passes`;

const HITL_1_CLEARED = `- [x] [HITL] Rotate the leaked API key ${DASH} verify: Commander confirms new key deployed`;
const HITL_1_UNCLEARED = `- [ ] [HITL] Rotate the leaked API key ${DASH} verify: Commander confirms new key deployed`;

const HITL_2_CLEARED = `- [x] [HITL] Approve the production rollback ${DASH} verify: Commander approves in the console`;
const HITL_2_UNCLEARED = `- [ ] [HITL] Approve the production rollback ${DASH} verify: Commander approves in the console`;

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

/** A fix-proposal.md with an `Author:` line and the given remediation steps. */
function fixProposal(author, steps) {
  return ['# Fix Proposal', `Author: ${author}`, '', ...steps].join('\n');
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
 * A board carrying the original report plus one audit Board_Entry per cleared
 * HITL step, attributed to the Incident Commander (Requirement 8.4).
 */
function boardWithHitlAudits() {
  return [
    '# Patchwork Board',
    '',
    `[2024-06-01T14:03Z] @${COMMANDER} ${DOT} Incident Commander (human) ${DOT} report: /checkout 500s on coupon stacking`,
    `[2024-06-01T15:00Z] @${COMMANDER} ${DOT} Incident Commander (human) ${DOT} hitl-cleared: Rotated the leaked API key`,
    `[2024-06-01T15:05Z] @${COMMANDER} ${DOT} Incident Commander (human) ${DOT} hitl-cleared: Approved the production rollback`,
  ].join('\n');
}

/**
 * The fully-satisfied "open" workspace: a FIX_STAGED incident whose two HITL
 * steps are BOTH cleared and which carries a non-author PASS bound to the
 * current fix_version. Each negative case mutates exactly one facet of this.
 */
function resolvableWorkspace() {
  return {
    board: boardWithHitlAudits(),
    incidents: {
      [INC]: {
        'incident.md': incidentMd('FIX_STAGED', CURRENT_FIX_VERSION),
        'fix-proposal.md': fixProposal(FIX_AUTHOR, [AFK_STEP, HITL_1_CLEARED, HITL_2_CLEARED]),
        'review.md': reviewMd(REVIEWER, CURRENT_FIX_VERSION, 'PASS'),
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
// The gate OPENS only when every HITL step is cleared AND a non-author PASS
// exists at the current fix_version.
// ---------------------------------------------------------------------------

test('human-itl: RESOLVED OPENS when every HITL step is cleared and a non-author PASS exists at the current fix_version', () => {
  const result = gateToResolved(resolvableWorkspace());
  assert.equal(result.allowed, true, 'a fully cleared, non-author-PASS workspace must open RESOLVED');
  assert.match(result.reason, /permitted/);
  assert.match(result.reason, /non-author PASS/);
  assert.match(result.reason, /HITL cleared/);
  assertNonEmptyReason(result);
});

// ---------------------------------------------------------------------------
// Progressive clearing: stays CLOSED until BOTH HITL steps are cleared, then
// OPENS. This is the literal statement of task 10.2 ("stays closed until every
// HITL step is cleared … then opens"), holding the non-author PASS constant.
// ---------------------------------------------------------------------------

test('human-itl: RESOLVED stays CLOSED until BOTH HITL steps are cleared, then OPENS (PASS held constant)', () => {
  const ws = resolvableWorkspace(); // PASS at current fix_version throughout

  // 0 of 2 cleared -> closed, despite the valid non-author PASS.
  ws.incidents[INC]['fix-proposal.md'] = fixProposal(FIX_AUTHOR, [
    AFK_STEP,
    HITL_1_UNCLEARED,
    HITL_2_UNCLEARED,
  ]);
  let result = gateToResolved(ws);
  assert.equal(result.allowed, false, 'both HITL uncleared -> closed');
  assert.match(result.reason, /HITL/);

  // 1 of 2 cleared -> still closed (an uncleared HITL remains).
  ws.incidents[INC]['fix-proposal.md'] = fixProposal(FIX_AUTHOR, [
    AFK_STEP,
    HITL_1_CLEARED,
    HITL_2_UNCLEARED,
  ]);
  result = gateToResolved(ws);
  assert.equal(result.allowed, false, 'one HITL still uncleared -> closed');
  assert.match(result.reason, /HITL/);

  // 2 of 2 cleared -> now OPEN.
  ws.incidents[INC]['fix-proposal.md'] = fixProposal(FIX_AUTHOR, [
    AFK_STEP,
    HITL_1_CLEARED,
    HITL_2_CLEARED,
  ]);
  result = gateToResolved(ws);
  assert.equal(result.allowed, true, 'every HITL cleared + non-author PASS -> open');
  assertNonEmptyReason(result);
});

// ---------------------------------------------------------------------------
// Removing any ONE condition keeps the gate CLOSED (table-driven).
// Each row mutates the fully-satisfied base by exactly one thing.
// ---------------------------------------------------------------------------

const closedCases = [
  {
    name: '(a) no PASS — review.md is missing',
    reason: /review\.md is missing/,
    mutate(ws) {
      delete ws.incidents[INC]['review.md'];
    },
  },
  {
    name: '(b) NEEDS_WORK verdict instead of PASS',
    reason: /does not record a PASS/,
    mutate(ws) {
      ws.incidents[INC]['review.md'] = reviewMd(REVIEWER, CURRENT_FIX_VERSION, 'NEEDS_WORK');
    },
  },
  {
    name: '(c) stale PASS at an earlier fix_version (1 < 2)',
    reason: /stale/,
    mutate(ws) {
      ws.incidents[INC]['review.md'] = reviewMd(REVIEWER, 1, 'PASS');
    },
  },
  {
    name: '(d) self-authored PASS (reviewer === fix author)',
    reason: /self-authored/,
    mutate(ws) {
      ws.incidents[INC]['review.md'] = reviewMd(FIX_AUTHOR, CURRENT_FIX_VERSION, 'PASS');
    },
  },
  {
    name: '(e) one of two HITL steps left uncleared despite a valid non-author PASS',
    reason: /HITL/,
    mutate(ws) {
      ws.incidents[INC]['fix-proposal.md'] = fixProposal(FIX_AUTHOR, [
        AFK_STEP,
        HITL_1_CLEARED,
        HITL_2_UNCLEARED,
      ]);
    },
  },
];

for (const { name, reason, mutate } of closedCases) {
  test(`human-itl: RESOLVED stays CLOSED — ${name}`, () => {
    const ws = resolvableWorkspace();
    mutate(ws);
    const result = gateToResolved(ws);

    assert.equal(result.allowed, false, `expected the gate to stay closed: ${name}`);
    assert.match(result.reason, /RESOLVED gate/);
    assert.match(result.reason, reason);
    assertNonEmptyReason(result);
  });
}

// The invariant, stated directly: removing ANY single condition keeps it
// closed, while the untouched base opens (so each closure is caused by its one
// mutation, not by a broken baseline).
test('human-itl: removing any one condition keeps RESOLVED closed; the base opens', () => {
  assert.equal(gateToResolved(resolvableWorkspace()).allowed, true, 'base must open');
  for (const { name, mutate } of closedCases) {
    const ws = resolvableWorkspace();
    mutate(ws);
    assert.equal(gateToResolved(ws).allowed, false, `removing "${name}" must keep RESOLVED closed`);
  }
});

// Boundary: a proposal with NO HITL steps has nothing to clear, so a valid
// non-author PASS alone opens RESOLVED (Requirement 8.5 — "IF one or more HITL
// steps remain uncleared" — is vacuously satisfied when there are none).
test('human-itl: with no HITL steps, a non-author PASS alone opens RESOLVED (nothing to clear)', () => {
  const ws = resolvableWorkspace();
  ws.incidents[INC]['fix-proposal.md'] = fixProposal(FIX_AUTHOR, [AFK_STEP]);
  assert.equal(gateToResolved(ws).allowed, true);
});

// ---------------------------------------------------------------------------
// Consistency: a validly-cleared `- [x] [HITL]` workspace is ALSO schema-valid.
// validate() and gate() must agree on the same cleared workspace — validate()
// must not misreport a checked-checkbox HITL step as a missing tag.
// ---------------------------------------------------------------------------

test('human-itl: the fully-cleared workspace that opens RESOLVED is ALSO schema-valid (validate agrees with gate)', () => {
  const ws = resolvableWorkspace();
  // Gate opens...
  assert.equal(gateToResolved(ws).allowed, true);
  // ...and validate finds no problems on the very same snapshot.
  const result = validate(ws);
  assert.equal(result.ok, true, `expected a clean validate, got: ${JSON.stringify(result.problems)}`);
  assert.deepEqual(result.problems, []);
});

test('human-itl: cleared `- [x] [HITL]` and uncleared `- [ ] [HITL]` steps are NOT misreported as missing a tag', () => {
  // Cleared form (gate: open) is schema-valid.
  const cleared = resolvableWorkspace();
  assert.ok(
    !validate(cleared).problems.some((p) => p.rule === 'remediation.tag.missing'),
    'a checked-checkbox HITL step must not be reported as remediation.tag.missing',
  );

  // Uncleared form (gate: closed) is STILL schema-valid — the checkbox does not
  // change tag/verify validity, only clear-state, which is the gate's concern.
  const uncleared = resolvableWorkspace();
  uncleared.incidents[INC]['fix-proposal.md'] = fixProposal(FIX_AUTHOR, [
    AFK_STEP,
    HITL_1_UNCLEARED,
    HITL_2_UNCLEARED,
  ]);
  assert.equal(gateToResolved(uncleared).allowed, false, 'uncleared HITL -> gate closed');
  assert.ok(
    !validate(uncleared).problems.some((p) => p.rule === 'remediation.tag.missing'),
    'an unchecked-checkbox HITL step must not be reported as remediation.tag.missing',
  );
});
