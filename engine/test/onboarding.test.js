// Onboarding tests (task 11.2).
//
// The unit under test is engine/onboarding.js: a fail-safe first-use setup that
// VALIDATES the required Node dependency BEFORE any change and only on success
// installs the guardrail hook into the target repo's `.kiro/hooks/` and
// scaffolds `patchwork/`. The load-bearing guarantee is fail-closed /
// no-half-scaffold: when the Node dependency check fails, onboarding makes NO
// filesystem change (Requirements 13.3, 13.4; design "Error Handling >
// Onboarding dependency failure").
//
// Each test onboards into a fresh temp directory (the target repo) so the real
// repo is never mutated, and reads the guardrail hook files from the real
// bundled source (the repo root) so the install path is exercised end-to-end.
// Temp dirs are removed via t.after.
//
// _Requirements: 13.3, 13.4_

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  onboard,
  checkNodeDependency,
  meetsMinimum,
  parseNodeVersion,
  parseMinVersion,
  readRequiredNodeRange,
  HOOK_FILES,
  DEFAULT_SOURCE_DIR,
} from '../onboarding.js';

import { validate } from '../core/validate.js';
import { readWorkspace } from '../read-workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// engine/test -> engine -> repo root (the bundled Power source).
const REPO_ROOT = path.join(__dirname, '..', '..');

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchwork-onboard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Version helpers (the dependency check's building blocks)
// ---------------------------------------------------------------------------

test('parseNodeVersion / parseMinVersion extract semantic versions', () => {
  assert.deepEqual(parseNodeVersion('v20.11.1'), { major: 20, minor: 11, patch: 1 });
  assert.deepEqual(parseNodeVersion('18.0.0'), { major: 18, minor: 0, patch: 0 });
  assert.deepEqual(parseMinVersion('>=20.0.0'), { major: 20, minor: 0, patch: 0 });
  assert.deepEqual(parseMinVersion('>=20'), { major: 20, minor: 0, patch: 0 });
});

test('meetsMinimum compares major/minor/patch in order', () => {
  const min = { major: 20, minor: 0, patch: 0 };
  assert.equal(meetsMinimum({ major: 20, minor: 11, patch: 1 }, min), true);
  assert.equal(meetsMinimum({ major: 20, minor: 0, patch: 0 }, min), true);
  assert.equal(meetsMinimum({ major: 18, minor: 20, patch: 0 }, min), false);
});

test('the required range is read from package.json (engines.node), not hardcoded', () => {
  assert.equal(readRequiredNodeRange(REPO_ROOT), '>=20.0.0');
});

test('checkNodeDependency passes for the running Node and fails for an old one', () => {
  const ok = checkNodeDependency({ sourceDir: REPO_ROOT });
  assert.equal(ok.ok, true, 'the running Node must satisfy the requirement');

  const old = checkNodeDependency({ currentVersion: 'v18.20.0', sourceDir: REPO_ROOT });
  assert.equal(old.ok, false);
  assert.match(old.message, /below the required/);
  assert.match(old.message, /No files were changed/);
});

// ---------------------------------------------------------------------------
// Fail-closed: a dependency failure makes NO filesystem change (the key test)
// ---------------------------------------------------------------------------

test('onboarding STOPS and does NOT half-scaffold when Node is too old (Req 13.3)', (t) => {
  const targetDir = makeTempRepo(t);

  const result = onboard({
    targetDir,
    sourceDir: REPO_ROOT,
    currentVersion: 'v18.20.0', // below >=20.0.0
  });

  assert.equal(result.ok, false, 'onboarding must report failure');
  assert.equal(result.changed, false);
  assert.equal(result.workspace, null, 'no workspace result on the failure path');
  assert.deepEqual(result.hooks, [], 'no hook install on the failure path');
  assert.match(result.message, /below the required/);

  // The decisive assertion: NOTHING was written to the target repo.
  assert.equal(dirExists(path.join(targetDir, '.kiro')), false, 'no .kiro/ created');
  assert.equal(dirExists(path.join(targetDir, 'patchwork')), false, 'no patchwork/ created');
  assert.deepEqual(fs.readdirSync(targetDir), [], 'the target repo stays empty');
});

// ---------------------------------------------------------------------------
// Success path: hook installed + workspace scaffolded, and it is schema-valid
// ---------------------------------------------------------------------------

test('onboarding installs the hook and scaffolds a valid workspace on success (Req 13.4)', (t) => {
  const targetDir = makeTempRepo(t);

  const result = onboard({ targetDir, sourceDir: REPO_ROOT });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);

  // Both guardrail hook files landed in the target's .kiro/hooks/.
  for (const file of HOOK_FILES) {
    assert.ok(
      fileExists(path.join(targetDir, '.kiro', 'hooks', file)),
      `${file} must be installed into .kiro/hooks/`,
    );
  }
  assert.ok(result.hooks.every((h) => h.action === 'installed'));

  // The workspace scaffold exists: board.md + incidents/.
  assert.ok(fileExists(path.join(targetDir, 'patchwork', 'board.md')));
  assert.ok(dirExists(path.join(targetDir, 'patchwork', 'incidents')));

  // And the freshly scaffolded workspace passes the engine's own validate().
  const snapshot = readWorkspace(path.join(targetDir, 'patchwork'));
  const validation = validate(snapshot);
  assert.equal(validation.ok, true, `scaffold must be valid: ${JSON.stringify(validation.problems)}`);
});

// ---------------------------------------------------------------------------
// Idempotency: a re-run preserves existing user content (no clobber)
// ---------------------------------------------------------------------------

test('re-running onboarding preserves existing hook and workspace content (idempotent)', (t) => {
  const targetDir = makeTempRepo(t);

  // First run scaffolds everything.
  onboard({ targetDir, sourceDir: REPO_ROOT });

  // Simulate real user content: a populated board and a live incident.
  const boardPath = path.join(targetDir, 'patchwork', 'board.md');
  const populatedBoard =
    '# Patchwork Board\n\n[2024-06-01T14:03Z] @alice \u00B7 Incident Commander (human) \u00B7 report: real work\n';
  fs.writeFileSync(boardPath, populatedBoard, 'utf8');

  const incidentDir = path.join(targetDir, 'patchwork', 'incidents', 'INC-2024-042');
  fs.mkdirSync(incidentDir, { recursive: true });
  const incidentPath = path.join(incidentDir, 'incident.md');
  fs.writeFileSync(incidentPath, 'real incident content', 'utf8');

  // Second run must NOT clobber any of it.
  const rerun = onboard({ targetDir, sourceDir: REPO_ROOT });

  assert.equal(rerun.changed, false, 'a re-run over a set-up repo changes nothing');
  assert.equal(fs.readFileSync(boardPath, 'utf8'), populatedBoard, 'populated board preserved');
  assert.equal(fs.readFileSync(incidentPath, 'utf8'), 'real incident content', 'existing incident preserved');
  assert.ok(rerun.hooks.every((h) => h.action === 'preserved'), 'existing hooks preserved');
  assert.equal(rerun.workspace.board.action, 'preserved');
  assert.equal(rerun.workspace.incidents.action, 'preserved');
});

// A guard that the bundled source actually holds the hook files the install
// copies — otherwise the success-path test would pass vacuously.
test('the bundled source holds the guardrail hook files onboarding installs', () => {
  for (const file of HOOK_FILES) {
    assert.ok(
      fileExists(path.join(DEFAULT_SOURCE_DIR, '.kiro', 'hooks', file)),
      `bundled source must ship ${file}`,
    );
  }
});
