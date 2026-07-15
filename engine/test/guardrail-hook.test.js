// Guardrail hook tests for every failure mode (task 8.3).
//
// The unit under test is the guardrail companion script at
// `.kiro/hooks/patchwork-guardrail.mjs` (task 8.2): a fail-closed decider that
// SHELLS INTO the real Patchwork CLI (`engine/cli.js gate --incident <id> --to
// RESOLVED --workspace <ws>`) and ALLOWS only on an explicit success — the CLI
// exited 0 AND its parsed JSON says `command: 'gate', allowed: true`. Every
// other outcome BLOCKS (design "Error Handling > Guardrail hook fails closed";
// Requirement 11).
//
// Because the script shells into a CLI that reads the workspace FROM DISK, each
// test writes a constructed workspace to a real temp directory and points
// `decideForIncident({ workspace: <tempDir>, ... })` at it. The `--workspace`
// dir is the `patchwork/`-equivalent root that CONTAINS `incidents/` (confirmed
// against engine/read-workspace.js). Temp dirs and stub CLI files are removed
// via `t.after`.
//
// Failure modes covered (each mapped to its requirement):
//   ALLOW  valid non-author PASS at current fix_version, HITL cleared  (11.4)
//   BLOCK  no PASS (review.md missing)                                 (11.2)
//   BLOCK  NEEDS_WORK verdict                                          (11.2)
//   BLOCK  stale PASS (review Fix-Version < incident fix_version)      (6.3)
//   BLOCK  self-authored PASS (reviewer === fix author)               (6.4)
//   BLOCK  uncleared HITL — unchecked [ ] and plain forms             (8.5)
//   BLOCK  non-zero CLI exit                                          (11.4)
//   BLOCK  exit 0 but unparseable / wrong-shape output                (11.3, 11.4)
//   BLOCK  CLI timeout                                                (11.4)
//   drives run() exit-code mapping and decideForWorkspace scanning.
//
// _Requirements: 6.3, 6.4, 8.5, 11.2, 11.3, 11.4_

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decideForIncident,
  decideForWorkspace,
  findStagedIncidents,
  run,
  EXIT_ALLOW,
  EXIT_BLOCK,
} from '../../.kiro/hooks/patchwork-guardrail.mjs';

const DASH = '\u2014'; // em dash before a remediation verify: clause
const INC = 'INC-2024-001';
const FIX_AUTHOR = 'patchwork-sre';
const REVIEWER = 'patchwork-reviewer';
// The base incident sits at fix_version 2 (one completed revision cycle) so a
// stale PASS can be expressed as an earlier "Fix-Version: 1".
const BASE_FIX_VERSION = 2;

// ---------------------------------------------------------------------------
// Artifact factories (fresh strings each call; conventions copied verbatim from
// engine/test/resolved-guard.test.js and the parsers in engine/core/gate.js)
// ---------------------------------------------------------------------------

/** Incident frontmatter for a given status + fix_version (all fields present). */
function incidentMd(status, fixVersion) {
  return [
    '---',
    `id: ${INC}`,
    'title: Checkout 500s on coupon stacking',
    `status: ${status}`,
    `fix_version: ${fixVersion}`,
    '---',
    '',
  ].join('\n');
}

// The single remediation step in the three clear/uncleared forms the guard
// distinguishes: a checked box is cleared; an unchecked box or a plain
// (checkbox-less) step is uncleared.
const CLEARED_HITL = `- [x] [HITL] Rotate the API key ${DASH} verify: Commander confirms new key deployed`;
const UNCHECKED_HITL = `- [ ] [HITL] Rotate the API key ${DASH} verify: Commander confirms new key deployed`;
const PLAIN_HITL = `- [HITL] Rotate the API key ${DASH} verify: Commander confirms new key deployed`;

/** A fix-proposal.md with an `Author:` line and the given remediation steps. */
function fixProposal(author, steps) {
  return ['# Fix Proposal', `Author: ${author}`, '', ...steps, ''].join('\n');
}

/** A review.md recording a reviewer, a fix version, and a verdict. */
function reviewMd(reviewer, fixVersion, verdictValue) {
  return [
    `Reviewer: ${reviewer}`,
    `Fix-Version: ${fixVersion}`,
    '',
    '# Review',
    'Adversarial findings go here.',
    `VERDICT: ${verdictValue}`,
    '',
  ].join('\n');
}

/**
 * The base "valid resolvable" incident: FIX_STAGED at fix_version 2 with a
 * non-author PASS bound to fix_version 2 and the HITL step cleared. Each
 * negative case below mutates exactly one facet of this file map.
 */
function validResolvableFiles() {
  return {
    'incident.md': incidentMd('FIX_STAGED', BASE_FIX_VERSION),
    'fix-proposal.md': fixProposal(FIX_AUTHOR, [CLEARED_HITL]),
    'review.md': reviewMd(REVIEWER, BASE_FIX_VERSION, 'PASS'),
  };
}

// ---------------------------------------------------------------------------
// On-disk workspace + stub-CLI helpers (temp dirs cleaned up via t.after)
// ---------------------------------------------------------------------------

function writeFileUnder(dir, relPath, contents) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

/**
 * Build a temp workspace whose `incidents/INC-2024-001/` holds the given
 * artifact files (a key mapped to `undefined` is omitted, i.e. the file is
 * absent). Returns the workspace dir to pass as `--workspace`.
 */
function makeWorkspace(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchwork-guardrail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const incRel = path.join('incidents', INC);
  for (const [name, contents] of Object.entries(files)) {
    if (contents === undefined) continue;
    writeFileUnder(dir, path.join(incRel, name), contents);
  }
  return dir;
}

/** Write a tiny stub CLI (.mjs) and return its path. */
function makeStubCli(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchwork-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stubPath = path.join(dir, 'stub-cli.mjs');
  fs.writeFileSync(stubPath, body, 'utf8');
  return stubPath;
}

/** A gate reason must always be a non-empty, human-readable string. */
function assertNonEmptyReason(decision) {
  assert.equal(typeof decision.reason, 'string', 'reason must be a string');
  assert.ok(decision.reason.trim().length > 0, 'reason must be non-empty');
}

// ===========================================================================
// The ONE allow path: a valid non-author PASS at current fix_version, HITL clear
// ===========================================================================

test('guardrail ALLOWS only on a valid non-author PASS at the current fix_version with HITL cleared', (t) => {
  const ws = makeWorkspace(t, validResolvableFiles());

  const decision = decideForIncident({ workspace: ws, incident: INC });

  assert.equal(decision.decision, 'ALLOW');
  assert.equal(decision.allow, true);
  assert.equal(decision.exitCode, 0, 'the real CLI must have exited 0 (allowed)');
  assert.equal(decision.parsed.command, 'gate');
  assert.equal(decision.parsed.allowed, true);
  assertNonEmptyReason(decision);
});

test('run() maps the valid resolvable workspace to EXIT_ALLOW (0)', (t) => {
  const ws = makeWorkspace(t, validResolvableFiles());
  const code = run(['--incident', INC, '--workspace', ws]);
  assert.equal(code, EXIT_ALLOW);
});

// ===========================================================================
// Table-driven BLOCK cases against the REAL CLI: each mutates the base by one
// thing. These exercise the guardrail end-to-end (hook -> CLI -> gate core).
// ===========================================================================

const realCliBlockCases = [
  {
    // Requirement 11.2 — no PASS verdict exists for the current fix version.
    name: 'no PASS: review.md is missing',
    requirement: '11.2',
    mutate(files) {
      delete files['review.md'];
    },
  },
  {
    // Requirement 11.2 — a review exists but its verdict is NEEDS_WORK.
    name: 'NEEDS_WORK verdict',
    requirement: '11.2',
    mutate(files) {
      files['review.md'] = reviewMd(REVIEWER, BASE_FIX_VERSION, 'NEEDS_WORK');
    },
  },
  {
    // Requirement 6.3 — review-to-fix binding: a PASS from an earlier fix
    // version is stale and ignored.
    name: 'stale PASS (review Fix-Version 1 < incident fix_version 2)',
    requirement: '6.3',
    mutate(files) {
      files['review.md'] = reviewMd(REVIEWER, 1, 'PASS');
    },
  },
  {
    // Requirement 6.4 — Non_Author_Rule: the fix author cannot author the PASS.
    name: 'self-authored PASS (reviewer === fix author)',
    requirement: '6.4',
    mutate(files) {
      files['review.md'] = reviewMd(FIX_AUTHOR, BASE_FIX_VERSION, 'PASS');
    },
  },
  {
    // Requirement 8.5 — an unchecked [ ] HITL step is uncleared.
    name: 'uncleared HITL (unchecked [ ] box) despite a valid PASS',
    requirement: '8.5',
    mutate(files) {
      files['fix-proposal.md'] = fixProposal(FIX_AUTHOR, [UNCHECKED_HITL]);
    },
  },
  {
    // Requirement 8.5 — a plain (checkbox-less) HITL step is uncleared.
    name: 'uncleared HITL (plain, checkbox-less step) despite a valid PASS',
    requirement: '8.5',
    mutate(files) {
      files['fix-proposal.md'] = fixProposal(FIX_AUTHOR, [PLAIN_HITL]);
    },
  },
];

for (const { name, requirement, mutate } of realCliBlockCases) {
  test(`guardrail BLOCKS on ${name} (Req ${requirement})`, (t) => {
    const files = validResolvableFiles();
    mutate(files);
    const ws = makeWorkspace(t, files);

    const decision = decideForIncident({ workspace: ws, incident: INC });

    assert.equal(decision.decision, 'BLOCK', `expected BLOCK for: ${name}`);
    assert.equal(decision.allow, false);
    // The CLI rejected the transition (exit 1), and the guardrail folded that
    // into a BLOCK; the parsed gate result carried allowed:false.
    assert.equal(decision.exitCode, 1, 'a rejected gate exits 1');
    assert.equal(decision.parsed.command, 'gate');
    assert.equal(decision.parsed.allowed, false);
    assertNonEmptyReason(decision);
  });
}

test('run() maps a not-clear workspace (no PASS) to EXIT_BLOCK (2)', (t) => {
  const files = validResolvableFiles();
  delete files['review.md'];
  const ws = makeWorkspace(t, files);
  const code = run(['--incident', INC, '--workspace', ws]);
  assert.equal(code, EXIT_BLOCK);
});

// ===========================================================================
// The decision is driven SOLELY by exit code + parsed result. These stub-CLI
// cases pin that contract without touching the real gate logic.
// ===========================================================================

test('guardrail BLOCKS on a non-zero CLI exit (Req 11.4 fail-closed)', (t) => {
  // A stub that exits non-zero with no useful output.
  const cliPath = makeStubCli(t, 'process.exit(3);\n');

  const decision = decideForIncident({
    workspace: 'unused',
    incident: INC,
    cliPath,
    nodePath: process.execPath,
  });

  assert.equal(decision.decision, 'BLOCK');
  assert.equal(decision.exitCode, 3);
  assertNonEmptyReason(decision);
});

test('guardrail BLOCKS when the CLI path does not exist (Req 11.4 fail-closed)', (t) => {
  const decision = decideForIncident({
    workspace: 'unused',
    incident: INC,
    cliPath: path.join(os.tmpdir(), 'patchwork-cli-does-not-exist-xyz.mjs'),
    nodePath: process.execPath,
  });

  assert.equal(decision.decision, 'BLOCK');
  assert.equal(decision.allow, false);
  assertNonEmptyReason(decision);
});

test('guardrail BLOCKS on exit 0 with NO parseable JSON — exit 0 alone is insufficient (Req 11.3)', (t) => {
  const cliPath = makeStubCli(t, "console.log('no json here');\nprocess.exit(0);\n");

  const decision = decideForIncident({
    workspace: 'unused',
    incident: INC,
    cliPath,
    nodePath: process.execPath,
  });

  assert.equal(decision.decision, 'BLOCK', 'exit 0 without a parseable gate result must BLOCK');
  assert.equal(decision.exitCode, 0);
  assert.match(decision.reason, /no parseable JSON/);
});

test('guardrail BLOCKS on exit 0 with the wrong command in the JSON (Req 11.3)', (t) => {
  // Even allowed:true does not help when the result is not a gate result.
  const cliPath = makeStubCli(
    t,
    "console.log(JSON.stringify({ command: 'validate', allowed: true }));\nprocess.exit(0);\n",
  );

  const decision = decideForIncident({
    workspace: 'unused',
    incident: INC,
    cliPath,
    nodePath: process.execPath,
  });

  assert.equal(decision.decision, 'BLOCK');
  assert.equal(decision.exitCode, 0);
  assert.match(decision.reason, /unexpected CLI result/);
});

test('guardrail BLOCKS on exit 0 with a gate result of allowed:false (Req 11.4)', (t) => {
  const cliPath = makeStubCli(
    t,
    "console.log(JSON.stringify({ command: 'gate', allowed: false, reason: 'nope' }));\nprocess.exit(0);\n",
  );

  const decision = decideForIncident({
    workspace: 'unused',
    incident: INC,
    cliPath,
    nodePath: process.execPath,
  });

  assert.equal(decision.decision, 'BLOCK');
  assert.equal(decision.exitCode, 0);
  assertNonEmptyReason(decision);
});

test('guardrail ALLOWS on exit 0 + parsed {command:gate, allowed:true} — decision is driven purely by exit code + parsed result', (t) => {
  // This stub returns success against an intentionally BOGUS workspace. If the
  // guardrail consulted anything other than the CLI's exit code + parsed result
  // it would BLOCK here; it ALLOWs, proving the decision is delegated wholly to
  // the CLI (design "decide solely on exit code + parsed result").
  const cliPath = makeStubCli(
    t,
    [
      "console.log('gate: ALLOWED - stub');",
      "console.log(JSON.stringify({ command: 'gate', allowed: true, reason: 'stubbed success' }));",
      'process.exit(0);',
      '',
    ].join('\n'),
  );

  const decision = decideForIncident({
    workspace: 'this-workspace-does-not-exist',
    incident: INC,
    cliPath,
    nodePath: process.execPath,
  });

  assert.equal(decision.decision, 'ALLOW');
  assert.equal(decision.allow, true);
  assert.equal(decision.parsed.allowed, true);
});

test('guardrail BLOCKS on a CLI timeout (Req 11.4 fail-closed)', (t) => {
  // A stub that never exits: keep the event loop alive so spawnSync must kill
  // it on the (small) timeout.
  const cliPath = makeStubCli(t, 'setTimeout(() => {}, 60000);\n');

  const decision = decideForIncident({
    workspace: 'unused',
    incident: INC,
    cliPath,
    nodePath: process.execPath,
    timeoutMs: 300,
  });

  assert.equal(decision.decision, 'BLOCK');
  assert.match(decision.reason, /timed out/);
});

test('guardrail BLOCKS fail-closed when no incident id is supplied', () => {
  const decision = decideForIncident({ workspace: 'unused' });
  assert.equal(decision.decision, 'BLOCK');
  assert.equal(decision.allow, false);
  assertNonEmptyReason(decision);
});

// ===========================================================================
// The workspace-level activation heuristic (decideForWorkspace / findStaged)
// ===========================================================================

test('findStagedIncidents lists incidents at FIX_STAGED', (t) => {
  const ws = makeWorkspace(t, validResolvableFiles());
  assert.deepEqual(findStagedIncidents(ws), [INC]);
});

test('decideForWorkspace ALLOWS when the one staged incident is clear to resolve', (t) => {
  const ws = makeWorkspace(t, validResolvableFiles());
  const decision = decideForWorkspace({ workspace: ws });

  assert.equal(decision.decision, 'ALLOW');
  assert.equal(decision.allow, true);
  assert.equal(decision.checks.length, 1);
  assert.equal(decision.checks[0].allow, true);
});

test('decideForWorkspace BLOCKS when a staged incident is not clear to resolve', (t) => {
  const files = validResolvableFiles();
  delete files['review.md']; // no PASS
  const ws = makeWorkspace(t, files);

  const decision = decideForWorkspace({ workspace: ws });

  assert.equal(decision.decision, 'BLOCK');
  assert.equal(decision.allow, false);
  assert.ok(decision.checks.some((c) => !c.allow));
  assertNonEmptyReason(decision);
});

test('decideForWorkspace ALLOWS (nothing to gate) when no incident is at FIX_STAGED', (t) => {
  const files = validResolvableFiles();
  files['incident.md'] = incidentMd('INVESTIGATING', BASE_FIX_VERSION);
  const ws = makeWorkspace(t, files);

  const decision = decideForWorkspace({ workspace: ws });

  assert.equal(decision.decision, 'ALLOW');
  assert.equal(decision.checks.length, 0);
  assert.match(decision.reason, /nothing to gate/);
});
