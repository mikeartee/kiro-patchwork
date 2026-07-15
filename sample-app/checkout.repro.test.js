// Reproduction test for the planted coupon-stacking defect (task 6.3).
//
// !! THIS TEST IS EXPECTED TO FAIL WHILE THE PLANTED DEFECT IS PRESENT !!
// That failure is the point: it is the factual grounding an `[AFK]` remediation
// step verifies against once the fix lands. It asserts the CORRECT (post-fix)
// behavior for stacked coupons, so today the buggy code throws instead of
// returning a total and the "stacked" assertions below fail. Do NOT weaken
// these assertions to make them pass against the buggy code, and do NOT change
// checkout.js as part of this task — the fix is a later remediation step.
//
// The defect: applyCoupons() reads `lastApplied.tier.multiplier` when a second
// valid coupon is stacked, but COUPONS entries carry no `tier` field, so it
// throws `TypeError: Cannot read properties of undefined (reading 'multiplier')`
// (the exact signature seeded in sample-app/logs/checkout.log). A single coupon
// or no coupon never reaches that branch and works fine today.
//
// Expected (post-fix) stacking semantics — the simplest defensible reading:
//   The COUPONS catalogue has NO tier/loyalty metadata; every coupon is a flat
//   `discount`. The docstring's "loyalty tier bonus" is unimplementable against
//   that data model (no coupon has a tier), and the requirements/logs describe
//   this purely as a "coupon stacking" 500. So stacked coupons are simply
//   ADDITIVE flat discounts off the subtotal, with the total floored at 0.
//   e.g. subtotal 100 with SAVE5 (5) + SAVE10 (10) -> 100 - 5 - 10 = 85.
//
// Uses the pure, exported pricing functions directly — no live server needed.
//
// _Requirements: 14.3_

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyCoupons, computeCheckout, COUPONS } from './checkout.js';

// ---------------------------------------------------------------------------
// Passing baseline: no coupon / single coupon. These paths never hit the
// stacking branch, so they return correct totals today AND after the fix. They
// isolate the defect to coupon STACKING specifically.
// ---------------------------------------------------------------------------

test('baseline: no coupons leaves the subtotal unchanged', () => {
  assert.equal(applyCoupons({ subtotal: 100 }, []), 100);
});

test('baseline: a single valid coupon applies its flat discount', () => {
  assert.equal(applyCoupons({ subtotal: 100 }, ['SAVE5']), 95);
  assert.equal(applyCoupons({ subtotal: 100 }, ['WELCOME']), 85);
});

test('baseline: computeCheckout returns the correct total for a single coupon', () => {
  assert.deepEqual(computeCheckout({ subtotal: 100, coupons: ['SAVE10'] }), {
    subtotal: 100,
    coupons: ['SAVE10'],
    total: 90,
  });
});

// ---------------------------------------------------------------------------
// Reproduction: stacking two or more valid coupons. FAILS TODAY because the
// planted defect throws a TypeError instead of returning a total. These express
// the intended fixed behavior (additive flat discounts, floored at 0).
// ---------------------------------------------------------------------------

test('REPRO: stacking SAVE5 + SAVE10 discounts additively and does not throw', () => {
  // Today applyCoupons throws here (Cannot read properties of undefined
  // (reading 'multiplier')), which fails this test — that is the reproduction.
  // After the fix it must return 100 - 5 - 10 = 85.
  const total = applyCoupons({ subtotal: 100 }, ['SAVE5', 'SAVE10']);
  assert.equal(total, 85);
});

test('REPRO: computeCheckout totals stacked coupons additively', () => {
  const result = computeCheckout({ subtotal: 100, coupons: ['SAVE5', 'SAVE10'] });
  assert.deepEqual(result, {
    subtotal: 100,
    coupons: ['SAVE5', 'SAVE10'],
    total: 85,
  });
});

test('REPRO: stacked discounts exceeding the subtotal are floored at 0', () => {
  // WELCOME (15) + SAVE10 (10) = 25 off a subtotal of 20 -> floored to 0.
  const total = applyCoupons({ subtotal: 20 }, ['WELCOME', 'SAVE10']);
  assert.equal(total, 0);
});

// A tiny guard so the expected totals above stay in sync with the catalogue:
// if someone edits a discount value, the intent of the numbers stays obvious.
test('catalogue sanity: coupon discounts are the flat values these expectations assume', () => {
  assert.equal(COUPONS.SAVE5.discount, 5);
  assert.equal(COUPONS.SAVE10.discount, 10);
  assert.equal(COUPONS.WELCOME.discount, 15);
});
