// Tests for the optional read-only room dashboard (task 16).
//
// These exercise the PURE render core (engine/core/dashboard.js). By
// construction the test feeds an in-memory workspace snapshot straight to
// renderDashboard and asserts on the returned HTML string: the render performs
// NO disk/network/LLM access and NO writes — it only reads the snapshot object
// and returns text. The "does not mutate the snapshot" test below makes that
// no-writes property concrete by deep-freezing the input, which would throw on
// any attempted write (Requirement 17.3). Disk I/O lives only in the thin
// adapter engine/dashboard.js and is out of scope here.
//
// Coverage:
//   - the current Incident_Status appears for each incident (Requirement 17.1)
//   - recent board entries appear with correct role badges     (Requirement 17.2)
//   - rendering is read-only / non-mutating                    (Requirement 17.3)
//
// _Requirements: 17.1, 17.2, 17.3_

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderDashboard, roleBadge, RECENT_ENTRY_LIMIT } from '../core/dashboard.js';

const DOT = '\u00B7'; // middle-dot separator used in board entries
const DASH = '\u2014'; // em dash used before a remediation verify: clause
const INC = 'INC-2024-001';

// ---------------------------------------------------------------------------
// Snapshot factory (fresh object each call, mirrors the reference workspace)
// ---------------------------------------------------------------------------

/** A small valid workspace snapshot: one RESOLVED incident + a three-line board
 * covering the Human, SRE, and Reviewer roles. */
function sampleWorkspace() {
  return {
    board: [
      '# Patchwork Board',
      '',
      `Entry format: [time] @who ${DOT} Role (human|agent) ${DOT} type: desc.`,
      '',
      `[2024-06-01T14:03Z] @alice ${DOT} Incident Commander (human) ${DOT} report: /checkout 500s on coupon stacking`,
      `[2024-06-01T14:07Z] @patchwork-sre ${DOT} SRE (agent) ${DOT} analysis: root cause traced to commit a1b2c3d`,
      `[2024-06-01T14:20Z] @patchwork-reviewer ${DOT} Reviewer (agent) ${DOT} verdict: PASS ${DASH} fix addresses the null branch`,
    ].join('\n'),
    incidents: {
      [INC]: {
        'incident.md': [
          '---',
          `id: ${INC}`,
          'title: Checkout endpoint returns 500 under coupon stacking',
          'status: RESOLVED',
          'fix_version: 1',
          '---',
        ].join('\n'),
        'analysis.md': '# Analysis\n',
        'fix-proposal.md': `- [AFK] Revert commit a1b2c3d ${DASH} verify: reproduction test passes\n`,
        'review.md': 'VERDICT: PASS\n',
        'decision-log.md': '# Decision Log\n',
        'postmortem.md': '# Post-mortem\n',
      },
    },
  };
}

/** Recursively freeze an object so any write attempt during rendering throws. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Requirement 17.1 - current Incident_Status per incident
// ---------------------------------------------------------------------------

test('dashboard: renders the current Incident_Status for each incident (17.1)', () => {
  const html = renderDashboard(sampleWorkspace());
  assert.equal(typeof html, 'string');
  assert.ok(html.includes(INC), 'incident id should appear');
  assert.ok(
    html.includes('Status:') && html.includes('RESOLVED'),
    'the current status RESOLVED should be rendered',
  );
});

test('dashboard: a missing/unparseable incident.md renders as UNKNOWN, not a crash', () => {
  const ws = sampleWorkspace();
  delete ws.incidents[INC]['incident.md'];
  const html = renderDashboard(ws);
  assert.ok(html.includes('UNKNOWN'), 'absent incident.md should read as UNKNOWN status');
});

// ---------------------------------------------------------------------------
// Requirement 17.2 - recent board entries with correct role badges
// ---------------------------------------------------------------------------

test('dashboard: renders recent board entries with Human/SRE/Reviewer badges (17.2)', () => {
  const html = renderDashboard(sampleWorkspace());

  // The three authors appear.
  assert.ok(html.includes('@alice'), 'human author should appear');
  assert.ok(html.includes('@patchwork-sre'), 'SRE author should appear');
  assert.ok(html.includes('@patchwork-reviewer'), 'reviewer author should appear');

  // Each maps to the correct badge.
  assert.ok(html.includes('badge-human'), 'human contribution should badge as Human');
  assert.ok(html.includes('badge-sre'), 'SRE contribution should badge as SRE');
  assert.ok(html.includes('badge-reviewer'), 'reviewer contribution should badge as Reviewer');

  // And a description from a recent entry is surfaced.
  assert.ok(
    html.includes('root cause traced to commit a1b2c3d'),
    'a recent board entry description should be rendered',
  );
});

test('roleBadge: maps role/kind onto the four dashboard badges', () => {
  assert.equal(roleBadge({ role: 'Incident Commander', kind: 'human' }), 'Human');
  assert.equal(roleBadge({ role: 'SRE', kind: 'agent' }), 'SRE');
  assert.equal(roleBadge({ role: 'Reviewer', kind: 'agent' }), 'Reviewer');
  assert.equal(roleBadge({ role: 'Scribe', kind: 'agent' }), 'Scribe');
  // Any human kind badges as Human regardless of stated role.
  assert.equal(roleBadge({ role: 'Observer', kind: 'human' }), 'Human');
});

test('dashboard: surfaces only the most recent RECENT_ENTRY_LIMIT entries', () => {
  const ws = sampleWorkspace();
  const lines = ['# Patchwork Board', ''];
  // Build more entries than the cap; only the tail should be rendered.
  const total = RECENT_ENTRY_LIMIT + 5;
  for (let i = 0; i < total; i++) {
    lines.push(
      `[2024-06-01T${String(i).padStart(2, '0')}:00Z] @alice ${DOT} Incident Commander (human) ${DOT} note: entry number ${i}`,
    );
  }
  ws.board = lines.join('\n');

  const html = renderDashboard(ws);
  // The oldest entries (0..4) are dropped; the newest (total-1) is kept.
  assert.ok(html.includes(`entry number ${total - 1}`), 'newest entry should be rendered');
  assert.ok(!html.includes('entry number 0'), 'oldest entry beyond the cap should be dropped');
});

// ---------------------------------------------------------------------------
// Requirement 17.3 - read-only: rendering never mutates the workspace snapshot
// ---------------------------------------------------------------------------

test('dashboard: rendering does not mutate the snapshot (read-only) (17.3)', () => {
  // Deep-freezing the snapshot turns any accidental write into a thrown error,
  // proving the render only reads its input and returns a string.
  const frozen = deepFreeze(sampleWorkspace());
  assert.doesNotThrow(() => renderDashboard(frozen));

  const html = renderDashboard(frozen);
  assert.ok(html.startsWith('<!doctype html>'), 'output is an HTML document string');
});

test('dashboard: an empty workspace renders placeholders rather than throwing', () => {
  const html = renderDashboard({ board: null, incidents: null });
  assert.ok(html.includes('No incidents yet.'), 'empty incidents renders a placeholder');
  assert.ok(html.includes('No board entries yet.'), 'empty board renders a placeholder');
});
