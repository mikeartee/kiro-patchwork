// Unit tests for round-cap counting and PARKED_FOR_HUMAN routing (task 3.3).
//
// These cover the third gate() layer (Step 3): the revision-cycle count derived
// from the incident's fix_version, the Round_Cap threshold, and the routing of
// the two CHANGES_REQUESTED out-edges on that count. The RESOLVED-guard edge
// cases live in task 3.5; Property 2's table-legality guarantee lives in
// gate.property.test.js. This file focuses squarely on the count + routing.
//
// Count-derivation contract under test (see gate.js "round-cap guard" note):
//   revisionCycleCount = max(0, fix_version - 1)
//   isRoundCapReached  = revisionCycleCount >= ROUND_CAP
// Routing:
//   CHANGES_REQUESTED -> INVESTIGATING     allowed WHILE below cap, else rejected
//   CHANGES_REQUESTED -> PARKED_FOR_HUMAN   allowed AT/ABOVE cap, else rejected
//
// _Requirements: 12.1, 12.2, 12.3_

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gate,
  revisionCycleCount,
  isRoundCapReached,
  ROUND_CAP,
} from '../core/gate.js';

const INCIDENT_ID = 'INC-2024-001';

/**
 * A workspace holding one incident whose incident.md carries the given
 * fix_version. `fixVersion === null` omits the fix_version line entirely.
 */
function workspaceWithFixVersion(fixVersion, status = 'CHANGES_REQUESTED') {
  const frontmatter = [
    '---',
    `id: ${INCIDENT_ID}`,
    'title: Checkout 500s on coupon stacking',
    `status: ${status}`,
  ];
  if (fixVersion !== null) frontmatter.push(`fix_version: ${fixVersion}`);
  frontmatter.push('---');
  return {
    incidents: { [INCIDENT_ID]: { 'incident.md': frontmatter.join('\n') } },
  };
}

// ---------------------------------------------------------------------------
// ROUND_CAP is a positive integer constant
// ---------------------------------------------------------------------------

test('ROUND_CAP is a configured positive integer', () => {
  assert.equal(typeof ROUND_CAP, 'number');
  assert.ok(Number.isInteger(ROUND_CAP) && ROUND_CAP > 0);
});

// ---------------------------------------------------------------------------
// revisionCycleCount: derived as max(0, fix_version - 1)
// ---------------------------------------------------------------------------

test('revisionCycleCount: derives max(0, fix_version - 1) from the incident frontmatter', () => {
  for (let fixVersion = 1; fixVersion <= ROUND_CAP + 2; fixVersion++) {
    const ws = workspaceWithFixVersion(fixVersion);
    assert.equal(
      revisionCycleCount(ws, INCIDENT_ID),
      fixVersion - 1,
      `fix_version ${fixVersion} should give ${fixVersion - 1} cycles`,
    );
  }
});

test('revisionCycleCount: returns 0 when the count is indeterminate', () => {
  // Empty workspace / no such incident.
  assert.equal(revisionCycleCount({}, INCIDENT_ID), 0);
  assert.equal(revisionCycleCount({ incidents: {} }, INCIDENT_ID), 0);
  assert.equal(revisionCycleCount({}, undefined), 0);
  // Incident present but incident.md absent.
  assert.equal(
    revisionCycleCount({ incidents: { [INCIDENT_ID]: {} } }, INCIDENT_ID),
    0,
  );
  // fix_version line omitted.
  assert.equal(revisionCycleCount(workspaceWithFixVersion(null), INCIDENT_ID), 0);
  // Non-integer fix_version is not a usable count.
  assert.equal(
    revisionCycleCount(workspaceWithFixVersion('draft'), INCIDENT_ID),
    0,
  );
  // Unparseable incident.md (no frontmatter).
  assert.equal(
    revisionCycleCount(
      { incidents: { [INCIDENT_ID]: { 'incident.md': 'no frontmatter here' } } },
      INCIDENT_ID,
    ),
    0,
  );
});

// ---------------------------------------------------------------------------
// isRoundCapReached: crosses at fix_version = ROUND_CAP + 1
// ---------------------------------------------------------------------------

test('isRoundCapReached: false below the cap, true at/above it', () => {
  // Below the cap: fix_version 1..ROUND_CAP  -> cycles 0..ROUND_CAP-1.
  for (let fixVersion = 1; fixVersion <= ROUND_CAP; fixVersion++) {
    assert.equal(
      isRoundCapReached(workspaceWithFixVersion(fixVersion), INCIDENT_ID),
      false,
      `fix_version ${fixVersion} (cycles ${fixVersion - 1}) is below the cap`,
    );
  }
  // At/above the cap: fix_version ROUND_CAP+1 -> cycles ROUND_CAP.
  assert.equal(
    isRoundCapReached(workspaceWithFixVersion(ROUND_CAP + 1), INCIDENT_ID),
    true,
  );
  assert.equal(
    isRoundCapReached(workspaceWithFixVersion(ROUND_CAP + 5), INCIDENT_ID),
    true,
  );
});

// ---------------------------------------------------------------------------
// gate routing on the two CHANGES_REQUESTED out-edges (table-driven)
// ---------------------------------------------------------------------------
//
// For each fix_version we assert BOTH out-edges together, so the complementary
// contract (exactly one permitted at a time) is visible per row.

const routingCases = [];
for (let fixVersion = 1; fixVersion <= ROUND_CAP + 2; fixVersion++) {
  const cycles = fixVersion - 1;
  const capReached = cycles >= ROUND_CAP;
  routingCases.push({ fixVersion, cycles, capReached });
}

for (const { fixVersion, cycles, capReached } of routingCases) {
  test(`gate: fix_version ${fixVersion} (cycles ${cycles}) — INVESTIGATING ${capReached ? 'rejected' : 'allowed'}, PARKED ${capReached ? 'allowed' : 'rejected'}`, () => {
    const ws = workspaceWithFixVersion(fixVersion);

    const toInvestigating = gate(ws, {
      incidentId: INCIDENT_ID,
      from: 'CHANGES_REQUESTED',
      to: 'INVESTIGATING',
    });
    const toParked = gate(ws, {
      incidentId: INCIDENT_ID,
      from: 'CHANGES_REQUESTED',
      to: 'PARKED_FOR_HUMAN',
    });

    // Below the cap: keep revising (INVESTIGATING), do not park early.
    // At/above the cap: revision edge closes, escape edge opens.
    assert.equal(
      toInvestigating.allowed,
      !capReached,
      `INVESTIGATING at fix_version ${fixVersion} should be ${!capReached}`,
    );
    assert.equal(
      toParked.allowed,
      capReached,
      `PARKED_FOR_HUMAN at fix_version ${fixVersion} should be ${capReached}`,
    );

    // Exactly one of the two out-edges is permitted at any time.
    assert.notEqual(
      toInvestigating.allowed,
      toParked.allowed,
      'exactly one CHANGES_REQUESTED out-edge must be permitted',
    );

    // Reasons are always present and non-empty.
    for (const r of [toInvestigating, toParked]) {
      assert.equal(typeof r.reason, 'string');
      assert.ok(r.reason.trim().length > 0);
    }
  });
}

// ---------------------------------------------------------------------------
// Round-cap reached routes to PARKED_FOR_HUMAN (the task-3.5 edge case, pinned
// here too so the behaviour is directly covered by this task)
// ---------------------------------------------------------------------------

test('gate: at the round cap, PARKED_FOR_HUMAN is the only permitted CHANGES_REQUESTED exit', () => {
  const ws = workspaceWithFixVersion(ROUND_CAP + 1); // cycles === ROUND_CAP

  const parked = gate(ws, {
    incidentId: INCIDENT_ID,
    from: 'CHANGES_REQUESTED',
    to: 'PARKED_FOR_HUMAN',
  });
  assert.equal(parked.allowed, true);
  assert.match(parked.reason, /round-cap/);

  const investigating = gate(ws, {
    incidentId: INCIDENT_ID,
    from: 'CHANGES_REQUESTED',
    to: 'INVESTIGATING',
  });
  assert.equal(investigating.allowed, false);
  assert.match(investigating.reason, /round-cap reached/);
});

test('gate: below the round cap, INVESTIGATING is permitted and PARKED_FOR_HUMAN is withheld', () => {
  const ws = workspaceWithFixVersion(1); // cycles 0

  const investigating = gate(ws, {
    incidentId: INCIDENT_ID,
    from: 'CHANGES_REQUESTED',
    to: 'INVESTIGATING',
  });
  assert.equal(investigating.allowed, true);

  const parked = gate(ws, {
    incidentId: INCIDENT_ID,
    from: 'CHANGES_REQUESTED',
    to: 'PARKED_FOR_HUMAN',
  });
  assert.equal(parked.allowed, false);
  assert.match(parked.reason, /round-cap not reached/);
});

// The round-cap guard is layered on top of Step-1 legality: an out-of-table
// pair from CHANGES_REQUESTED is still rejected by the table check, never by
// the guard (so guard routing never masks an illegal transition).
test('gate: an out-of-table CHANGES_REQUESTED pair is rejected by legality, not the round-cap guard', () => {
  const ws = workspaceWithFixVersion(ROUND_CAP + 1);
  const result = gate(ws, {
    incidentId: INCIDENT_ID,
    from: 'CHANGES_REQUESTED',
    to: 'RESOLVED', // not a defined transition
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /no transition defined/);
});
