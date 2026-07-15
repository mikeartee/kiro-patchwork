// Tests for the shared schema parsers (task 1.2), written test-first.
//
// Covers parseIncident / parseBoardEntry / parseRemediationStep: one passing
// case each plus one test per protocol violation. The board-entry separator is
// the middle dot U+00B7 ("\u00B7") and remediation steps use an em dash U+2014.
//
// _Requirements: 1.3, 2.2, 9.1, 9.2_

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseIncident,
  parseBoardEntry,
  parseRemediationStep,
  SchemaError,
  isSchemaError,
  INCIDENT_STATUSES,
} from '../core/schema.js';

// ---------------------------------------------------------------------------
// SchemaError shape
// ---------------------------------------------------------------------------

test('SchemaError carries a rule, a message, and an offending field', () => {
  const err = new SchemaError('some.rule', 'a message', 'someField');
  assert.ok(isSchemaError(err));
  assert.equal(err.rule, 'some.rule');
  assert.equal(err.message, 'a message');
  assert.equal(err.field, 'someField');
});

test('INCIDENT_STATUSES holds the nine defined statuses in order', () => {
  assert.deepEqual([...INCIDENT_STATUSES], [
    'REPORTED',
    'INVESTIGATING',
    'ANALYSIS_READY',
    'AWAITING_APPROVAL',
    'APPROVED',
    'FIX_STAGED',
    'RESOLVED',
    'CHANGES_REQUESTED',
    'PARKED_FOR_HUMAN',
  ]);
});

// ---------------------------------------------------------------------------
// parseIncident
// ---------------------------------------------------------------------------

test('parseIncident: valid frontmatter returns id, title, status, fix_version', () => {
  const text = [
    '---',
    'id: INC-2024-001',
    'title: Checkout endpoint returns 500 under coupon stacking',
    'status: INVESTIGATING',
    'fix_version: 1',
    '---',
    '',
    'Body text that should be ignored by the parser.',
  ].join('\n');

  const result = parseIncident(text);

  assert.ok(!isSchemaError(result), 'expected a parsed object, not a SchemaError');
  assert.deepEqual(result, {
    id: 'INC-2024-001',
    title: 'Checkout endpoint returns 500 under coupon stacking',
    status: 'INVESTIGATING',
    fix_version: 1,
  });
});

test('parseIncident: tolerates inline YAML comments on status and fix_version', () => {
  // The design frontmatter example carries trailing "# ..." comments.
  const text = [
    '---',
    'id: INC-2024-002',
    'title: Something broke',
    'status: REPORTED   # one of the Incident_Status enum values',
    'fix_version: 2      # incremented each revision cycle',
    '---',
  ].join('\n');

  const result = parseIncident(text);

  assert.ok(!isSchemaError(result));
  assert.equal(result.status, 'REPORTED');
  assert.equal(result.fix_version, 2);
});

test('parseIncident: missing status field is a SchemaError', () => {
  const text = [
    '---',
    'id: INC-2024-003',
    'title: No status here',
    'fix_version: 1',
    '---',
  ].join('\n');

  const result = parseIncident(text);

  assert.ok(isSchemaError(result), 'expected a SchemaError');
  assert.equal(result.field, 'status');
  assert.match(result.rule, /status/);
});

test('parseIncident: unknown status value is a SchemaError', () => {
  const text = [
    '---',
    'id: INC-2024-004',
    'title: Bad status',
    'status: FIXING_IT_NOW',
    'fix_version: 1',
    '---',
  ].join('\n');

  const result = parseIncident(text);

  assert.ok(isSchemaError(result));
  assert.equal(result.field, 'status');
  assert.equal(result.rule, 'incident.status.unknown');
});

// ---------------------------------------------------------------------------
// parseBoardEntry   grammar: [time] @who · Role (human|agent) · type: desc
// ---------------------------------------------------------------------------

test('parseBoardEntry: valid human entry parses all fields', () => {
  const line =
    '[2024-06-01T14:03Z] @alice \u00B7 Incident Commander (human) \u00B7 report: /checkout 500s on coupon stacking';

  const result = parseBoardEntry(line);

  assert.ok(!isSchemaError(result));
  assert.deepEqual(result, {
    time: '2024-06-01T14:03Z',
    who: 'alice',
    role: 'Incident Commander',
    kind: 'human',
    type: 'report',
    description: '/checkout 500s on coupon stacking',
  });
});

test('parseBoardEntry: valid agent entry parses kind=agent', () => {
  const line =
    '[2024-06-01T14:07Z] @patchwork-sre \u00B7 SRE (agent) \u00B7 analysis: root cause traced to commit a1b2c3d';

  const result = parseBoardEntry(line);

  assert.ok(!isSchemaError(result));
  assert.equal(result.who, 'patchwork-sre');
  assert.equal(result.role, 'SRE');
  assert.equal(result.kind, 'agent');
  assert.equal(result.type, 'analysis');
});

test('parseBoardEntry: missing author (@who) is a SchemaError', () => {
  const line =
    '[2024-06-01T14:03Z] Incident Commander (human) \u00B7 report: coupon stacking';

  const result = parseBoardEntry(line);

  assert.ok(isSchemaError(result));
  assert.equal(result.field, 'author');
});

test('parseBoardEntry: missing role is a SchemaError', () => {
  const line = '[2024-06-01T14:03Z] @alice \u00B7 report: coupon stacking';

  const result = parseBoardEntry(line);

  assert.ok(isSchemaError(result));
  assert.equal(result.field, 'role');
});

test('parseBoardEntry: missing contribution type is a SchemaError', () => {
  const line =
    '[2024-06-01T14:03Z] @alice \u00B7 Incident Commander (human) \u00B7 coupon stacking';

  const result = parseBoardEntry(line);

  assert.ok(isSchemaError(result));
  assert.equal(result.field, 'type');
});

// ---------------------------------------------------------------------------
// parseRemediationStep   grammar: [AFK|HITL] action ... verify: check
// ---------------------------------------------------------------------------

test('parseRemediationStep: valid AFK step parses tag, text, verification', () => {
  const line =
    '- [AFK] Revert commit a1b2c3d on a fix branch \u2014 verify: reproduction test passes';

  const result = parseRemediationStep(line);

  assert.ok(!isSchemaError(result));
  assert.deepEqual(result, {
    tag: 'AFK',
    text: 'Revert commit a1b2c3d on a fix branch',
    verification: 'reproduction test passes',
  });
});

test('parseRemediationStep: valid HITL step parses tag=HITL', () => {
  const line =
    '- [HITL] Rotate the leaked coupon-service API key \u2014 verify: Commander confirms new key deployed';

  const result = parseRemediationStep(line);

  assert.ok(!isSchemaError(result));
  assert.equal(result.tag, 'HITL');
  assert.equal(result.text, 'Rotate the leaked coupon-service API key');
  assert.equal(result.verification, 'Commander confirms new key deployed');
});

test('parseRemediationStep: missing [AFK]/[HITL] tag is a SchemaError', () => {
  const line =
    '- Revert commit a1b2c3d on a fix branch \u2014 verify: reproduction test passes';

  const result = parseRemediationStep(line);

  assert.ok(isSchemaError(result));
  assert.equal(result.field, 'tag');
  assert.equal(result.rule, 'remediation.tag.missing');
});

test('parseRemediationStep: missing verify: clause is a SchemaError', () => {
  const line = '- [AFK] Revert commit a1b2c3d on a fix branch';

  const result = parseRemediationStep(line);

  assert.ok(isSchemaError(result));
  assert.equal(result.field, 'verification');
  assert.equal(result.rule, 'remediation.verify.missing');
});
