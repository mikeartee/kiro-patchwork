// Property-based test for the validate() core command (task 1.6).
//
// Feature: kiro-patchwork, Property 3 — Validate is deterministic and
// order-independent.
//
// This is the first property test in the repo, so it stands up the reusable
// in-repo PBT layer (./support/pbt.js) and the workspace generators
// (./support/generators.js) that Properties 1 and 2 (tasks 3.4 and 2.4) will
// reuse. No external property-testing dependency is used, matching the design's
// dependency-light Testing Strategy.
//
// The property has two halves, both asserted over >= 100 generated snapshots:
//
//   (a) Pure determinism — calling validate() twice on the identical snapshot
//       yields deeply-equal results (same ok, same problems, same order).
//
//   (b) Order-independence — reordering only order-independent content (board
//       timeline lines, the incidents-map insertion order, and each incident's
//       file-key order) yields the same verdict. validate() emits one problem
//       per malformed board line in file order, so shuffling board lines can
//       permute the problems array; the verdict is therefore compared as a
//       MULTISET (both problem lists canonicalized and sorted before compare),
//       which is the precise expression of "same ok/problems verdict,
//       order-independent". The `ok` boolean is compared directly.
//
// **Validates: Requirements 10.6**

import test from 'node:test';
import assert from 'node:assert/strict';

import { forAll } from './support/pbt.js';
import { genWorkspace, shuffleWorkspace } from './support/generators.js';
import { validate } from '../core/validate.js';

// Minimum required by the property is 100; run more for stronger coverage.
const ITERATIONS = 200;

// Canonicalize a problem list into a sorted array of stable strings, so two
// lists compare equal exactly when they are equal as multisets (duplicates and
// all, order ignored).
function problemMultiset(problems) {
  return problems
    .map((p) => JSON.stringify({ path: p.path, rule: p.rule, message: p.message }))
    .sort();
}

test('Feature: kiro-patchwork, Property 3 — validate is deterministic (identical snapshot => identical result)', () => {
  forAll(
    ITERATIONS,
    (rng) => genWorkspace(rng),
    (workspace) => {
      const first = validate(workspace);
      const second = validate(workspace);
      // Same input, same output — down to problem order.
      assert.deepEqual(first, second);
    },
  );
});

test('Feature: kiro-patchwork, Property 3 — validate verdict is order-independent under equivalent reordering', () => {
  forAll(
    ITERATIONS,
    (rng) => {
      const original = genWorkspace(rng);
      const reordered = shuffleWorkspace(rng, original);
      return { original, reordered };
    },
    ({ original, reordered }) => {
      const before = validate(original);
      const after = validate(reordered);

      // The ok/problems verdict must be identical after reordering
      // order-independent content.
      assert.equal(
        before.ok,
        after.ok,
        'ok verdict changed after reordering equivalent content',
      );
      assert.deepEqual(
        problemMultiset(before.problems),
        problemMultiset(after.problems),
        'problem multiset changed after reordering equivalent content',
      );
    },
  );
});
