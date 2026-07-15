// Minimal smoke test for the gate() core function (task 2.1).
//
// This is a small sanity check that the transition table and gate() wiring
// work. The comprehensive, edge-by-edge unit tests belong to task 2.3
// (gate.test.js) and the "gate never allows an undefined transition" property
// test belongs to task 2.4; this file is intentionally named `.smoke.` so it
// does not collide with those later suites.
//
// _Requirements: 3.2, 3.5, 10.2_

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gate,
  isDefinedTransition,
  TRANSITIONS,
  TRANSITION_TABLE,
} from '../core/gate.js';

test('gate: a legal edge (REPORTED -> INVESTIGATING) is permitted', () => {
  const result = gate({}, { incidentId: 'INC-2024-001', from: 'REPORTED', to: 'INVESTIGATING' });
  assert.equal(result.allowed, true);
  assert.match(result.reason, /permitted/);
});

test('gate: an undefined edge (REPORTED -> RESOLVED) is rejected', () => {
  const result = gate({}, { incidentId: 'INC-2024-001', from: 'REPORTED', to: 'RESOLVED' });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /no transition defined/);
});

test('gate: an unknown status in the pair is rejected', () => {
  const result = gate({}, { from: 'REPORTED', to: 'NOT_A_STATUS' });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /unknown incident status/);
});

// The FIX_STAGED -> RESOLVED edge is legal at Step 1 but guarded at Step 2
// (task 3.2): it is only allowed when a non-author PASS bound to the current
// fix_version exists and every HITL step is cleared. A minimal guard-satisfying
// workspace for these two smoke assertions; the exhaustive guard edge cases are
// task 3.5.
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
          '- [x] [HITL] Rotate the API key \u2014 verify: Commander confirms new key deployed',
        ].join('\n'),
        'review.md': ['Reviewer: patchwork-reviewer', 'Fix-Version: 1', '', 'VERDICT: PASS'].join(
          '\n',
        ),
      },
    },
  };
}

test('gate: the guarded FIX_STAGED -> RESOLVED edge fails closed on an empty workspace (guard, task 3.2)', () => {
  const result = gate({}, { incidentId: 'INC-2024-001', from: 'FIX_STAGED', to: 'RESOLVED' });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /RESOLVED gate/);
});

test('gate: the guarded FIX_STAGED -> RESOLVED edge is allowed when the guard is fully satisfied', () => {
  const result = gate(satisfyingResolvedWorkspace(), {
    incidentId: 'INC-2024-001',
    from: 'FIX_STAGED',
    to: 'RESOLVED',
  });
  assert.equal(result.allowed, true);
});

test('isDefinedTransition mirrors the table membership', () => {
  assert.equal(isDefinedTransition('ANALYSIS_READY', 'CHANGES_REQUESTED'), true);
  assert.equal(isDefinedTransition('ANALYSIS_READY', 'APPROVED'), false);
});

test('TRANSITION_TABLE is derived from the 11 declared edges', () => {
  assert.equal(TRANSITIONS.length, 11);
  const derivedEdgeCount = [...TRANSITION_TABLE.values()].reduce(
    (sum, targets) => sum + targets.size,
    0,
  );
  assert.equal(derivedEdgeCount, 11);
});
