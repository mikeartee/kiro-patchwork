// End-to-end tests for the Patchwork CLI exit contract (task 1.5).
//
// The CLI reads a workspace from disk and sets a real process exit code, which
// is the contract the Guardrail Hook relies on. These tests spawn the CLI as a
// child process (node engine/cli.js validate --workspace <tmpdir>) against a
// temporary on-disk workspace built under os.tmpdir(), and assert:
//   - ZERO exit on a VALID workspace
//   - NON-ZERO exit, with offending paths in the output, on an INVALID workspace
//   - the machine-readable JSON line (last stdout line) reflects the result
//   - an unknown/absent command is a usage error (exit 2)
//
// Temp workspaces are removed in a finally block.
//
// _Requirements: 1.5, 10.1, 10.4_

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli.js');

const DOT = '\u00B7';
const DASH = '\u2014';
const INC = 'INC-2024-001';

// ---------------------------------------------------------------------------
// Helpers: build a temp on-disk workspace, run the CLI, parse its JSON line
// ---------------------------------------------------------------------------

function mkTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'patchwork-cli-'));
}

function writeFile(dir, relPath, contents) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

/** Write a complete, valid RESOLVED incident + board into workspaceDir. */
function writeValidWorkspace(workspaceDir) {
  writeFile(
    workspaceDir,
    'board.md',
    [
      '# Patchwork Board',
      '',
      `[2024-06-01T14:03Z] @alice ${DOT} Incident Commander (human) ${DOT} report: /checkout 500s`,
      `[2024-06-01T14:07Z] @patchwork-sre ${DOT} SRE (agent) ${DOT} analysis: root cause found`,
      '',
    ].join('\n'),
  );

  const incRel = path.join('incidents', INC);
  writeFile(
    workspaceDir,
    path.join(incRel, 'incident.md'),
    [
      '---',
      `id: ${INC}`,
      'title: Checkout endpoint returns 500 under coupon stacking',
      'status: RESOLVED',
      'fix_version: 1',
      '---',
      '',
    ].join('\n'),
  );
  writeFile(workspaceDir, path.join(incRel, 'analysis.md'), '# Analysis\n');
  writeFile(
    workspaceDir,
    path.join(incRel, 'fix-proposal.md'),
    [
      '# Fix Proposal',
      '',
      `- [AFK] Revert commit a1b2c3d ${DASH} verify: reproduction test passes`,
      `- [HITL] Rotate the API key ${DASH} verify: Commander confirms new key deployed`,
      '',
    ].join('\n'),
  );
  writeFile(workspaceDir, path.join(incRel, 'review.md'), 'VERDICT: PASS\n');
  writeFile(workspaceDir, path.join(incRel, 'decision-log.md'), '# Decision Log\n');
  writeFile(workspaceDir, path.join(incRel, 'postmortem.md'), '# Post-mortem\n');
}

/**
 * Write an INVALID workspace: a valid INVESTIGATING incident but NO board.md,
 * so the sole problem is the missing board (a single, predictable offending
 * path to assert against).
 */
function writeInvalidWorkspace(workspaceDir) {
  const incRel = path.join('incidents', INC);
  writeFile(
    workspaceDir,
    path.join(incRel, 'incident.md'),
    [
      '---',
      `id: ${INC}`,
      'title: Checkout endpoint returns 500 under coupon stacking',
      'status: INVESTIGATING',
      'fix_version: 1',
      '---',
      '',
    ].join('\n'),
  );
  // Deliberately no board.md.
}

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
  });
  return result;
}

/** Parse the last non-empty stdout line as the machine-readable JSON result. */
function parseJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  return JSON.parse(lines[lines.length - 1]);
}

// ---------------------------------------------------------------------------
// Zero exit on a valid workspace
// ---------------------------------------------------------------------------

test('CLI: validate exits 0 on a valid workspace', () => {
  const dir = mkTempWorkspace();
  try {
    writeValidWorkspace(dir);
    const result = runCli(['validate', '--workspace', dir]);

    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);

    const json = parseJsonLine(result.stdout);
    assert.equal(json.command, 'validate');
    assert.equal(json.ok, true);
    assert.deepEqual(json.problems, []);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Non-zero exit with offending paths on an invalid workspace
// ---------------------------------------------------------------------------

test('CLI: validate exits non-zero and lists offending paths on an invalid workspace', () => {
  const dir = mkTempWorkspace();
  try {
    writeInvalidWorkspace(dir);
    const result = runCli(['validate', '--workspace', dir]);

    assert.notEqual(result.status, 0, 'expected a non-zero exit for problems');
    assert.equal(result.status, 1, 'protocol problems should map to exit code 1');

    // Human-readable output names the offending path...
    assert.match(result.stdout, /patchwork\/board\.md/);
    assert.match(result.stdout, /FAIL/);

    // ...and the machine-readable JSON line agrees.
    const json = parseJsonLine(result.stdout);
    assert.equal(json.ok, false);
    assert.ok(json.problems.length >= 1);
    assert.ok(
      json.problems.some(
        (p) =>
          p.rule === 'workspace.board.missing' &&
          p.path === 'patchwork/board.md',
      ),
      `expected a board.missing problem, got ${JSON.stringify(json.problems)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Usage error contract
// ---------------------------------------------------------------------------

test('CLI: an unknown command is a usage error (exit 2)', () => {
  const result = runCli(['frobnicate']);
  assert.equal(result.status, 2, 'unknown command should exit 2');
  assert.match(result.stderr, /Usage:/);
});

test('CLI: no command is a usage error (exit 2)', () => {
  const result = runCli([]);
  assert.equal(result.status, 2, 'absent command should exit 2');
  assert.match(result.stderr, /Usage:/);
});
