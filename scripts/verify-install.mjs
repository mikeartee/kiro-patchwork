#!/usr/bin/env node
// scripts/verify-install.mjs
//
// Human-runnable install verification for the Kiro Patchwork Power (task 13.1,
// Requirement 13.6: "The Patchwork SHALL be installable from a public GitHub
// repository and from a local folder through the IDE Powers panel").
//
// ---------------------------------------------------------------------------
// HONEST SCOPE — what this verifies vs. what it cannot
// ---------------------------------------------------------------------------
// The actual "install through the IDE Powers panel" is a GUI-driven, MANUAL
// action: a human pastes a GitHub URL or picks a local folder in Kiro's Powers
// panel. That step cannot be automated headlessly, and this script does NOT
// fake a network install, clone anything, or drive the IDE.
//
// What IS automatable — and what this script checks — is the set of install
// PRECONDITIONS: that the repository is a self-contained, relocatable Power
// that a Powers-panel install (whether from a public GitHub clone OR from a
// local folder) can consume on another machine without reaching outside the
// repo. Concretely it verifies:
//   1. Every artifact a Powers-panel install reads is present (POWER.md,
//      mcp.json, package.json + lockfile, the engine, the three agent configs,
//      the guardrail hook source, steering, and the lifecycle prompts).
//   2. package.json is self-contained: it declares the engine's runtime
//      dependencies and its Node engines range, so `npm install` after a clone
//      restores everything the MCP server needs.
//   3. mcp.json launches the server with a RELATIVE command/args
//      (`node engine/mcp.js`) — never an absolute, machine-specific path.
//   4. Neither POWER.md nor mcp.json embeds an absolute / local-only path
//      (a Windows drive path, a POSIX home path, or a file:// URL) that would
//      break on another machine after a GitHub clone.
//
// ---------------------------------------------------------------------------
// MANUAL POWERS-PANEL STEPS (run these by hand to complete a real install)
// ---------------------------------------------------------------------------
// Install from a PUBLIC GITHUB REPOSITORY:
//   1. Open Kiro, go to the Powers panel, choose to add/install a Power.
//   2. Pick the "from GitHub" option and paste the repository URL
//      (for example https://github.com/<org>/kiro-patchwork).
//   3. Kiro clones the repo, reads POWER.md, and registers the `patchwork`
//      MCP server declared in mcp.json.
//   4. Run onboarding (engine/onboarding.js) to install the guardrail hook
//      into .kiro/hooks/ and scaffold the patchwork/ workspace.
//
// Install from a LOCAL FOLDER:
//   1. Open Kiro, go to the Powers panel, choose to add/install a Power.
//   2. Pick the "from local folder" option and select this repository's root
//      (the directory that contains POWER.md).
//   3-4. Same as above: POWER.md + mcp.json are read, the MCP server is
//      registered, and onboarding installs the hook + scaffolds patchwork/.
//
// After either path, activating on an incident keyword (see POWER.md
// `keywords`) loads the steering under .kiro/steering/ and the `patchwork` MCP
// tools (validate / gate / verdict).
//
// Exit code: 0 when every precondition holds, 1 otherwise, so a human or CI can
// gate on it. Run it from anywhere: `node scripts/verify-install.mjs`.
//
// _Requirements: 13.6_

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> repo root (the bundled Power source a Powers-panel install reads).
export const REPO_ROOT = path.join(__dirname, '..');

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

// The artifacts a GitHub-based (or local-folder) Powers-panel install needs to
// find in the checkout. Everything here must be committed to the repo so a
// fresh clone on another machine is complete. `type` selects the existence
// check (file vs. directory).
export const REQUIRED_ARTIFACTS = Object.freeze([
  // Packaging manifest + MCP registration the Powers panel reads first.
  { path: 'POWER.md', type: 'file' },
  { path: 'mcp.json', type: 'file' },
  // Node package metadata + lockfile: self-contained `npm install` after clone.
  { path: 'package.json', type: 'file' },
  { path: 'package-lock.json', type: 'file' },
  // The deterministic engine (the trust anchor) and its two surfaces.
  { path: 'engine', type: 'dir' },
  { path: 'engine/mcp.js', type: 'file' },
  { path: 'engine/cli.js', type: 'file' },
  { path: 'engine/onboarding.js', type: 'file' },
  { path: 'engine/core', type: 'dir' },
  // The three scoped custom agents (ship in-repo, Requirement 13.5).
  { path: '.kiro/agents', type: 'dir' },
  { path: '.kiro/agents/patchwork-sre.json', type: 'file' },
  { path: '.kiro/agents/patchwork-sre.md', type: 'file' },
  { path: '.kiro/agents/patchwork-reviewer.json', type: 'file' },
  { path: '.kiro/agents/patchwork-reviewer.md', type: 'file' },
  { path: '.kiro/agents/patchwork-scribe.json', type: 'file' },
  { path: '.kiro/agents/patchwork-scribe.md', type: 'file' },
  // The guardrail hook SOURCE onboarding copies into a target repo's hooks dir.
  { path: '.kiro/hooks', type: 'dir' },
  { path: '.kiro/hooks/patchwork-guardrail.kiro.hook', type: 'file' },
  { path: '.kiro/hooks/patchwork-guardrail.mjs', type: 'file' },
  // Steering + lifecycle prompts activation loads.
  { path: '.kiro/steering', type: 'dir' },
  { path: '.kiro/prompts', type: 'dir' },
  { path: '.kiro/prompts/incident.md', type: 'file' },
  { path: '.kiro/prompts/analyze.md', type: 'file' },
  { path: '.kiro/prompts/review.md', type: 'file' },
  { path: '.kiro/prompts/human-itl.md', type: 'file' },
  { path: '.kiro/prompts/postmortem.md', type: 'file' },
  // The local-only sample app that grounds the demo (Requirement 14).
  { path: 'sample-app', type: 'dir' },
]);

// The runtime dependencies package.json must declare so a clone's `npm install`
// restores the MCP server's needs without any out-of-repo fetch trickery.
const REQUIRED_DEPENDENCIES = Object.freeze([
  '@modelcontextprotocol/sdk',
  'zod',
]);

/**
 * Find absolute / local-only filesystem path references in a blob of config
 * text. These are the references that would break on another machine after a
 * GitHub clone. Detects:
 *   - a Windows drive path (`C:\...` or `C:/...`), guarded so a URL scheme such
 *     as `https://` is NOT mistaken for a `s:/` drive path;
 *   - a POSIX home/root absolute path (`/Users/...`, `/home/...`, `/root/...`);
 *   - a `file://` URL.
 * Returns the list of offending substrings (empty when the text is clean).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function findAbsoluteLocalPaths(text) {
  const s = String(text);
  const patterns = [
    // Windows drive path. The drive letter must sit at the start or follow a
    // separator/quote/paren/equals so "https://" (letter preceded by a letter)
    // is not flagged as a "s:/" drive path.
    /(?:^|[\s"'`(=[,])([A-Za-z]:[\\/])/g,
    // POSIX home / root absolute paths that only exist on one machine.
    /(?:^|[\s"'`(=[,])(\/(?:Users|home|root)\/)/g,
    // Explicit local-file URLs.
    /(file:\/\/)/gi,
  ];
  const hits = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s)) !== null) {
      hits.push((m[1] || m[0]).trim());
    }
  }
  return hits;
}

/**
 * Parse the single MCP server entry from mcp.json text.
 *
 * @param {string} mcpText
 * @returns {{ name: string, server: object }|null}
 */
function readMcpServer(mcpText) {
  const mcp = JSON.parse(mcpText);
  if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object') return null;
  const names = Object.keys(mcp.mcpServers);
  if (names.length !== 1) return null;
  return { name: names[0], server: mcp.mcpServers[names[0]] };
}

/**
 * Verify the install PRECONDITIONS against a repo root. Pure filesystem +
 * config-text checks only — no git, no network, no subprocess — so it is
 * deterministic and safe to import from a test. Returns a structured result;
 * the caller decides how to present or gate on it.
 *
 * @param {string} [repoRoot]
 * @returns {{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail: string }> }}
 */
export function verifyInstall(repoRoot = REPO_ROOT) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: String(detail) });

  // 1. Every required artifact is present and committed-shaped on disk.
  for (const artifact of REQUIRED_ARTIFACTS) {
    const abs = path.join(repoRoot, artifact.path);
    const ok = artifact.type === 'dir' ? dirExists(abs) : fileExists(abs);
    add(
      `artifact:${artifact.path}`,
      ok,
      ok ? `present (${artifact.type})` : `MISSING (${artifact.type})`,
    );
  }

  // 2. package.json is self-contained: engine deps + engines.node declared.
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fileExists(pkgPath)) {
    add('package.json:readable', false, 'package.json missing');
  } else {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = pkg.dependencies || {};
      for (const dep of REQUIRED_DEPENDENCIES) {
        const has = Object.prototype.hasOwnProperty.call(deps, dep);
        add(
          `package.json:dependency:${dep}`,
          has,
          has ? `pinned to ${deps[dep]}` : 'not declared in dependencies',
        );
      }
      const engineNode = pkg.engines && pkg.engines.node;
      add(
        'package.json:engines.node',
        Boolean(engineNode),
        engineNode ? `requires Node ${engineNode}` : 'engines.node not declared',
      );
    } catch (err) {
      add('package.json:parse', false, `unparseable: ${err.message}`);
    }
  }

  // 3. mcp.json launches the server with a RELATIVE command/args.
  const mcpPath = path.join(repoRoot, 'mcp.json');
  let mcpText = null;
  if (!fileExists(mcpPath)) {
    add('mcp.json:readable', false, 'mcp.json missing');
  } else {
    try {
      mcpText = fs.readFileSync(mcpPath, 'utf8');
      const entry = readMcpServer(mcpText);
      if (!entry) {
        add('mcp.json:single-server', false, 'expected exactly one mcpServers entry');
      } else {
        const { server } = entry;
        add('mcp.json:command', server.command === 'node', `command = ${JSON.stringify(server.command)}`);
        const args = Array.isArray(server.args) ? server.args : [];
        const relativeArgs =
          args.length > 0 && findAbsoluteLocalPaths(args.join(' ')).length === 0;
        add(
          'mcp.json:relative-args',
          relativeArgs && args.includes('engine/mcp.js'),
          `args = ${JSON.stringify(args)}`,
        );
      }
    } catch (err) {
      add('mcp.json:parse', false, `unparseable: ${err.message}`);
    }
  }

  // 4. No absolute / local-only path references in POWER.md or mcp.json.
  const powerPath = path.join(repoRoot, 'POWER.md');
  for (const [label, filePath, text] of [
    ['POWER.md', powerPath, fileExists(powerPath) ? fs.readFileSync(powerPath, 'utf8') : null],
    ['mcp.json', mcpPath, mcpText],
  ]) {
    if (text === null) {
      add(`no-absolute-paths:${label}`, false, `${label} unreadable`);
      continue;
    }
    const hits = findAbsoluteLocalPaths(text);
    add(
      `no-absolute-paths:${label}`,
      hits.length === 0,
      hits.length === 0 ? 'no machine-specific paths' : `found: ${hits.join(', ')}`,
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Best-effort check that the required artifacts are TRACKED by git (i.e. would
 * ship in a `git clone`). Runs `git ls-files` once and intersects. Returns null
 * when git is unavailable or errors (so the caller can degrade gracefully — a
 * clean working tree on disk is already covered by verifyInstall).
 *
 * @param {string} [repoRoot]
 * @returns {{ tracked: string[], untracked: string[] }|null}
 */
export function checkCommitted(repoRoot = REPO_ROOT) {
  let out;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return null;
  }
  const tracked = new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const fileArtifacts = REQUIRED_ARTIFACTS.filter((a) => a.type === 'file').map((a) => a.path);
  const untracked = fileArtifacts.filter((p) => !tracked.has(p));
  return { tracked: fileArtifacts.filter((p) => tracked.has(p)), untracked };
}

/**
 * Runnable entry point: verify preconditions, print a human-readable report
 * plus a machine-readable JSON line, add a best-effort git-tracked report, and
 * return the process exit code (0 all-clear, 1 on any failed precondition).
 *
 * @param {string[]} [argv]
 * @returns {number}
 */
export function main() {
  const result = verifyInstall(REPO_ROOT);

  console.log('Kiro Patchwork — install precondition check\n');
  for (const check of result.checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
  }

  const committed = checkCommitted(REPO_ROOT);
  if (committed === null) {
    console.log('\n  INFO  git unavailable — skipped the committed-in-git check.');
  } else if (committed.untracked.length === 0) {
    console.log('\n  PASS  every required file artifact is tracked by git (ships in a clone).');
  } else {
    console.log(`\n  WARN  not tracked by git: ${committed.untracked.join(', ')}`);
  }

  console.log(
    '\n' +
      JSON.stringify({
        command: 'verify-install',
        ok: result.ok,
        failed: result.checks.filter((c) => !c.ok).map((c) => c.name),
        committed: committed === null ? null : { untracked: committed.untracked },
      }),
  );

  console.log(
    result.ok
      ? '\nAll install preconditions hold. Complete the install via the Powers panel (see the manual steps at the top of this file).'
      : '\nOne or more install preconditions FAILED — fix the items marked FAIL above before installing.',
  );

  return result.ok ? 0 : 1;
}

// Run only when executed directly, not when imported by tests (mirrors
// engine/cli.js / mcp.js / onboarding.js). Keeps the module import side-effect
// free so a test can call verifyInstall() without triggering a process exit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
