// Minimal smoke test for the validate() core function (task 1.3).
//
// This is a small sanity check that the core wiring works and delegates to the
// schema parsers. The comprehensive, table-driven tests for every schema rule
// and the CLI exit contract belong to task 1.5 (validate.test.js); this file is
// intentionally named `.smoke.` so it does not collide with that later suite.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate, RESOLUTION_ARTIFACTS } from '../core/validate.js';

// A fully valid, resolution-stage workspace snapshot mirroring the reference
// patchwork/ layout. Every RESOLUTION_ARTIFACT is present with valid content.
function validResolvedWorkspace() {
  return {
    board: [
      '# Patchwork Board',
      '',
      'Entry format: `[time] @who \u00B7 Role (human|agent) \u00B7 type:` desc.',
      '',
      '[2024-06-01T14:03Z] @alice \u00B7 Incident Commander (human) \u00B7 report: /checkout 500s',
      '[2024-06-01T14:07Z] @patchwork-sre \u00B7 SRE (agent) \u00B7 analysis: root cause found',
    ].join('\n'),
    incidents: {
      'INC-2024-001': {
        'incident.md': [
          '---',
          'id: INC-2024-001',
          'title: Checkout endpoint returns 500 under coupon stacking',
          'status: RESOLVED',
          'fix_version: 1',
          '---',
        ].join('\n'),
        'analysis.md': '# Analysis\n',
        'fix-proposal.md': [
          '# Fix Proposal',
          '',
          'Proposed fix with tagged remediation steps.',
          '',
          '- [AFK] Revert commit a1b2c3d \u2014 verify: reproduction test passes',
          '- [HITL] Rotate the API key \u2014 verify: Commander confirms new key deployed',
        ].join('\n'),
        'review.md': 'VERDICT: PASS\n',
        'decision-log.md': '# Decision Log\n',
        'postmortem.md': '# Post-mortem\n',
      },
    },
  };
}

test('validate: a fully valid resolved workspace has no problems', () => {
  const result = validate(validResolvedWorkspace());
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('validate: a missing board is reported as a scaffold problem', () => {
  const ws = validResolvedWorkspace();
  delete ws.board;

  const result = validate(ws);
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some(
      (p) => p.rule === 'workspace.board.missing' && p.path === 'patchwork/board.md',
    ),
  );
});

test('validate: a missing incidents directory is reported', () => {
  const result = validate({ board: '# Patchwork Board\n' });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some(
      (p) =>
        p.rule === 'workspace.incidents.missing' &&
        p.path === 'patchwork/incidents',
    ),
  );
});

test('validate: a RESOLVED incident missing an artifact is reported by path', () => {
  const ws = validResolvedWorkspace();
  delete ws.incidents['INC-2024-001']['postmortem.md'];

  const result = validate(ws);
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some(
      (p) =>
        p.rule === 'workspace.artifact.missing' &&
        p.path === 'patchwork/incidents/INC-2024-001/postmortem.md',
    ),
  );
});

test('validate: a malformed board entry is reported against board.md', () => {
  const ws = validResolvedWorkspace();
  // A timeline line (starts with "[") that is missing the (human|agent) role.
  ws.board += '\n[2024-06-01T15:00Z] @bob just some text without the required fields';

  const result = validate(ws);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.path === 'patchwork/board.md'));
});

test('validate: a remediation step missing its verify clause is reported', () => {
  const ws = validResolvedWorkspace();
  ws.incidents['INC-2024-001']['fix-proposal.md'] =
    '# Fix Proposal\n\n- [AFK] Revert commit a1b2c3d on a fix branch\n';

  const result = validate(ws);
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some(
      (p) =>
        p.rule === 'remediation.verify.missing' &&
        p.path === 'patchwork/incidents/INC-2024-001/fix-proposal.md',
    ),
  );
});

test('validate: result is order-independent across incident insertion order', () => {
  const a = validResolvedWorkspace();
  // Add a second, broken incident to produce independent problems.
  a.incidents['INC-2024-002'] = { 'analysis.md': '# only analysis\n' };

  // Same content, incidents inserted in the opposite order.
  const b = { board: a.board, incidents: {} };
  b.incidents['INC-2024-002'] = a.incidents['INC-2024-002'];
  b.incidents['INC-2024-001'] = a.incidents['INC-2024-001'];

  assert.deepEqual(validate(a), validate(b));
});

test('RESOLUTION_ARTIFACTS lists the six resolution-stage artifacts', () => {
  assert.deepEqual([...RESOLUTION_ARTIFACTS], [
    'incident.md',
    'analysis.md',
    'fix-proposal.md',
    'review.md',
    'decision-log.md',
    'postmortem.md',
  ]);
});
