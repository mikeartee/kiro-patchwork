// Tests for the post-mortem structural validator and the decision-log
// append-only helpers (task 9.2).
//
// The Scribe agent (.kiro/agents/patchwork-scribe.md) COMPILES postmortem.md as
// model-generated prose and MAINTAINS decision-log.md as an append-only record.
// Neither is produced deterministically by the engine, so these tests pin the
// load-bearing guarantees the Scribe promises WITHOUT relying on model
// judgement:
//
//   validatePostmortem  - a compiled postmortem.md carries the required title,
//                         identifier line, the three required sections
//                         (Root cause / Applied fix / Review outcome), and links
//                         all five source artifacts (Requirements 7.3, 7.4).
//   appendDecision /
//   isAppendOnly        - appending to decision-log.md preserves every existing
//                         entry verbatim as a prefix (Requirement 7.2).
//
// The fixtures below mirror the EXACT headings documented in the Scribe prompt
// so the test is meaningful against real Scribe output, not an invented shape.
//
// _Requirements: 7.2, 7.3, 7.4_

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validatePostmortem,
  appendDecision,
  isAppendOnly,
  POSTMORTEM_SOURCE_ARTIFACTS,
} from '../core/postmortem.js';

const DASH = '\u2014'; // em dash used before a remediation verify: clause
const INC = 'INC-2024-001';
const POSTMORTEM_PATH = `patchwork/incidents/${INC}/postmortem.md`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A fully valid compiled post-mortem, matching the Scribe prompt's template:
 * the `# Post-mortem - INC-<id>` title, the `Incident: INC-<id>` identifier
 * line, the three required sections, and a `## Source artifacts` list naming
 * all five sources. Fresh string each call so per-case mutations never leak.
 */
function validPostmortem(incidentId = INC) {
  return [
    `# Post-mortem - ${incidentId}`,
    '',
    `Incident: ${incidentId}`,
    'Status: RESOLVED',
    '',
    '## Summary',
    '',
    'The /checkout endpoint returned 500 under coupon stacking. The additive-',
    'discount fix was reviewed, approved, staged, and the incident resolved.',
    '',
    '## Root cause',
    '',
    'From analysis.md: coupon stacking multiplied discounts instead of adding',
    'them, driving the total negative. Introduced by commit a1b2c3d.',
    '',
    '## Applied fix',
    '',
    'From fix-proposal.md: switch coupon composition to additive discounts and',
    'clamp the total at zero. Remediation steps:',
    '',
    `- [AFK] Apply the additive-discount patch ${DASH} verify: reproduction test passes`,
    `- [HITL] Confirm the coupon-service redeploy ${DASH} verify: Commander confirms deploy`,
    '',
    '## Review outcome',
    '',
    'From review.md: the Reviewer (@patchwork-reviewer) returned a PASS. The',
    'reviewer differs from the fix author, so this is a non-author review.',
    '',
    '## Timeline and decisions',
    '',
    'From decision-log.md: incident opened 14:10Z, fix approved 14:25Z.',
    '',
    '## Source artifacts',
    '',
    '- incident.md',
    '- analysis.md',
    '- fix-proposal.md',
    '- review.md',
    '- decision-log.md',
    '',
  ].join('\n');
}

/**
 * A realistic append-only decision log with a header, intro prose, and one
 * existing entry, matching the Scribe prompt's per-entry format.
 */
function existingDecisionLog(incidentId = INC) {
  return [
    `# Decision Log - ${incidentId}`,
    '',
    'Append-only decision log maintained by the Scribe agent. New decisions are',
    'appended in chronological order and existing entries are never rewritten.',
    '',
    '## [2024-06-01T14:10Z] Open incident',
    '',
    '- Decision: Open INC-2024-001 for the /checkout 500 under coupon stacking.',
    '- Made by: @alice (Incident Commander)',
    '- Rationale: Reproduction test fails; access log shows repeated 500s.',
    '- Refs: incident.md',
    '',
  ].join('\n');
}

/** A new decision entry to append below the existing log. */
function newDecisionEntry() {
  return [
    '## [2024-06-01T14:25Z] Approve additive-discount fix',
    '',
    '- Decision: Approve the SRE additive-discount fix for the coupon 500.',
    '- Made by: @alice (Incident Commander)',
    '- Rationale: Reviewer returned a non-author PASS; root cause proven.',
    '- Refs: fix-proposal.md, review.md',
    '',
  ].join('\n');
}

/** Assert a Problem with the given rule and path is present. */
function hasProblem(result, rule, path) {
  return result.problems.some((p) => p.rule === rule && p.path === path);
}

// ===========================================================================
// validatePostmortem - valid compiled post-mortem (Requirements 7.3, 7.4)
// ===========================================================================

test('validatePostmortem: valid compiled post-mortem is ok with no problems', () => {
  const result = validatePostmortem(validPostmortem(), { incidentId: INC });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('validatePostmortem: valid post-mortem passes generic check (no incidentId)', () => {
  const result = validatePostmortem(validPostmortem());
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('validatePostmortem: a valid post-mortem links every source artifact', () => {
  // Req 7.3: the compiled post-mortem is drawn FROM the whole artifact chain,
  // so every one of the five sources must be referenced.
  const text = validPostmortem();
  for (const artifact of POSTMORTEM_SOURCE_ARTIFACTS) {
    assert.ok(
      text.includes(artifact),
      `fixture should reference source artifact ${artifact}`,
    );
  }
  const result = validatePostmortem(text, { incidentId: INC });
  assert.equal(result.ok, true);
});

test('POSTMORTEM_SOURCE_ARTIFACTS is the five-source chain, excluding the output', () => {
  assert.deepEqual([...POSTMORTEM_SOURCE_ARTIFACTS], [
    'incident.md',
    'analysis.md',
    'fix-proposal.md',
    'review.md',
    'decision-log.md',
  ]);
  // postmortem.md is the compiled OUTPUT, not a source it draws from.
  assert.ok(!POSTMORTEM_SOURCE_ARTIFACTS.includes('postmortem.md'));
});

// ===========================================================================
// validatePostmortem - table-driven violations, one per rule (Req 7.3, 7.4)
// ===========================================================================

const violationCases = [
  {
    name: 'missing the "# Post-mortem - INC-<id>" title line',
    rule: 'postmortem.title.missing',
    mutate: (text) => text.replace(`# Post-mortem - ${INC}`, '# Something else'),
  },
  {
    name: 'missing the "Incident: INC-<id>" identifier line',
    rule: 'postmortem.identifier.missing',
    mutate: (text) => text.replace(`\nIncident: ${INC}\n`, '\n'),
  },
  {
    name: 'missing the "## Root cause" section',
    rule: 'postmortem.root_cause.missing',
    mutate: (text) => text.replace('## Root cause', '## Cause notes'),
  },
  {
    name: 'missing the "## Applied fix" section',
    rule: 'postmortem.applied_fix.missing',
    mutate: (text) => text.replace('## Applied fix', '## The fix we did'),
  },
  {
    name: 'missing the "## Review outcome" section',
    rule: 'postmortem.review_outcome.missing',
    mutate: (text) => text.replace('## Review outcome', '## What the review said'),
  },
];

for (const { name, rule, mutate } of violationCases) {
  test(`validatePostmortem: ${name} -> ${rule}`, () => {
    const text = mutate(validPostmortem());
    const result = validatePostmortem(text, { incidentId: INC });

    assert.equal(result.ok, false, 'expected ok:false for a violation');
    assert.ok(
      hasProblem(result, rule, POSTMORTEM_PATH),
      `expected a problem { rule: "${rule}", path: "${POSTMORTEM_PATH}" }, got ${JSON.stringify(result.problems)}`,
    );
  });
}

// A missing artifact reference is reported per unlinked source (Req 7.3).
for (const artifact of POSTMORTEM_SOURCE_ARTIFACTS) {
  test(`validatePostmortem: unlinked source artifact ${artifact} is reported`, () => {
    // Remove every occurrence of the artifact name so it is truly unreferenced.
    const text = validPostmortem().split(artifact).join('(removed)');
    const result = validatePostmortem(text, { incidentId: INC });

    assert.equal(result.ok, false);
    assert.ok(
      hasProblem(result, 'postmortem.artifact.unlinked', POSTMORTEM_PATH),
      `expected an unlinked-artifact problem for ${artifact}`,
    );
  });
}

test('validatePostmortem: non-string input is rejected fail-closed', () => {
  const result = validatePostmortem(undefined, { incidentId: INC });
  assert.equal(result.ok, false);
  assert.ok(hasProblem(result, 'postmortem.text.missing', POSTMORTEM_PATH));
});

test('validatePostmortem: title/identifier pinned to the wrong incident id fail', () => {
  // The post-mortem is for INC-2024-001 but we validate it against a different
  // id: the title and identifier checks must not match.
  const result = validatePostmortem(validPostmortem(INC), {
    incidentId: 'INC-2024-999',
  });
  assert.equal(result.ok, false);
  assert.ok(
    hasProblem(
      result,
      'postmortem.title.missing',
      'patchwork/incidents/INC-2024-999/postmortem.md',
    ),
  );
  assert.ok(
    hasProblem(
      result,
      'postmortem.identifier.missing',
      'patchwork/incidents/INC-2024-999/postmortem.md',
    ),
  );
});

test('validatePostmortem: an empty placeholder post-mortem is rejected', () => {
  // The seeded INC-2024-001 postmortem.md placeholder has only a title line and
  // prose; it lacks the required sections and artifact links, so it must fail
  // until the Scribe compiles it.
  const placeholder = [
    `# Post-mortem - ${INC}`,
    '',
    'Compiled by the Scribe agent from the incident artifact chain.',
    '',
  ].join('\n');

  const result = validatePostmortem(placeholder, { incidentId: INC });
  assert.equal(result.ok, false);
  // At minimum the three sections and all five artifact links are missing.
  assert.ok(hasProblem(result, 'postmortem.root_cause.missing', POSTMORTEM_PATH));
  assert.ok(hasProblem(result, 'postmortem.applied_fix.missing', POSTMORTEM_PATH));
  assert.ok(
    hasProblem(result, 'postmortem.review_outcome.missing', POSTMORTEM_PATH),
  );
});

// ===========================================================================
// appendDecision / isAppendOnly - append-only preservation (Requirement 7.2)
// ===========================================================================

test('appendDecision: preserves the existing log verbatim as a prefix', () => {
  const before = existingDecisionLog();
  const after = appendDecision(before, newDecisionEntry());

  // Every existing byte is reproduced unchanged at the start of the result.
  assert.ok(after.startsWith(before), 'existing log must be an exact prefix');
});

test('appendDecision: preserves the header and every existing entry', () => {
  const before = existingDecisionLog();
  const after = appendDecision(before, newDecisionEntry());

  assert.ok(after.includes(`# Decision Log - ${INC}`), 'header preserved');
  assert.ok(
    after.includes('## [2024-06-01T14:10Z] Open incident'),
    'prior entry preserved',
  );
  assert.ok(
    after.includes('## [2024-06-01T14:25Z] Approve additive-discount fix'),
    'new entry appended',
  );
});

test('appendDecision: the new entry appears strictly after the prior entry', () => {
  const before = existingDecisionLog();
  const after = appendDecision(before, newDecisionEntry());

  const priorIdx = after.indexOf('Open incident');
  const newIdx = after.indexOf('Approve additive-discount fix');
  assert.ok(priorIdx !== -1 && newIdx !== -1);
  assert.ok(newIdx > priorIdx, 'newest entry must be at the bottom');
});

test('appendDecision: appending to an empty log yields just the entry', () => {
  const entry = newDecisionEntry();
  const after = appendDecision('', entry);
  assert.equal(after, entry);
});

test('appendDecision: sequential appends preserve all prior entries in order', () => {
  const e1 = '## [t1] one\n\n- Decision: first\n';
  const e2 = '## [t2] two\n\n- Decision: second\n';
  const e3 = '## [t3] three\n\n- Decision: third\n';

  const log0 = existingDecisionLog();
  const log1 = appendDecision(log0, e1);
  const log2 = appendDecision(log1, e2);
  const log3 = appendDecision(log2, e3);

  // Each step is an append-only evolution of the previous one.
  assert.ok(log1.startsWith(log0));
  assert.ok(log2.startsWith(log1));
  assert.ok(log3.startsWith(log2));

  // All three entries survive in chronological order.
  const i1 = log3.indexOf('[t1] one');
  const i2 = log3.indexOf('[t2] two');
  const i3 = log3.indexOf('[t3] three');
  assert.ok(i1 !== -1 && i2 !== -1 && i3 !== -1);
  assert.ok(i1 < i2 && i2 < i3);
});

test('isAppendOnly: true when the result preserves the prior log as a prefix', () => {
  const before = existingDecisionLog();
  const after = appendDecision(before, newDecisionEntry());
  assert.equal(isAppendOnly(before, after), true);
});

test('isAppendOnly: false when a prior entry is dropped', () => {
  const before = existingDecisionLog();
  // Rebuild a log that drops the "Open incident" entry and keeps only a new one.
  const tampered = [
    `# Decision Log - ${INC}`,
    '',
    'Append-only decision log maintained by the Scribe agent. New decisions are',
    'appended in chronological order and existing entries are never rewritten.',
    '',
    newDecisionEntry(),
  ].join('\n');

  assert.equal(isAppendOnly(before, tampered), false);
});

test('isAppendOnly: false when a prior entry is edited in place', () => {
  const before = existingDecisionLog();
  // Edit the rationale of the existing entry, then append a new one.
  const edited = before.replace(
    'Reproduction test fails; access log shows repeated 500s.',
    'Edited rationale that rewrites history.',
  );
  const after = appendDecision(edited, newDecisionEntry());

  assert.equal(isAppendOnly(before, after), false);
});

test('isAppendOnly: false when prior entries are reordered', () => {
  const before = [
    '## [t1] one',
    '## [t2] two',
    '',
  ].join('\n');
  const reordered = [
    '## [t2] two',
    '## [t1] one',
    '',
  ].join('\n');

  assert.equal(isAppendOnly(before, reordered), false);
});

test('isAppendOnly: non-string inputs are rejected fail-closed', () => {
  assert.equal(isAppendOnly(undefined, 'x'), false);
  assert.equal(isAppendOnly('x', undefined), false);
  assert.equal(isAppendOnly(null, null), false);
});
