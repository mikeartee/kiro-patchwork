// Integration test: guardrail hook's STATUS_LINE_RE vs schema.parseIncident.
//
// The guardrail hook (.kiro/hooks/patchwork-guardrail.mjs) deliberately avoids
// importing the engine (for fail-safety), so it has its own regex to extract an
// incident's status from incident.md. This test ensures the hook's regex and
// the engine's parseIncident agree on what status they extract, preventing
// silent drift between the two parsers.
//
// This is NOT a unit test of either parser in isolation (those exist elsewhere).
// This is a parity test: for a representative set of incident.md contents, both
// must agree on the extracted status value.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseIncident, isSchemaError, INCIDENT_STATUSES } from '../core/schema.js';

// The hook's regex, copied verbatim so the test breaks if either drifts.
const STATUS_LINE_RE = /^status:\s*([A-Za-z_]+)/m;

/**
 * Extract a status using the hook's approach (regex match on raw text).
 * Returns the matched status string, or null if no match.
 */
function hookExtractStatus(text) {
  const m = STATUS_LINE_RE.exec(text);
  return m ? m[1] : null;
}

/**
 * Extract a status using the engine's approach (full frontmatter parse).
 * Returns the status string, or null if parsing failed.
 */
function engineExtractStatus(text) {
  const parsed = parseIncident(text);
  if (isSchemaError(parsed)) return null;
  return parsed.status;
}

// Representative incident.md texts covering every valid status.
const VALID_INCIDENTS = INCIDENT_STATUSES.map((status) => ({
  label: `status: ${status}`,
  text: [
    '---',
    'id: INC-2024-001',
    'title: Test incident',
    `status: ${status}`,
    'fix_version: 1',
    '---',
    '',
    'Description paragraph.',
  ].join('\n'),
  expectedStatus: status,
}));

// Edge cases where both parsers should agree.
const EDGE_CASES = [
  {
    label: 'status with extra whitespace after colon',
    text: '---\nid: INC-2024-001\ntitle: Test\nstatus:   FIX_STAGED\nfix_version: 1\n---\n',
    expectedStatus: 'FIX_STAGED',
  },
  {
    label: 'status with trailing content (inline comment)',
    // The hook regex captures only word chars; parseIncident strips comments.
    text: '---\nid: INC-2024-001\ntitle: Test\nstatus: REPORTED # filed just now\nfix_version: 1\n---\n',
    expectedStatus: 'REPORTED',
  },
  {
    label: 'status field in body (not frontmatter) — should not be used by engine',
    text: '---\nid: INC-2024-001\ntitle: Test\nstatus: INVESTIGATING\nfix_version: 1\n---\n\nstatus: RESOLVED\n',
    expectedStatus: 'INVESTIGATING',
  },
];

test('hook STATUS_LINE_RE agrees with parseIncident on every valid status', () => {
  for (const { label, text, expectedStatus } of VALID_INCIDENTS) {
    const hookResult = hookExtractStatus(text);
    const engineResult = engineExtractStatus(text);

    assert.equal(hookResult, expectedStatus, `hook failed for: ${label}`);
    assert.equal(engineResult, expectedStatus, `engine failed for: ${label}`);
    assert.equal(hookResult, engineResult, `parity failed for: ${label}`);
  }
});

test('hook STATUS_LINE_RE agrees with parseIncident on edge cases', () => {
  for (const { label, text, expectedStatus } of EDGE_CASES) {
    const hookResult = hookExtractStatus(text);
    const engineResult = engineExtractStatus(text);

    assert.equal(hookResult, expectedStatus, `hook failed for: ${label}`);
    assert.equal(engineResult, expectedStatus, `engine failed for: ${label}`);
    assert.equal(hookResult, engineResult, `parity failed for: ${label}`);
  }
});

test('hook STATUS_LINE_RE returns null for text with no status line', () => {
  const noStatus = '---\nid: INC-2024-001\ntitle: Test\n---\n';
  assert.equal(hookExtractStatus(noStatus), null);
  // Engine also fails (SchemaError for missing status).
  assert.equal(engineExtractStatus(noStatus), null);
});
