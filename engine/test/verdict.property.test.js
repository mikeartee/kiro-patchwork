// Property-based test for the fail-closed parseVerdict() core (task 3.4).
//
// Feature: kiro-patchwork, Property 1 — Verdict fails closed for all non-PASS
// inputs.
//
// Reuses the in-repo PBT layer (./support/pbt.js) and the verdict-string
// generators (./support/generators.js) — no external property-testing
// dependency, matching the design's dependency-light Testing Strategy. The
// deterministic example coverage lives in verdict.smoke.test.js (task 3.1);
// this randomized check pins the same fail-closed contract across the whole
// non-approving input space and prints a reproducible seed on failure (forAll
// augments the error).
//
// The property: for any string that is NOT exactly the canonical `VERDICT: PASS`
// line, parseVerdict returns NEEDS_WORK. "Not exactly the canonical line" is
// read against verdict.js's documented exact-match rule — a review parses to
// PASS ONLY WHEN it has at least one recognised verdict line AND every such line
// is exactly `VERDICT: PASS`. So the generator produces reviews that, BY
// CONSTRUCTION, can never satisfy that rule (see genNonApprovingReview), and the
// property asserts NEEDS_WORK for all of them (Requirements 5.3, 10.3).
//
// Non-vacuity is guarded two ways, because "for all X, parseVerdict(X) ===
// NEEDS_WORK" would pass trivially if parseVerdict could never return PASS or if
// the generator quietly stopped producing the interesting cases:
//   1. A coverage assertion checks every non-approving family was exercised —
//      including the subtle `conflicting` family, where a real canonical
//      `VERDICT: PASS` line is present yet the review must still fail closed.
//   2. A positive sanity forAll over genApprovingReview asserts parseVerdict
//      CAN return PASS, so the NEEDS_WORK result above is a real discrimination,
//      not a constant.
//
// **Validates: Requirements 5.3, 10.3**

import test from 'node:test';
import assert from 'node:assert/strict';

import { forAll } from './support/pbt.js';
import {
  genNonApprovingReview,
  genApprovingReview,
  wouldParsePass,
} from './support/generators.js';
import { parseVerdict } from '../core/verdict.js';

// Minimum required by the property is 100; run more for stronger coverage.
const ITERATIONS = 300;

// The families genNonApprovingReview draws from; the coverage assertion checks
// every one was actually exercised so the property cannot pass because the
// generator degenerated to a single easy case.
const EXPECTED_FAMILIES = [
  'no-verdict',
  'non-canonical-verdict',
  'commented-out',
  'conflicting',
  'blank',
  'garbage',
];

test('Feature: kiro-patchwork, Property 1 — parseVerdict returns NEEDS_WORK for every non-PASS input', () => {
  const seen = new Set();

  forAll(
    ITERATIONS,
    (rng) => genNonApprovingReview(rng),
    ({ family, text }) => {
      // Track the base family (drop any "+safeguard" suffix) for coverage.
      seen.add(family.replace(/\+safeguard$/, ''));
      assert.equal(
        parseVerdict(text),
        'NEEDS_WORK',
        `expected NEEDS_WORK for a non-approving [${family}] review`,
      );
    },
  );

  // Coverage / non-vacuity: every non-approving family was exercised, so the
  // property genuinely spans the input space (not just the trivial cases).
  for (const fam of EXPECTED_FAMILIES) {
    assert.ok(seen.has(fam), `non-approving family not exercised: ${fam}`);
  }
});

test('Feature: kiro-patchwork, Property 1 — parseVerdict CAN return PASS for an approving review (non-vacuity)', () => {
  forAll(
    ITERATIONS,
    (rng) => genApprovingReview(rng),
    (text) => {
      assert.equal(
        parseVerdict(text),
        'PASS',
        'expected PASS for an approving review (prose + a final canonical VERDICT: PASS)',
      );
      // Cross-check the generator boundary with the independent oracle used by
      // the non-approving safeguard: an approving review must read as PASS.
      assert.ok(
        wouldParsePass(text),
        'independent oracle disagreed: approving review should parse PASS',
      );
    },
  );
});
