// Comprehensive unit tests for gate() transition legality (task 2.3).
//
// The smoke test (gate.smoke.test.js) is a minimal sanity check and stays.
// This suite is the exhaustive, edge-by-edge check that the transition table
// is the SOLE source of allowed motion (Requirement 3.5, 10.2): every legal
// edge is allowed, and every other ordered pair — including happy-path
// state-skips, backward jumps, and pairs containing an unknown/typo status —
// is rejected. The randomized version of this guarantee is Property 2 in the
// property test (task 2.4); this deterministic exhaustive check pins it by
// covering the entire 9x9 status matrix.
//
// Scope note: this suite targets transition LEGALITY (Step 1). Legality is
// asserted via isDefinedTransition / TRANSITION_TABLE, which are independent of
// the guards. The guards add rejections on three in-table edges, so calling
// gate() with an EMPTY workspace allows exactly the in-table edges EXCEPT:
//   • FIX_STAGED -> RESOLVED            — RESOLVED guard (task 3.2) fails closed
//                                         without incident artifacts.
//   • CHANGES_REQUESTED -> PARKED_FOR_HUMAN — round-cap guard (task 3.3): with a
//                                         revision-cycle count of 0 the cap is
//                                         not reached, so the early escape edge
//                                         is withheld.
// (CHANGES_REQUESTED -> INVESTIGATING stays ALLOWED on an empty workspace: count
// 0 is below the cap, so the ordinary revision edge is permitted.) The tests
// below account for those two cells; the guards' own success/rejection edge
// cases are task 3.5.
//
// _Requirements: 3.2, 3.5_

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gate,
  isDefinedTransition,
  TRANSITIONS,
  TRANSITION_TABLE,
  ROUND_CAP,
} from '../core/gate.js';
import { INCIDENT_STATUSES } from '../core/schema.js';

// The set of legal "from->to" keys, built from the same edge list gate()
// consults. Building it here (rather than hand-listing 11 edges again) keeps
// the test in lockstep with the table: if an edge is added or removed, this
// set — and the exhaustive matrix below — track it automatically.
const LEGAL_KEYS = new Set(TRANSITIONS.map(([from, to]) => `${from}->${to}`));

/** A gate reason must always be a non-empty, human-readable string. */
function assertNonEmptyReason(result) {
  assert.equal(typeof result.reason, 'string', 'reason must be a string');
  assert.ok(result.reason.trim().length > 0, 'reason must be non-empty');
}

// A minimal workspace that fully satisfies the FIX_STAGED -> RESOLVED guard
// (task 3.2): a non-author PASS (reviewer != fix author) bound to the incident's
// current fix_version, with the single HITL step cleared. Used so the "every
// legal edge is allowed" check stays literally true for the guarded edge; the
// guard's rejection paths are exhaustively tested in task 3.5.
function satisfyingResolvedWorkspace() {
  return {
    incidents: {
      'INC-2024-001': {
        'incident.md': [
          '---',
          'id: INC-2024-001',
          'title: Checkout 500s on coupon stacking',
          'status: FIX_STAGED',
          'fix_version: 1',
          '---',
        ].join('\n'),
        'fix-proposal.md': [
          'Author: patchwork-sre',
          '',
          `- [x] [HITL] Rotate the API key ${'\u2014'} verify: Commander confirms new key deployed`,
        ].join('\n'),
        'review.md': [
          'Reviewer: patchwork-reviewer',
          'Fix-Version: 1',
          '',
          'VERDICT: PASS',
        ].join('\n'),
      },
    },
  };
}

// A minimal workspace whose incident has REACHED the round cap (task 3.3): its
// fix_version is one past the cap, so revisionCycleCount = fix_version - 1 =
// ROUND_CAP. Used so the guarded CHANGES_REQUESTED -> PARKED_FOR_HUMAN escape
// edge is allowed in the "every legal edge is allowed" check. The round-cap
// guard reads only fix_version, so no other artifacts are needed. The guard's
// own below-cap/at-cap edge cases are exhaustively covered in task 3.5.
function capReachedWorkspace() {
  return {
    incidents: {
      'INC-2024-001': {
        'incident.md': [
          '---',
          'id: INC-2024-001',
          'title: Checkout 500s on coupon stacking',
          'status: CHANGES_REQUESTED',
          `fix_version: ${ROUND_CAP + 1}`,
          '---',
        ].join('\n'),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Every legal edge is allowed
// ---------------------------------------------------------------------------

test('gate: every legal edge in TRANSITIONS is allowed with a reason', () => {
  for (const [from, to] of TRANSITIONS) {
    // Guarded edges are legal at Step 1 but also require a satisfied guard, so
    // feed each the workspace that satisfies its guard:
    //   • FIX_STAGED -> RESOLVED needs a satisfied RESOLVED guard (task 3.2).
    //   • CHANGES_REQUESTED -> PARKED_FOR_HUMAN needs the round cap REACHED (3.3).
    // Every other edge — including CHANGES_REQUESTED -> INVESTIGATING (count 0,
    // below the cap) — is allowed on an empty workspace.
    let workspace = {};
    if (from === 'FIX_STAGED' && to === 'RESOLVED') {
      workspace = satisfyingResolvedWorkspace();
    } else if (from === 'CHANGES_REQUESTED' && to === 'PARKED_FOR_HUMAN') {
      workspace = capReachedWorkspace();
    }
    const result = gate(workspace, { incidentId: 'INC-2024-001', from, to });
    assert.equal(
      result.allowed,
      true,
      `expected legal edge ${from} -> ${to} to be allowed`,
    );
    assertNonEmptyReason(result);
  }
});

// ---------------------------------------------------------------------------
// Exhaustive 9x9 matrix: allowed iff the pair is in the transition table
// ---------------------------------------------------------------------------

test('gate: across all 81 ordered status pairs, allowed matches table membership (guarded edge excepted)', () => {
  let checked = 0;
  for (const from of INCIDENT_STATUSES) {
    for (const to of INCIDENT_STATUSES) {
      const inTable = LEGAL_KEYS.has(`${from}->${to}`);
      const result = gate({}, { from, to });

      // On an EMPTY workspace, gate() allows exactly the in-table edges EXCEPT
      // two guarded edges that reject when their guard cannot be satisfied:
      //   • FIX_STAGED -> RESOLVED — RESOLVED guard (task 3.2) fails closed
      //     without incident artifacts.
      //   • CHANGES_REQUESTED -> PARKED_FOR_HUMAN — round-cap guard (task 3.3):
      //     with a revision-cycle count of 0 the cap is not reached, so the
      //     early escape edge is withheld.
      // (CHANGES_REQUESTED -> INVESTIGATING is NOT excepted: count 0 is below
      // the cap, so the ordinary revision edge stays allowed on an empty ws.)
      const isEmptyWsRejectedEdge =
        (from === 'FIX_STAGED' && to === 'RESOLVED') ||
        (from === 'CHANGES_REQUESTED' && to === 'PARKED_FOR_HUMAN');
      const expectedAllowed = inTable && !isEmptyWsRejectedEdge;

      assert.equal(
        result.allowed,
        expectedAllowed,
        `gate(${from} -> ${to}).allowed should be ${expectedAllowed}`,
      );
      // Legality (table membership) is independent of the guard and must still
      // match the declared table exactly, across the whole square.
      assert.equal(
        isDefinedTransition(from, to),
        inTable,
        `isDefinedTransition(${from}, ${to}) should be ${inTable}`,
      );
      // A reason is always present, whichever way the decision went.
      assertNonEmptyReason(result);
      checked++;
    }
  }
  // Sanity: we covered the full square and exactly the 11 declared edges.
  assert.equal(checked, INCIDENT_STATUSES.length ** 2);
  assert.equal(checked, 81);
  assert.equal(LEGAL_KEYS.size, 11);
});

// ---------------------------------------------------------------------------
// Representative illegal edges between KNOWN statuses (table-driven)
// ---------------------------------------------------------------------------

// These are all pairs of valid Incident_Status values that are NOT in the
// table. gate() rejects them with the "no transition defined" reason (as
// opposed to the "unknown incident status" reason reserved for typo'd states).
const illegalKnownEdges = [
  // --- happy-path state skipping ---------------------------------------
  { name: 'skip INVESTIGATING (REPORTED -> ANALYSIS_READY)', from: 'REPORTED', to: 'ANALYSIS_READY' },
  { name: 'skip to RESOLVED mid-path (INVESTIGATING -> RESOLVED)', from: 'INVESTIGATING', to: 'RESOLVED' },
  { name: 'skip the whole path (REPORTED -> RESOLVED)', from: 'REPORTED', to: 'RESOLVED' },
  { name: 'skip FIX_STAGED (APPROVED -> RESOLVED)', from: 'APPROVED', to: 'RESOLVED' },
  { name: 'skip AWAITING_APPROVAL (ANALYSIS_READY -> APPROVED)', from: 'ANALYSIS_READY', to: 'APPROVED' },

  // --- backward jumps not modeled as branch edges ----------------------
  { name: 'backward (RESOLVED -> REPORTED)', from: 'RESOLVED', to: 'REPORTED' },
  { name: 'backward (RESOLVED -> FIX_STAGED)', from: 'RESOLVED', to: 'FIX_STAGED' },
  { name: 'backward (INVESTIGATING -> REPORTED)', from: 'INVESTIGATING', to: 'REPORTED' },
  { name: 'backward (APPROVED -> AWAITING_APPROVAL)', from: 'APPROVED', to: 'AWAITING_APPROVAL' },

  // --- other undefined pairs between real statuses ---------------------
  { name: 'undefined branch (AWAITING_APPROVAL -> PARKED_FOR_HUMAN)', from: 'AWAITING_APPROVAL', to: 'PARKED_FOR_HUMAN' },
  { name: 'undefined branch (PARKED_FOR_HUMAN -> RESOLVED)', from: 'PARKED_FOR_HUMAN', to: 'RESOLVED' },
  { name: 'no-op self transition (REPORTED -> REPORTED)', from: 'REPORTED', to: 'REPORTED' },
];

for (const { name, from, to } of illegalKnownEdges) {
  test(`gate: rejects illegal edge — ${name}`, () => {
    // Guard against a stale test: the pair really must be outside the table.
    assert.equal(
      isDefinedTransition(from, to),
      false,
      `test fixture error: ${from} -> ${to} is unexpectedly in the table`,
    );

    const result = gate({}, { incidentId: 'INC-2024-001', from, to });
    assert.equal(result.allowed, false, `expected ${from} -> ${to} to be rejected`);
    assert.match(result.reason, /no transition defined/);
    assertNonEmptyReason(result);
  });
}

// ---------------------------------------------------------------------------
// Pairs containing an unknown / typo status
// ---------------------------------------------------------------------------

const unknownStatusCases = [
  { name: 'unknown target (REPORTED -> NOT_A_STATUS)', from: 'REPORTED', to: 'NOT_A_STATUS' },
  { name: 'unknown source (NOT_A_STATUS -> INVESTIGATING)', from: 'NOT_A_STATUS', to: 'INVESTIGATING' },
  { name: 'both unknown (FOO -> BAR)', from: 'FOO', to: 'BAR' },
  { name: 'empty target ("")', from: 'REPORTED', to: '' },
  { name: 'case-mismatch typo (reported -> investigating)', from: 'reported', to: 'investigating' },
];

for (const { name, from, to } of unknownStatusCases) {
  test(`gate: rejects pair with an unknown status — ${name}`, () => {
    const result = gate({}, { from, to });
    assert.equal(result.allowed, false, `expected ${from} -> ${to} to be rejected`);
    assert.match(result.reason, /unknown incident status/);
    assertNonEmptyReason(result);
  });
}

// ---------------------------------------------------------------------------
// TRANSITION_TABLE integrity — the derived map matches the declared edges
// ---------------------------------------------------------------------------

test('gate: TRANSITION_TABLE membership exactly matches the declared edge list', () => {
  // Every declared edge is present in the derived table...
  for (const [from, to] of TRANSITIONS) {
    assert.ok(
      TRANSITION_TABLE.get(from)?.has(to),
      `table is missing declared edge ${from} -> ${to}`,
    );
  }
  // ...and the table contains no edges beyond the declared ones.
  let tableEdgeCount = 0;
  for (const [from, targets] of TRANSITION_TABLE) {
    for (const to of targets) {
      assert.ok(LEGAL_KEYS.has(`${from}->${to}`), `table has undeclared edge ${from} -> ${to}`);
      tableEdgeCount++;
    }
  }
  assert.equal(tableEdgeCount, TRANSITIONS.length);
});
