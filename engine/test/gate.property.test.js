// Property-based test for gate() transition legality (task 2.4).
//
// Feature: kiro-patchwork, Property 2 — Gate never allows an undefined
// transition.
//
// Reuses the in-repo PBT layer (./support/pbt.js) and the transition-pair
// generators (./support/generators.js) — no external property-testing
// dependency, matching the design's dependency-light Testing Strategy. The
// deterministic, exhaustive 9x9 counterpart lives in gate.test.js (task 2.3);
// this randomized check pins the same guarantee across a biased input stream
// and prints a reproducible seed on failure (forAll augments the error).
//
// The property: for any {from, to} pair of Incident_Status values, gate()
// allows the pair ONLY IF that pair is in the transition table; every other
// pair is rejected. The transition table is the SOLE source of allowed motion
// (Requirements 3.5, 10.2). TRANSITIONS — the declared edge list gate()
// consults — is the source of truth for "in the table": a legal set is built
// here directly from it, independently of the derived TRANSITION_TABLE Map.
//
// Table membership (the true statement of Property 2 — the table is the sole
// source of legal motion) is asserted as a biconditional against the two
// derived views, isDefinedTransition() and TRANSITION_TABLE, which are pure
// legality and independent of the RESOLVED guard.
//
// For gate() itself the property is a ONE-DIRECTION implication, because the
// guards can turn certain in-table edges into rejections on this empty
// workspace: the RESOLVED guard (task 3.2) rejects the in-table FIX_STAGED ->
// RESOLVED edge without incident artifacts, and the round-cap guard (task 3.3)
// rejects the in-table CHANGES_REQUESTED -> PARKED_FOR_HUMAN edge while the
// revision-cycle count is 0 (below the cap). So gate allows a pair ONLY IF it
// is in the table ("allowed ⇒ in table"), and EVERY pair NOT in the table is
// rejected ("not in table ⇒ not allowed"). The converse ("in table ⇒ allowed")
// is NOT claimed, since a guarded edge can be legal yet rejected. This is still
// the faithful reading of "allows only if in the table".
//
// Non-vacuity: the generator is biased (see genTransitionPair) so the stream
// contains both legal edges and rejected pairs; the main test asserts BOTH
// outcomes were actually observed, so the implication cannot pass vacuously.
//
// **Validates: Requirements 3.5, 10.2**

import test from 'node:test';
import assert from 'node:assert/strict';

import { forAll } from './support/pbt.js';
import {
  genTransitionPair,
  genUnknownStatusPair,
} from './support/generators.js';
import {
  gate,
  isDefinedTransition,
  TRANSITIONS,
  TRANSITION_TABLE,
} from '../core/gate.js';

// Minimum required by the property is 100; run more for stronger coverage.
const ITERATIONS = 300;

// The legal edge set, built directly from the declared edge list (the source of
// truth). Intentionally independent of TRANSITION_TABLE so the test cross-checks
// the derived Map rather than trusting it.
const LEGAL_KEYS = new Set(TRANSITIONS.map(([from, to]) => `${from}->${to}`));
const inTable = (from, to) => LEGAL_KEYS.has(`${from}->${to}`);

test('Feature: kiro-patchwork, Property 2 — gate allows a {from,to} pair iff it is in the transition table', () => {
  let allowedCount = 0;
  let rejectedCount = 0;

  forAll(
    ITERATIONS,
    (rng) => genTransitionPair(rng),
    ({ from, to }) => {
      const result = gate({}, { incidentId: 'INC-2024-001', from, to });
      const legal = inTable(from, to);

      // Property 2 proper: the TABLE is the sole source of LEGAL motion. Assert
      // it as a biconditional against the two derived views, which are pure
      // legality and independent of the RESOLVED guard.
      assert.equal(
        isDefinedTransition(from, to),
        legal,
        `isDefinedTransition(${from}, ${to}) disagrees with the table`,
      );
      assert.equal(
        Boolean(TRANSITION_TABLE.get(from)?.has(to)),
        legal,
        `TRANSITION_TABLE membership for ${from} -> ${to} disagrees with the table`,
      );

      // gate() "allows only if in the table": allowing implies legality. The
      // guards can reject in-table edges on this empty workspace — FIX_STAGED ->
      // RESOLVED (RESOLVED guard, task 3.2) and CHANGES_REQUESTED ->
      // PARKED_FOR_HUMAN (round-cap guard, task 3.3, count 0 < cap) — so the
      // converse is intentionally NOT asserted here.
      if (result.allowed) {
        assert.ok(
          legal,
          `gate allowed ${from} -> ${to}, which is not in the transition table`,
        );
      }

      // Every pair NOT in the table is rejected by gate, guard or no guard.
      if (!legal) {
        assert.equal(
          result.allowed,
          false,
          `gate allowed the out-of-table pair ${from} -> ${to}`,
        );
      }

      // A human-readable reason is always present, whichever way it went.
      assert.equal(typeof result.reason, 'string');
      assert.ok(result.reason.trim().length > 0);

      if (result.allowed) allowedCount++;
      else rejectedCount++;
    },
  );

  // Non-vacuity: the property is only meaningful if the run exercised BOTH
  // outcomes. The biased generator guarantees legal edges appear, and the
  // known+unknown pairs guarantee rejections appear.
  assert.ok(allowedCount > 0, 'expected at least one allowed pair (non-vacuous)');
  assert.ok(
    rejectedCount > 0,
    'expected at least one rejected pair (non-vacuous)',
  );
});

test('Feature: kiro-patchwork, Property 2 — a {from,to} pair containing an unknown status is never allowed', () => {
  forAll(
    ITERATIONS,
    (rng) => genUnknownStatusPair(rng),
    ({ from, to }) => {
      const result = gate({}, { from, to });
      assert.equal(
        result.allowed,
        false,
        `gate allowed a pair with an unknown status: ${from} -> ${to}`,
      );
      // Any pair with an unknown/typo status short-circuits to this reason.
      assert.match(result.reason, /unknown incident status/);
    },
  );
});
