// Parity tests for the Patchwork MCP tool handlers (task 5.2).
//
// These tests protect the design's load-bearing "two surfaces, one core"
// invariant (design "Architecture > Two surfaces, one core"; Requirements 10.5,
// 10.6): the MCP tool handlers (engine/mcp.js) MUST return the SAME decision as
// the corresponding pure core function (engine/core/*) for the SAME workspace.
// If a handler ever diverged from the core, an agent self-checking via MCP and
// a hook shelling into the CLI could disagree about whether an incident may
// advance — exactly the failure this invariant forbids.
//
// The MCP handlers read a workspace from DISK (via the shared
// ./read-workspace.js reader), while the core functions take an in-memory
// snapshot. So to assert parity we:
//   1. build a TEMP on-disk workspace under os.tmpdir() (mirroring the
//      temp-workspace-builder pattern in engine/test/cli.test.js),
//   2. call the MCP handler with { workspace: tmpDir, ... },
//   3. independently read the same tmpDir with readWorkspace(tmpDir), call the
//      corresponding core function with that snapshot (for `gate`, resolving
//      the transition's `from` from incident.md exactly as the handler does),
//   4. assert deepEqual between the handler's return and the core's return.
//
// Temp workspaces are removed in a finally block. This file is the parity test
// only — the tool-listing smoke test belongs to task 5.3.
//
// _Requirements: 10.5, 10.6_

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runValidate, runGate, runVerdict } from '../mcp.js';
import { validate } from '../core/validate.js';
import { gate } from '../core/gate.js';
import { verdict } from '../core/verdict.js';
import { parseIncident, isSchemaError } from '../core/schema.js';
import { readWorkspace } from '../read-workspace.js';

const DOT = '\u00B7'; // middle-dot separator used in board entries
const DASH = '\u2014'; // em dash used between a remediation action and verify:
const INC = 'INC-2024-001';

// ---------------------------------------------------------------------------
// Temp-workspace helpers (adapted from engine/test/cli.test.js)
// ---------------------------------------------------------------------------

function mkTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'patchwork-mcp-parity-'));
}

function writeFile(dir, relPath, contents) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

/** Run `fn(dir)` against a fresh temp workspace, always cleaning it up. */
function withTempWorkspace(fn) {
  const dir = mkTempWorkspace();
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeIncidentFiles(dir, id, files) {
  for (const [name, contents] of Object.entries(files)) {
    writeFile(dir, path.join('incidents', id, name), contents);
  }
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

function incidentMd({ id = INC, title = 'Checkout 500', status, fixVersion = 1 }) {
  return [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `status: ${status}`,
    `fix_version: ${fixVersion}`,
    '---',
    '',
  ].join('\n');
}

function board() {
  return [
    '# Patchwork Board',
    '',
    `[2024-06-01T14:03Z] @alice ${DOT} Incident Commander (human) ${DOT} report: /checkout 500s`,
    `[2024-06-01T14:07Z] @patchwork-sre ${DOT} SRE (agent) ${DOT} analysis: root cause found`,
    '',
  ].join('\n');
}

/** A fix proposal that satisfies the RESOLVED guard: has an Author line and a
 *  CLEARED (checked) [HITL] step. NOTE: the checked-checkbox form (`- [x]
 *  [HITL]`) is understood by the gate's own HITL scanner but NOT by
 *  parseRemediationStep, so a workspace using this form does not pass validate
 *  — use fixProposalValid() for validate scenarios. */
function fixProposalResolvable() {
  return [
    '# Fix Proposal',
    '',
    'Author: patchwork-sre',
    '',
    `- [AFK] Revert commit a1b2c3d ${DASH} verify: reproduction test passes`,
    `- [x] [HITL] Rotate the API key ${DASH} verify: Commander confirms new key deployed`,
    '',
  ].join('\n');
}

/** A fix proposal whose remediation steps use the plain `[AFK]`/`[HITL]` form
 *  that validate accepts (matching engine/test/cli.test.js's valid fixture). */
function fixProposalValid() {
  return [
    '# Fix Proposal',
    '',
    `- [AFK] Revert commit a1b2c3d ${DASH} verify: reproduction test passes`,
    `- [HITL] Rotate the API key ${DASH} verify: Commander confirms new key deployed`,
    '',
  ].join('\n');
}

/** A non-author PASS review bound to fix_version 1. */
function reviewPass() {
  return [
    'Reviewer: patchwork-reviewer',
    'Fix-Version: 1',
    '',
    '# Review',
    'Attempted to refute the fix; no blocking defect found.',
    'VERDICT: PASS',
    '',
  ].join('\n');
}

/** A NEEDS_WORK review (unsatisfied guard). */
function reviewNeedsWork() {
  return [
    'Reviewer: patchwork-reviewer',
    'Fix-Version: 1',
    '',
    '# Review',
    'The fix misses the null branch.',
    'VERDICT: NEEDS_WORK',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// gate parity helper — mirror the handler's `from` resolution, then call core
// ---------------------------------------------------------------------------

/**
 * Compute the core `gate` result for the SAME snapshot the MCP handler reads,
 * resolving the transition's `from` from incident.md exactly as runGate does.
 * The test then asserts the handler's return deepEquals this.
 */
function coreGate(dir, incidentId, to) {
  const snapshot = readWorkspace(dir);
  const files =
    snapshot.incidents && snapshot.incidents[incidentId]
      ? snapshot.incidents[incidentId]
      : null;
  assert.ok(files, `test setup: incident ${incidentId} should exist on disk`);
  const parsed = parseIncident(files['incident.md']);
  assert.ok(!isSchemaError(parsed), 'test setup: incident.md should parse');
  return gate(snapshot, { incidentId, from: parsed.status, to });
}

// ===========================================================================
// validate parity
// ===========================================================================

test('parity: runValidate matches core validate on a VALID workspace (ok:true)', () => {
  withTempWorkspace((dir) => {
    writeFile(dir, 'board.md', board());
    writeIncidentFiles(dir, INC, {
      'incident.md': incidentMd({ status: 'RESOLVED' }),
      'analysis.md': '# Analysis\n',
      'fix-proposal.md': fixProposalValid(),
      'review.md': reviewPass(),
      'decision-log.md': '# Decision Log\n',
      'postmortem.md': '# Post-mortem\n',
    });

    const fromMcp = runValidate({ workspace: dir });
    const fromCore = validate(readWorkspace(dir));

    assert.equal(fromMcp.ok, true, 'this fixture should validate ok');
    assert.deepEqual(fromMcp, fromCore, 'MCP validate must equal core validate');
  });
});

test('parity: runValidate matches core validate on an INVALID workspace (problems present)', () => {
  withTempWorkspace((dir) => {
    // A valid incident but NO board.md, so validate reports problems.
    writeIncidentFiles(dir, INC, {
      'incident.md': incidentMd({ status: 'INVESTIGATING' }),
    });

    const fromMcp = runValidate({ workspace: dir });
    const fromCore = validate(readWorkspace(dir));

    assert.equal(fromMcp.ok, false, 'a board-less workspace should have problems');
    assert.ok(fromMcp.problems.length >= 1, 'expected at least one problem');
    assert.deepEqual(fromMcp, fromCore, 'MCP validate must equal core validate');
  });
});

// ===========================================================================
// gate parity
// ===========================================================================

test('parity: runGate matches core gate on an ALLOWED simple transition (REPORTED -> INVESTIGATING)', () => {
  withTempWorkspace((dir) => {
    writeFile(dir, 'board.md', board());
    writeIncidentFiles(dir, INC, {
      'incident.md': incidentMd({ status: 'REPORTED' }),
    });

    const fromMcp = runGate({ incidentId: INC, to: 'INVESTIGATING', workspace: dir });
    const fromCore = coreGate(dir, INC, 'INVESTIGATING');

    assert.equal(fromMcp.allowed, true, 'REPORTED -> INVESTIGATING should be allowed');
    assert.deepEqual(fromMcp, fromCore, 'MCP gate must equal core gate');
  });
});

test('parity: runGate matches core gate on the ALLOWED guarded edge (satisfied FIX_STAGED -> RESOLVED)', () => {
  withTempWorkspace((dir) => {
    writeFile(dir, 'board.md', board());
    writeIncidentFiles(dir, INC, {
      'incident.md': incidentMd({ status: 'FIX_STAGED', fixVersion: 1 }),
      'fix-proposal.md': fixProposalResolvable(),
      'review.md': reviewPass(),
    });

    const fromMcp = runGate({ incidentId: INC, to: 'RESOLVED', workspace: dir });
    const fromCore = coreGate(dir, INC, 'RESOLVED');

    assert.equal(
      fromMcp.allowed,
      true,
      'a non-author PASS at the current fix_version with HITL cleared should open RESOLVED',
    );
    assert.deepEqual(fromMcp, fromCore, 'MCP gate must equal core gate');
  });
});

test('parity: runGate matches core gate on a REJECTED undefined transition (INVESTIGATING -> RESOLVED)', () => {
  withTempWorkspace((dir) => {
    writeFile(dir, 'board.md', board());
    writeIncidentFiles(dir, INC, {
      'incident.md': incidentMd({ status: 'INVESTIGATING' }),
    });

    const fromMcp = runGate({ incidentId: INC, to: 'RESOLVED', workspace: dir });
    const fromCore = coreGate(dir, INC, 'RESOLVED');

    assert.equal(fromMcp.allowed, false, 'an undefined transition must be rejected');
    assert.deepEqual(fromMcp, fromCore, 'MCP gate must equal core gate');
  });
});

test('parity: runGate matches core gate on a REJECTED guard (FIX_STAGED -> RESOLVED with NEEDS_WORK)', () => {
  withTempWorkspace((dir) => {
    writeFile(dir, 'board.md', board());
    writeIncidentFiles(dir, INC, {
      'incident.md': incidentMd({ status: 'FIX_STAGED', fixVersion: 1 }),
      'fix-proposal.md': fixProposalResolvable(),
      'review.md': reviewNeedsWork(),
    });

    const fromMcp = runGate({ incidentId: INC, to: 'RESOLVED', workspace: dir });
    const fromCore = coreGate(dir, INC, 'RESOLVED');

    assert.equal(fromMcp.allowed, false, 'a NEEDS_WORK review must keep RESOLVED closed');
    assert.deepEqual(fromMcp, fromCore, 'MCP gate must equal core gate');
  });
});

test('parity: runGate fails closed on a MISSING incident, matching the CLI/core path', () => {
  withTempWorkspace((dir) => {
    // Workspace with a board but no incidents directory at all.
    writeFile(dir, 'board.md', board());

    const missingId = 'INC-DOES-NOT-EXIST';
    const fromMcp = runGate({ incidentId: missingId, to: 'RESOLVED', workspace: dir });

    // The handler short-circuits before calling core for a not-found incident.
    // Independently derive the object the handler (and the CLI's runGate) build
    // for this case — both derive the reason identically.
    const expected = {
      allowed: false,
      reason: `incident "${missingId}" not found in workspace "${dir}"`,
    };

    assert.equal(fromMcp.allowed, false, 'a missing incident must fail closed');
    assert.deepEqual(fromMcp, expected, 'MCP gate not-found result must match the CLI/core path');
  });
});

// ===========================================================================
// verdict parity
// ===========================================================================

test('parity: runVerdict matches core verdict on a PASS review', () => {
  withTempWorkspace((dir) => {
    writeIncidentFiles(dir, INC, {
      'incident.md': incidentMd({ status: 'FIX_STAGED', fixVersion: 1 }),
      'review.md': reviewPass(),
    });

    const fromMcp = runVerdict({ incidentId: INC, workspace: dir });
    const fromCore = verdict(readWorkspace(dir).incidents[INC]['review.md']);

    assert.equal(fromMcp.verdict, 'PASS', 'a canonical PASS line should parse as PASS');
    assert.deepEqual(fromMcp, fromCore, 'MCP verdict must equal core verdict');
  });
});

test('parity: runVerdict matches core verdict on a NEEDS_WORK review', () => {
  withTempWorkspace((dir) => {
    writeIncidentFiles(dir, INC, {
      'incident.md': incidentMd({ status: 'CHANGES_REQUESTED', fixVersion: 1 }),
      'review.md': reviewNeedsWork(),
    });

    const fromMcp = runVerdict({ incidentId: INC, workspace: dir });
    const fromCore = verdict(readWorkspace(dir).incidents[INC]['review.md']);

    assert.equal(fromMcp.verdict, 'NEEDS_WORK', 'an explicit NEEDS_WORK line should parse as NEEDS_WORK');
    assert.deepEqual(fromMcp, fromCore, 'MCP verdict must equal core verdict');
  });
});

test('parity: runVerdict matches core verdict when review.md is MISSING (fail-closed NEEDS_WORK)', () => {
  withTempWorkspace((dir) => {
    // Incident exists but has no review.md.
    writeIncidentFiles(dir, INC, {
      'incident.md': incidentMd({ status: 'INVESTIGATING', fixVersion: 1 }),
    });

    const fromMcp = runVerdict({ incidentId: INC, workspace: dir });
    // The handler passes reviewText=undefined to core verdict for a missing
    // review.md; replicate that exact core call.
    const fromCore = verdict(undefined);

    assert.equal(fromMcp.verdict, 'NEEDS_WORK', 'no usable review must read as NEEDS_WORK');
    assert.deepEqual(fromMcp, fromCore, 'MCP verdict must equal core verdict for a missing review');
  });
});
