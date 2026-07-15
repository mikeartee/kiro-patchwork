// Minimal smoke test for the fail-closed verdict core (task 3.1).
//
// This is a small sanity check that parseVerdict()/verdict() honour the
// documented exact-match rule and the review.md metadata convention. The
// comprehensive coverage lives in later tasks: Property 1 ("verdict fails
// closed for all non-PASS inputs") is task 3.4, and the RESOLVED-guard edge
// cases are task 3.5. This file is intentionally named `.smoke.` so it does not
// collide with those later suites.
//
// _Requirements: 5.2, 5.3, 10.3_

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseVerdict, verdict } from '../core/verdict.js';

// ---------------------------------------------------------------------------
// parseVerdict — PASS only on an exact canonical verdict line
// ---------------------------------------------------------------------------

test('parseVerdict: exact "VERDICT: PASS" is PASS', () => {
  assert.equal(parseVerdict('VERDICT: PASS'), 'PASS');
});

test('parseVerdict: a trailing newline / whitespace still PASSes', () => {
  assert.equal(parseVerdict('VERDICT: PASS\n'), 'PASS');
  assert.equal(parseVerdict('VERDICT: PASS   \n\n'), 'PASS');
});

test('parseVerdict: a review body followed by a final PASS line is PASS', () => {
  const review = [
    'Reviewer: patchwork-reviewer',
    'Fix-Version: 1',
    '',
    '# Review',
    'Tried to refute the fix; the null branch is now handled.',
    'VERDICT: PASS',
  ].join('\n');
  assert.equal(parseVerdict(review), 'PASS');
});

// ---------------------------------------------------------------------------
// parseVerdict — everything else fails closed to NEEDS_WORK
// ---------------------------------------------------------------------------

const needsWorkCases = [
  { name: 'explicit NEEDS_WORK', text: 'VERDICT: NEEDS_WORK' },
  { name: 'missing verdict line', text: '# Review\nLooks fine to me.' },
  { name: 'empty review', text: '' },
  { name: 'typo (PASSED)', text: 'VERDICT: PASSED' },
  { name: 'no space (VERDICT:PASS)', text: 'VERDICT:PASS' },
  { name: 'lowercase keyword', text: 'verdict: pass' },
  { name: 'extra trailing content', text: 'VERDICT: PASS (looks good)' },
  { name: 'leading indent (code-fenced)', text: '    VERDICT: PASS' },
  { name: 'commented-out html', text: '<!-- VERDICT: PASS -->' },
  { name: 'commented-out markdown heading', text: '# VERDICT: PASS' },
  {
    name: 'conflicting lines (NEEDS_WORK then PASS)',
    text: 'VERDICT: NEEDS_WORK\nVERDICT: PASS',
  },
  {
    name: 'conflicting lines (PASS then NEEDS_WORK)',
    text: 'VERDICT: PASS\nVERDICT: NEEDS_WORK',
  },
];

for (const { name, text } of needsWorkCases) {
  test(`parseVerdict: fails closed to NEEDS_WORK — ${name}`, () => {
    assert.equal(parseVerdict(text), 'NEEDS_WORK');
  });
}

test('parseVerdict: a non-string / unreadable review is NEEDS_WORK', () => {
  assert.equal(parseVerdict(undefined), 'NEEDS_WORK');
  assert.equal(parseVerdict(null), 'NEEDS_WORK');
  assert.equal(parseVerdict(42), 'NEEDS_WORK');
});

// ---------------------------------------------------------------------------
// verdict — extracts the recorded reviewer and fix version when present
// ---------------------------------------------------------------------------

test('verdict: extracts author and fixVersion from the metadata lines', () => {
  const review = [
    'Reviewer: @patchwork-reviewer',
    'Fix-Version: 2',
    '',
    'VERDICT: PASS',
  ].join('\n');

  const result = verdict(review);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.author, 'patchwork-reviewer'); // leading @ stripped
  assert.equal(result.fixVersion, 2); // coerced to an integer
});

test('verdict: omits author and fixVersion when the metadata lines are absent', () => {
  const result = verdict('VERDICT: NEEDS_WORK');
  assert.equal(result.verdict, 'NEEDS_WORK');
  assert.equal('author' in result, false);
  assert.equal('fixVersion' in result, false);
});
