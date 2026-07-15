// Comprehensive, table-driven tests for the validate() core command (task 1.5).
//
// The smoke test (validate.smoke.test.js) is a minimal sanity check and stays.
// This suite exercises EVERY schema rule that validate() can emit, through
// validate() itself: one valid baseline plus one violation case per rule,
// asserting the expected Problem { rule, path } appears and that a valid
// snapshot yields { ok: true, problems: [] }.
//
// Rules reachable through validate() (see engine/core/validate.js and schema.js):
//   scaffold      : workspace.board.missing, workspace.incidents.missing
//   artifacts     : workspace.artifact.missing (incident.md + resolution set)
//   board entries : board.author.missing, board.role.missing, board.type.missing,
//                   board.malformed
//   incident      : incident.frontmatter.missing, incident.id.missing,
//                   incident.title.missing, incident.status.missing,
//                   incident.status.unknown
//   remediation   : remediation.tag.missing, remediation.verify.missing
//
// _Requirements: 1.5, 2.4, 9.4, 10.1_

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate, RESOLUTION_ARTIFACTS } from '../core/validate.js';

const DOT = '\u00B7'; // middle dot separator used in board entries
const DASH = '\u2014'; // em dash used before a remediation verify: clause
const INC = 'INC-2024-001';
const INCIDENT_DIR = `patchwork/incidents/${INC}`;

// ---------------------------------------------------------------------------
// Snapshot factories (fresh objects each call, so table mutations never leak)
// ---------------------------------------------------------------------------

/** A valid board with a header, a prose line, and two well-formed entries. */
function validBoard() {
  return [
    '# Patchwork Board',
    '',
    `Entry format: [time] @who ${DOT} Role (human|agent) ${DOT} type: desc.`,
    '',
    `[2024-06-01T14:03Z] @alice ${DOT} Incident Commander (human) ${DOT} report: /checkout 500s`,
    `[2024-06-01T14:07Z] @patchwork-sre ${DOT} SRE (agent) ${DOT} analysis: root cause found`,
  ].join('\n');
}

/** A valid fix-proposal.md with one AFK and one HITL remediation step. */
function validFixProposal() {
  return [
    '# Fix Proposal',
    '',
    'Proposed fix with tagged remediation steps.',
    '',
    `- [AFK] Revert commit a1b2c3d ${DASH} verify: reproduction test passes`,
    `- [HITL] Rotate the API key ${DASH} verify: Commander confirms new key deployed`,
  ].join('\n');
}

/** Incident frontmatter text for a given status (all required fields present). */
function incidentMd(status, { fixVersion = 1 } = {}) {
  return [
    '---',
    `id: ${INC}`,
    'title: Checkout endpoint returns 500 under coupon stacking',
    `status: ${status}`,
    `fix_version: ${fixVersion}`,
    '---',
  ].join('\n');
}

/**
 * A fully valid RESOLVED workspace holding the complete artifact set. Used as
 * the base for most violation cases (mutate one thing, assert one rule).
 */
function validResolvedWorkspace() {
  return {
    board: validBoard(),
    incidents: {
      [INC]: {
        'incident.md': incidentMd('RESOLVED'),
        'analysis.md': '# Analysis\n',
        'fix-proposal.md': validFixProposal(),
        'review.md': 'VERDICT: PASS\n',
        'decision-log.md': '# Decision Log\n',
        'postmortem.md': [
          `# Post-mortem - ${INC}`,
          '',
          `Incident: ${INC}`,
          '',
          '## Root cause',
          '',
          'Null reference in coupon stacking path.',
          '',
          '## Applied fix',
          '',
          'Added tier data to the coupon catalogue.',
          '',
          '## Review outcome',
          '',
          'Reviewer passed the fix.',
          '',
          '## Source artifacts',
          '',
          '- incident.md',
          '- analysis.md',
          '- fix-proposal.md',
          '- review.md',
          '- decision-log.md',
          '',
        ].join('\n'),
      },
    },
  };
}

/** A valid non-resolution (INVESTIGATING) workspace: incident.md only. */
function validInvestigatingWorkspace() {
  return {
    board: validBoard(),
    incidents: {
      [INC]: {
        'incident.md': incidentMd('INVESTIGATING'),
      },
    },
  };
}

/** Assert a Problem with the given rule and path is present. */
function hasProblem(result, rule, path) {
  return result.problems.some((p) => p.rule === rule && p.path === path);
}

// ---------------------------------------------------------------------------
// Valid snapshots: ok === true, problems === []
// ---------------------------------------------------------------------------

test('validate: fully valid RESOLVED workspace yields ok:true, problems:[]', () => {
  const result = validate(validResolvedWorkspace());
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('validate: valid INVESTIGATING incident (incident.md only) is ok', () => {
  const result = validate(validInvestigatingWorkspace());
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('validate: empty incidents directory with a valid board is ok', () => {
  const result = validate({ board: validBoard(), incidents: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

// ---------------------------------------------------------------------------
// Table-driven violations: each row triggers exactly one target rule
// ---------------------------------------------------------------------------

const violationCases = [
  // --- scaffold ---------------------------------------------------------
  {
    name: 'missing board file',
    rule: 'workspace.board.missing',
    path: 'patchwork/board.md',
    mutate(ws) {
      delete ws.board;
    },
  },
  {
    name: 'missing incidents directory',
    rule: 'workspace.incidents.missing',
    path: 'patchwork/incidents',
    mutate(ws) {
      delete ws.incidents;
    },
  },

  // --- board entry grammar ---------------------------------------------
  {
    name: 'board entry missing @author',
    rule: 'board.author.missing',
    path: 'patchwork/board.md',
    mutate(ws) {
      ws.board += `\n[2024-06-01T15:00Z] Incident Commander (human) ${DOT} report: no author here`;
    },
  },
  {
    name: 'board entry missing Role (human|agent)',
    rule: 'board.role.missing',
    path: 'patchwork/board.md',
    mutate(ws) {
      ws.board += `\n[2024-06-01T15:00Z] @bob ${DOT} report: no role designation here`;
    },
  },
  {
    name: 'board entry missing type: field',
    rule: 'board.type.missing',
    path: 'patchwork/board.md',
    mutate(ws) {
      ws.board += `\n[2024-06-01T15:00Z] @bob ${DOT} Incident Commander (human) ${DOT} no type colon here`;
    },
  },
  {
    name: 'board entry present-fields but malformed grammar',
    rule: 'board.malformed',
    path: 'patchwork/board.md',
    mutate(ws) {
      // Has @who, has (human), has ") · type:" but is missing the middle-dot
      // separator after @bob, so the full grammar fails as board.malformed.
      ws.board += `\n[2024-06-01T15:00Z] @bob Incident Commander (human) ${DOT} report: missing separator`;
    },
  },

  // --- incident frontmatter --------------------------------------------
  {
    name: 'incident.md missing entirely',
    rule: 'workspace.artifact.missing',
    path: `${INCIDENT_DIR}/incident.md`,
    mutate(ws) {
      delete ws.incidents[INC]['incident.md'];
    },
  },
  {
    name: 'incident frontmatter absent',
    rule: 'incident.frontmatter.missing',
    path: `${INCIDENT_DIR}/incident.md`,
    mutate(ws) {
      ws.incidents[INC]['incident.md'] = '# Incident\n\nNo frontmatter block here.\n';
    },
  },
  {
    name: 'incident frontmatter not terminated by closing ---',
    rule: 'incident.frontmatter.unterminated',
    path: `${INCIDENT_DIR}/incident.md`,
    mutate(ws) {
      ws.incidents[INC]['incident.md'] = [
        '---',
        `id: ${INC}`,
        'title: Never closed',
        'status: INVESTIGATING',
        '', // no closing --- delimiter
      ].join('\n');
    },
  },
  {
    name: 'incident frontmatter line is not a key: value pair',
    rule: 'incident.frontmatter.malformed',
    path: `${INCIDENT_DIR}/incident.md`,
    mutate(ws) {
      ws.incidents[INC]['incident.md'] = [
        '---',
        `id: ${INC}`,
        'title: Has a bad line',
        'this line has no colon',
        'status: INVESTIGATING',
        '---',
      ].join('\n');
    },
  },
  {
    name: 'incident frontmatter missing id',
    rule: 'incident.id.missing',
    path: `${INCIDENT_DIR}/incident.md`,
    mutate(ws) {
      ws.incidents[INC]['incident.md'] = [
        '---',
        'title: Missing id',
        'status: INVESTIGATING',
        '---',
      ].join('\n');
    },
  },
  {
    name: 'incident frontmatter missing title',
    rule: 'incident.title.missing',
    path: `${INCIDENT_DIR}/incident.md`,
    mutate(ws) {
      ws.incidents[INC]['incident.md'] = [
        '---',
        `id: ${INC}`,
        'status: INVESTIGATING',
        '---',
      ].join('\n');
    },
  },
  {
    name: 'incident frontmatter missing status',
    rule: 'incident.status.missing',
    path: `${INCIDENT_DIR}/incident.md`,
    mutate(ws) {
      ws.incidents[INC]['incident.md'] = [
        '---',
        `id: ${INC}`,
        'title: No status field',
        '---',
      ].join('\n');
    },
  },
  {
    name: 'incident frontmatter unknown status',
    rule: 'incident.status.unknown',
    path: `${INCIDENT_DIR}/incident.md`,
    mutate(ws) {
      ws.incidents[INC]['incident.md'] = incidentMd('FIXING_IT_NOW');
    },
  },

  // --- resolution-stage artifact set -----------------------------------
  {
    name: 'RESOLVED incident missing postmortem.md',
    rule: 'workspace.artifact.missing',
    path: `${INCIDENT_DIR}/postmortem.md`,
    mutate(ws) {
      delete ws.incidents[INC]['postmortem.md'];
    },
  },

  // --- remediation steps ------------------------------------------------
  {
    name: 'remediation step missing [AFK]/[HITL] tag',
    rule: 'remediation.tag.missing',
    path: `${INCIDENT_DIR}/fix-proposal.md`,
    mutate(ws) {
      ws.incidents[INC]['fix-proposal.md'] =
        '# Fix Proposal\n\n- Revert the bad commit verify: reproduction test passes\n';
    },
  },
  {
    name: 'remediation step missing verify: clause',
    rule: 'remediation.verify.missing',
    path: `${INCIDENT_DIR}/fix-proposal.md`,
    mutate(ws) {
      ws.incidents[INC]['fix-proposal.md'] =
        '# Fix Proposal\n\n- [AFK] Revert commit a1b2c3d on a fix branch\n';
    },
  },
];

for (const { name, rule, path, mutate } of violationCases) {
  test(`validate: ${name} -> ${rule} at ${path}`, () => {
    const ws = validResolvedWorkspace();
    mutate(ws);
    const result = validate(ws);

    assert.equal(result.ok, false, 'expected ok:false for a violation');
    assert.ok(
      hasProblem(result, rule, path),
      `expected a problem { rule: "${rule}", path: "${path}" }, got ${JSON.stringify(result.problems)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// A couple of aggregate sanity checks over the table above
// ---------------------------------------------------------------------------

test('validate: every violation case sets ok:false', () => {
  for (const { mutate } of violationCases) {
    const ws = validResolvedWorkspace();
    mutate(ws);
    assert.equal(validate(ws).ok, false);
  }
});

test('validate: RESOLUTION_ARTIFACTS drives the resolution-stage check', () => {
  // Removing any one resolution artifact from a RESOLVED incident is reported.
  for (const artifact of RESOLUTION_ARTIFACTS) {
    if (artifact === 'incident.md') continue; // removing this changes the rule/status path
    const ws = validResolvedWorkspace();
    delete ws.incidents[INC][artifact];
    const result = validate(ws);
    assert.ok(
      hasProblem(result, 'workspace.artifact.missing', `${INCIDENT_DIR}/${artifact}`),
      `expected missing-artifact problem for ${artifact}`,
    );
  }
});
