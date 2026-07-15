// Power install-verification tests (task 13.1, Requirement 13.6:
// "The Patchwork SHALL be installable from a public GitHub repository and from
// a local folder through the IDE Powers panel").
//
// ===========================================================================
// HONEST SCOPE — what is verified END-TO-END vs. what is a PRECONDITION/PROXY
// ===========================================================================
// The literal "install through the IDE Powers panel" (pasting a GitHub URL or
// picking a local folder in Kiro) is a GUI-driven MANUAL action that cannot be
// automated headlessly. This suite therefore splits into two honest kinds of
// assertion, and each test says which kind it is:
//
//   END-TO-END (really executed here):
//     * The local-folder install scenario — onboarding actually runs against
//       the repo root as the "local folder" source and mutates a temp target,
//       installing the guardrail hook and scaffolding a workspace that then
//       passes the engine's own validate(). This is the real install work a
//       local-folder Powers-panel install triggers after Kiro reads POWER.md.
//     * The activation catalog — the `patchwork` MCP server the mcp.json entry
//       launches really lists validate/gate/verdict over the protocol.
//
//   PRECONDITION / PROXY (for the manual GUI step we cannot drive):
//     * Self-containment + no machine-specific paths in POWER.md / mcp.json.
//       These prove the checkout a GitHub clone OR a local-folder pick produces
//       is complete and relocatable, which is what makes the manual Powers-panel
//       install succeed on another machine. They are proxies for that GUI step,
//       not the step itself.
//     * The git-tracked proxy for "ships in a clone" is best-effort and
//       WARN-level (see the note on checkCommitted below) — NOT a hard gate.
//
// This suite performs NO network I/O and does NOT fake a GitHub clone or a
// network install — faking those would prove nothing. It verifies the
// programmatically-checkable preconditions and leaves the GUI action to the
// documented manual steps in scripts/verify-install.mjs.
//
// _Requirements: 13.6_

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { onboard, HOOK_FILES } from '../onboarding.js';
import { validate } from '../core/validate.js';
import { readWorkspace } from '../read-workspace.js';
import { createServer } from '../mcp.js';
import {
  verifyInstall,
  findAbsoluteLocalPaths,
  checkCommitted,
  REQUIRED_ARTIFACTS,
  REPO_ROOT,
} from '../../scripts/verify-install.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// engine/test -> engine -> repo root (the bundled Power source a Powers-panel
// install reads). Mirrors onboarding.test.js / power-lint.test.js.
const REPO = path.join(__dirname, '..', '..');
const POWER_PATH = path.join(REPO, 'POWER.md');
const MCP_PATH = path.join(REPO, 'mcp.json');
const STEERING_DIR = path.join(REPO, '.kiro', 'steering');
const AGENTS_DIR = path.join(REPO, '.kiro', 'agents');
const VERIFY_SCRIPT_PATH = path.join(REPO, 'scripts', 'verify-install.mjs');

// The three deterministic engine tools activation exposes (design "Components
// > 3 Patchwork_MCP_Server"). Sorted for stable comparison.
const ENGINE_TOOLS = ['gate', 'validate', 'verdict'];

// The three scoped custom agents that must ship in-repo (Requirement 13.5); a
// Powers-panel install reads both the JSON config and the Markdown prompt.
const AGENT_BASENAMES = ['patchwork-sre', 'patchwork-reviewer', 'patchwork-scribe'];

// ---------------------------------------------------------------------------
// Small local helpers (kept minimal; the repo is dependency-light)
// ---------------------------------------------------------------------------

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

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchwork-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Count files with a given extension anywhere under a directory tree.
function countFilesRecursive(dir, ext) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFilesRecursive(full, ext);
    else if (entry.name.endsWith(ext)) count++;
  }
  return count;
}

// Extract the `keywords:` JSON array from a POWER.md frontmatter block. The
// value is a single-line JSON-style array, so a focused regex + JSON.parse is
// enough and avoids adding a YAML dependency (mirrors the hand-parsing approach
// in schema.js / power-lint.test.js). Returns null when not found/parseable.
function readPowerKeywords(powerText) {
  const m = powerText.match(/^keywords:\s*(\[[^\n]*\])\s*$/m);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ===========================================================================
// 1. LOCAL-FOLDER INSTALL — END-TO-END (onboarding really runs)
// ===========================================================================
// This is the real install work a "install from a local folder" Powers-panel
// action triggers: Kiro reads POWER.md, then onboarding installs the guardrail
// hook and scaffolds the workspace. We model the picked "local folder" as the
// repo root (sourceDir = REPO) and the destination repo as a fresh temp dir, so
// nothing real is mutated. Onboarding MECHANICS (fail-closed, idempotency,
// version checks) are already covered exhaustively by onboarding.test.js — here
// we assert only the install-scenario outcome, minimally.

test('local-folder install: onboarding installs the hook + scaffolds a valid workspace (END-TO-END, Req 13.6)', (t) => {
  const targetDir = makeTempRepo(t);

  // Install "from the local folder" (the repo root) into the target repo.
  const result = onboard({ targetDir, sourceDir: REPO });

  assert.equal(result.ok, true, `onboarding must succeed: ${result.message}`);

  // The guardrail hook files land in the target's .kiro/hooks/.
  for (const file of HOOK_FILES) {
    assert.ok(
      fileExists(path.join(targetDir, '.kiro', 'hooks', file)),
      `${file} must be installed into the target's .kiro/hooks/`,
    );
  }

  // The patchwork/ workspace scaffold exists...
  assert.ok(
    fileExists(path.join(targetDir, 'patchwork', 'board.md')),
    'patchwork/board.md must be scaffolded',
  );
  assert.ok(
    dirExists(path.join(targetDir, 'patchwork', 'incidents')),
    'patchwork/incidents/ must be scaffolded',
  );

  // ...and it is schema-valid per the engine's OWN validate() — the freshly
  // installed workspace is usable, not just present.
  const validation = validate(readWorkspace(path.join(targetDir, 'patchwork')));
  assert.equal(
    validation.ok,
    true,
    `the scaffolded workspace must pass validate(): ${JSON.stringify(validation.problems)}`,
  );
});

// ===========================================================================
// 2. KEYWORD ACTIVATION — loads the engine tools + steering
// ===========================================================================
// On an incident keyword, activation loads the Power's steering and the
// `patchwork` MCP tools. We verify the declared activation surface: keywords in
// POWER.md, the mcp.json server entry, the actual tool catalog that entry
// launches (END-TO-END, in-process), the steering directory POWER.md points at,
// and the three in-repo agent configs.

test('activation: POWER.md declares incident-activation keywords (Req 13.2/13.6)', () => {
  assert.ok(fileExists(POWER_PATH), 'POWER.md must exist at the repo root');
  const keywords = readPowerKeywords(fs.readFileSync(POWER_PATH, 'utf8'));
  assert.ok(
    Array.isArray(keywords) && keywords.length > 0,
    'POWER.md frontmatter must declare a non-empty keywords array',
  );
  // A representative activation subset the design pins; power-lint.test.js
  // checks the full set, so here we just confirm activation keywords are
  // declared (not a full re-lint).
  for (const kw of ['incident', 'outage', 'error', 'postmortem']) {
    assert.ok(
      keywords.includes(kw),
      `keywords must include the activation keyword "${kw}"`,
    );
  }
});

test('activation: mcp.json registers the "patchwork" server via a relative "node engine/mcp.js" (Req 13.6)', () => {
  assert.ok(fileExists(MCP_PATH), 'mcp.json must exist at the repo root');
  const mcp = JSON.parse(fs.readFileSync(MCP_PATH, 'utf8'));
  const names = Object.keys(mcp.mcpServers || {});
  assert.deepEqual(names, ['patchwork'], 'mcp.json must register exactly the "patchwork" server');

  const server = mcp.mcpServers.patchwork;
  assert.equal(server.command, 'node', 'the server must launch with node');
  assert.deepEqual(
    server.args,
    ['engine/mcp.js'],
    'the server args must be the RELATIVE engine entry point (no machine-specific path)',
  );
  // The auto-approved tools mcp.json declares are the three engine tools.
  assert.deepEqual(
    [...(server.autoApprove || [])].sort(),
    ENGINE_TOOLS,
    'mcp.json autoApprove must declare exactly validate/gate/verdict',
  );
});

test('activation: the "patchwork" server really lists validate/gate/verdict over the protocol (END-TO-END, Req 13.6)', async () => {
  // Prove the mcp.json declaration is not lying: launch the SAME server
  // engine/mcp.js registers (what `node engine/mcp.js` starts) and list its
  // tools over a real MCP handshake, in-process via the SDK's linked transport
  // pair. This ties mcp.json's autoApprove to the server's actual catalog.
  const server = createServer();
  const client = new Client({ name: 'patchwork-install-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(
      names,
      ENGINE_TOOLS,
      'activation must load exactly the validate/gate/verdict engine tools',
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('activation: the steering directory POWER.md points at exists and holds steering files (Req 13.6)', () => {
  const powerText = fs.readFileSync(POWER_PATH, 'utf8');
  // POWER.md references the steering location as `.kiro/steering/`.
  assert.match(
    powerText,
    /\.kiro\/steering\//,
    'POWER.md must reference the .kiro/steering/ location activation loads',
  );
  assert.ok(dirExists(STEERING_DIR), '.kiro/steering/ must exist');
  assert.ok(
    countFilesRecursive(STEERING_DIR, '.md') > 0,
    '.kiro/steering/ must contain at least one steering (.md) file',
  );
});

test('activation: the three scoped agent configs ship in-repo under .kiro/agents/ (Req 13.5/13.6)', () => {
  for (const base of AGENT_BASENAMES) {
    assert.ok(
      fileExists(path.join(AGENTS_DIR, `${base}.json`)),
      `${base}.json must ship under .kiro/agents/`,
    );
    assert.ok(
      fileExists(path.join(AGENTS_DIR, `${base}.md`)),
      `${base}.md prompt must ship under .kiro/agents/`,
    );
  }
});

// ===========================================================================
// 3. PUBLIC-GITHUB INSTALL — PRECONDITIONS / PROXIES (no network, no clone)
// ===========================================================================
// The GitHub Powers-panel install is manual; we verify the preconditions that
// make it succeed on another machine: the repo is self-contained and carries no
// machine-specific paths. These are PROXIES for the GUI step, exercised through
// the same verifyInstall() the human-runnable scripts/verify-install.mjs uses.

test('github-install precondition: verifyInstall() finds the repo self-contained and relocatable (PROXY, Req 13.6)', () => {
  const result = verifyInstall(REPO);

  // Non-vacuous guard: verifyInstall must actually run a battery of checks.
  assert.ok(
    Array.isArray(result.checks) && result.checks.length >= REQUIRED_ARTIFACTS.length,
    'verifyInstall must run at least one check per required artifact',
  );

  // Every precondition holds. On failure, name the offenders so the message is
  // actionable rather than a bare boolean.
  const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
  assert.equal(
    result.ok,
    true,
    `all install preconditions must hold; failed: ${failed.join('; ')}`,
  );

  // Spot-check the load-bearing checks are present AND passing (so ok===true is
  // not vacuously true because a check silently vanished).
  const byName = new Map(result.checks.map((c) => [c.name, c]));
  for (const name of [
    'artifact:POWER.md',
    'artifact:mcp.json',
    'artifact:engine',
    'artifact:.kiro/agents',
    'artifact:.kiro/hooks',
    'package.json:dependency:@modelcontextprotocol/sdk',
    'package.json:dependency:zod',
    'package.json:engines.node',
    'mcp.json:command',
    'mcp.json:relative-args',
    'no-absolute-paths:POWER.md',
    'no-absolute-paths:mcp.json',
  ]) {
    assert.ok(byName.has(name), `verifyInstall must include the "${name}" check`);
    assert.equal(byName.get(name).ok, true, `check "${name}" must pass`);
  }
});

test('github-install precondition: POWER.md and mcp.json carry no absolute/local-only paths (PROXY, Req 13.6)', () => {
  for (const [label, p] of [
    ['POWER.md', POWER_PATH],
    ['mcp.json', MCP_PATH],
  ]) {
    const hits = findAbsoluteLocalPaths(fs.readFileSync(p, 'utf8'));
    assert.deepEqual(
      hits,
      [],
      `${label} must contain no machine-specific paths, found: ${hits.join(', ')}`,
    );
  }
});

test('control: findAbsoluteLocalPaths discriminates machine-specific paths from clean relative config', () => {
  // Non-vacuous guard: prove the detector actually flags the bad and clears the
  // good, so the "no absolute paths" assertions above cannot pass simply because
  // the detector always returns []. (A https:// URL must NOT be mistaken for a
  // drive path — POWER.md legitimately links to kiro.dev docs.)
  assert.ok(findAbsoluteLocalPaths('C:\\Users\\me\\repo\\engine').length > 0, 'flags a Windows drive path');
  assert.ok(findAbsoluteLocalPaths('/Users/me/kiro-patchwork').length > 0, 'flags a POSIX home path');
  assert.ok(findAbsoluteLocalPaths('file:///c:/repo/mcp.json').length > 0, 'flags a file:// URL');
  assert.deepEqual(findAbsoluteLocalPaths('node engine/mcp.js'), [], 'clears a relative command');
  assert.deepEqual(findAbsoluteLocalPaths('see https://kiro.dev/docs/'), [], 'clears an https:// URL');
});

// The git-tracked check is a BEST-EFFORT PROXY for "ships in a GitHub clone",
// and is WARN-level in the script (an uncommitted working tree mid-development
// legitimately has untracked files). We therefore assert only its SHAPE and
// graceful degradation — never that `untracked` is empty, which would turn a
// normal uncommitted state into a false regression.
test('github-install proxy: checkCommitted degrades gracefully and reports tracked/untracked shape (Req 13.6)', () => {
  const committed = checkCommitted(REPO);
  if (committed === null) {
    // git unavailable — the script says so and falls back to the on-disk check.
    return;
  }
  assert.ok(Array.isArray(committed.tracked), 'tracked must be an array');
  assert.ok(Array.isArray(committed.untracked), 'untracked must be an array');
  // A file is never both tracked and untracked.
  for (const p of committed.untracked) {
    assert.ok(!committed.tracked.includes(p), `${p} cannot be both tracked and untracked`);
  }
});

// ===========================================================================
// 4. THE HUMAN-RUNNABLE SCRIPT — exists and documents the manual GUI steps
// ===========================================================================
// Requirement 13.6's manual half lives as documentation a human follows. Assert
// the runnable script exists and its comments actually spell out both manual
// Powers-panel paths (a GitHub URL and a local folder), so the "manual step"
// half of the requirement is discoverable, not implied.

test('scripts/verify-install.mjs exists and documents both manual Powers-panel paths (Req 13.6)', () => {
  assert.ok(fileExists(VERIFY_SCRIPT_PATH), 'scripts/verify-install.mjs must exist for a human to run');
  const scriptText = fs.readFileSync(VERIFY_SCRIPT_PATH, 'utf8');
  assert.match(scriptText, /powers panel/i, 'the script must document the Powers-panel install');
  assert.match(scriptText, /github/i, 'the script must document the public-GitHub install path');
  assert.match(scriptText, /local folder/i, 'the script must document the local-folder install path');
});
