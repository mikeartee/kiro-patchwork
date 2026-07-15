// Config-lint tests for the patchwork-sre custom agent (task 7.2).
//
// This suite is a "lint" over the REAL agent config on disk
// (.kiro/agents/patchwork-sre.json) plus a positive validate() check of the
// artifact set the SRE is expected to produce. It reads the actual JSON file
// (never a copy), so the lint tracks the shipped config and fails if the
// tool-scoping guarantees the design promises are ever weakened.
//
// It asserts the three things task 7.2 calls for:
//   1. Write scope    — fs_write.allowedPaths is exactly ["patchwork/**"]
//                       (the SRE writes only under the shared workspace) (Req 4.5).
//   2. Denied caps    — git push/merge/branch are denied (present in
//                       execute_bash.deniedCommands AND absent from
//                       allowedCommands), and secret paths (.env / *.key /
//                       *.pem / credentials / secrets) are in
//                       fs_write.deniedPaths (Req 4.6).
//   3. Producible work — the artifact set the SRE authors at ANALYSIS_READY
//                       (a valid incident.md, analysis.md, and a fix-proposal.md
//                       whose [AFK]/[HITL] remediation steps carry verify:
//                       clauses, plus a well-formed board.md) passes validate()
//                       with ok:true; and, as a non-vacuous control, a
//                       remediation step missing its verify: clause is caught
//                       (Req 9.4).
//
// _Requirements: 4.5, 4.6, 9.4_

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validate } from '../core/validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// engine/test -> engine -> repo root -> .kiro/agents/patchwork-sre.json
const SRE_CONFIG_PATH = path.join(
  __dirname,
  '..',
  '..',
  '.kiro',
  'agents',
  'patchwork-sre.json',
);

const DOT = '\u00B7'; // middle-dot separator in board entries
const DASH = '\u2014'; // em dash before a remediation verify: clause
const INC = 'INC-2024-001';

// Read the REAL config once. Parsing here (not from a hard-coded copy) is the
// whole point of a config-lint: the assertions below track the shipped file.
const sreConfig = JSON.parse(fs.readFileSync(SRE_CONFIG_PATH, 'utf8'));

function fsWrite() {
  return (sreConfig.toolsSettings && sreConfig.toolsSettings.fs_write) || {};
}
function execBash() {
  return (sreConfig.toolsSettings && sreConfig.toolsSettings.execute_bash) || {};
}

// A denied-command entry targets `git <verb>` if, ignoring any regex quantifier
// suffix (e.g. ".*"), it begins with `git <verb>`. Matching on the verb keeps
// the assertion robust to the exact pattern spelling.
function deniesGitVerb(deniedCommands, verb) {
  const re = new RegExp(`^git\\s+${verb}\\b`);
  return deniedCommands.some((cmd) => re.test(String(cmd).trim()));
}

// ---------------------------------------------------------------------------
// 1. Write scope is exactly patchwork/** (Requirement 4.5)
// ---------------------------------------------------------------------------

test('SRE config: fs_write.allowedPaths is exactly ["patchwork/**"]', () => {
  assert.deepEqual(
    fsWrite().allowedPaths,
    ['patchwork/**'],
    'the SRE must be write-scoped to the shared workspace only',
  );
});

// ---------------------------------------------------------------------------
// 2. Denied capabilities: no push/merge/branch, and secret paths blocked (4.6)
// ---------------------------------------------------------------------------

test('SRE config: git push/merge/branch are present in execute_bash.deniedCommands', () => {
  const denied = execBash().deniedCommands || [];
  for (const verb of ['push', 'merge', 'branch']) {
    assert.ok(
      deniesGitVerb(denied, verb),
      `expected a denied command for "git ${verb}", got ${JSON.stringify(denied)}`,
    );
  }
});

test('SRE config: execute_bash.allowedCommands grants none of push/merge/branch', () => {
  const allowed = execBash().allowedCommands || [];
  const forbidden = /\b(push|merge|branch)\b/;
  for (const cmd of allowed) {
    assert.ok(
      !forbidden.test(String(cmd)),
      `allowedCommands must not grant push/merge/branch, but found "${cmd}"`,
    );
  }
});

test('SRE config: git is read-only — allowedCommands are only status/log/diff/show', () => {
  const allowed = (execBash().allowedCommands || []).map((c) => String(c).trim());
  // Every allowed command must begin with one of the four read-only git verbs.
  const readonly = /^git\s+(status|log|diff|show)\b/;
  for (const cmd of allowed) {
    assert.ok(
      readonly.test(cmd),
      `allowedCommands must be read-only git only, but found "${cmd}"`,
    );
  }
});

test('SRE config: fs_write.deniedPaths blocks secret paths (.env / key / pem / credentials / secrets)', () => {
  const denied = (fsWrite().deniedPaths || []).map((p) => String(p));
  const joined = denied.join('\n');
  const secretChecks = [
    ['.env', /\.env\b/],
    ['*.key', /\*\.key\b/],
    ['*.pem', /\*\.pem\b/],
    ['credentials', /credentials/],
    ['secrets', /secrets/],
  ];
  for (const [label, re] of secretChecks) {
    assert.ok(
      re.test(joined),
      `expected a deniedPaths entry covering ${label}, got ${JSON.stringify(denied)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. The artifacts the SRE produces at ANALYSIS_READY pass validate (Req 9.4)
// ---------------------------------------------------------------------------

/** A well-formed board.md with a header, prose, and two attributed entries. */
function validBoard() {
  return [
    '# Patchwork Board',
    '',
    `Entry format: [time] @who ${DOT} Role (human|agent) ${DOT} type: desc.`,
    '',
    `[2024-06-01T14:03Z] @alice ${DOT} Incident Commander (human) ${DOT} report: /checkout 500s on coupon stacking`,
    `[2024-06-01T14:07Z] @patchwork-sre ${DOT} SRE (agent) ${DOT} analysis: root cause traced to commit a1b2c3d`,
  ].join('\n');
}

/** incident.md frontmatter at ANALYSIS_READY (all required fields present). */
function analysisReadyIncident() {
  return [
    '---',
    `id: ${INC}`,
    'title: Checkout endpoint returns 500 under coupon stacking',
    'status: ANALYSIS_READY',
    'fix_version: 1',
    '---',
    '',
    'Root-cause analysis is ready for adversarial review.',
    '',
  ].join('\n');
}

/**
 * A fix-proposal.md as the SRE prompt requires it: an `Author:` metadata line
 * plus [AFK]/[HITL] remediation steps, each carrying a verify: clause.
 */
function validFixProposal() {
  return [
    '# Fix Proposal - INC-2024-001',
    '',
    'Author: patchwork-sre',
    '',
    'Proposed fix with tagged, verifiable remediation steps.',
    '',
    `- [AFK] Revert commit a1b2c3d on a fix branch ${DASH} verify: node --test sample-app/checkout.repro.test.js passes`,
    `- [HITL] Rotate the leaked coupon-service API key ${DASH} verify: Commander confirms new key deployed`,
  ].join('\n');
}

/**
 * The snapshot the SRE produces when it advances an incident to ANALYSIS_READY:
 * a well-formed board plus incident.md + analysis.md + fix-proposal.md. This is
 * NOT a resolution-stage incident, so the full six-artifact set is not required.
 */
function analysisReadyWorkspace() {
  return {
    board: validBoard(),
    incidents: {
      [INC]: {
        'incident.md': analysisReadyIncident(),
        'analysis.md': [
          '# Analysis - INC-2024-001',
          '',
          'Coupon stacking reads a missing tier.multiplier; the failing path 500s.',
          '',
        ].join('\n'),
        'fix-proposal.md': validFixProposal(),
      },
    },
  };
}

test('SRE artifacts: the ANALYSIS_READY artifact set passes validate (ok:true)', () => {
  const result = validate(analysisReadyWorkspace());
  assert.equal(
    result.ok,
    true,
    `expected ok:true, got problems ${JSON.stringify(result.problems)}`,
  );
  assert.deepEqual(result.problems, []);
});

test('SRE artifacts (control): a remediation step missing its verify: clause fails validate (Req 9.4)', () => {
  const ws = analysisReadyWorkspace();
  // Drop the verify: clause from the [AFK] step the SRE would author.
  ws.incidents[INC]['fix-proposal.md'] = [
    '# Fix Proposal - INC-2024-001',
    '',
    'Author: patchwork-sre',
    '',
    '- [AFK] Revert commit a1b2c3d on a fix branch',
  ].join('\n');

  const result = validate(ws);
  assert.equal(result.ok, false, 'a step without a verify: clause must be invalid');
  assert.ok(
    result.problems.some(
      (p) =>
        p.rule === 'remediation.verify.missing' &&
        p.path === `patchwork/incidents/${INC}/fix-proposal.md`,
    ),
    `expected a remediation.verify.missing problem, got ${JSON.stringify(result.problems)}`,
  );
});
