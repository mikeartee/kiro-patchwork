// Patchwork onboarding - the Power's first-use setup (task 11.2).
//
// Onboarding is fail-safe by construction (design "Error Handling > Onboarding
// dependency failure"): it VALIDATES the required Node dependency BEFORE making
// any change, and only on success does it (1) install the Guardrail Hook into
// the target repo's `.kiro/hooks/` and (2) scaffold the `patchwork/` workspace.
// If Node is unavailable or below the required version it STOPS with an
// actionable message and performs NO filesystem mutation, so a failure never
// leaves a half-scaffolded repo where the workspace exists but the guardrail
// does not (Requirements 13.3, 13.4).
//
// The logic here is pure-ish and testable: `checkNodeDependency` and `onboard`
// take the current Node version, the source (bundled Power) directory, and the
// target repo directory as parameters (all defaulted), so a test can drive the
// fail-closed path without needing an old Node runtime or touching the real
// repo. A thin run-when-invoked-directly guard at the bottom mirrors the
// cli.js / mcp.js pattern so importing this module has no side effects.
//
// Re-running after installing Node completes the setup. Onboarding is
// idempotent-friendly: it never clobbers existing user content — a populated
// `board.md` or an existing `incidents/` tree is preserved, and a hook file
// already present in the target is left untouched.
//
// _Requirements: 13.3, 13.4_

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The bundled Power root — one level up from engine/. This is where the
// reference `.kiro/hooks/` hook files and the required Node version
// (package.json `engines.node`) live. A test can override it via `sourceDir`.
export const DEFAULT_SOURCE_DIR = path.join(__dirname, '..');

// The two files that TOGETHER constitute the Guardrail Hook (task 8.2): the
// hook definition Kiro reads and its companion decider script. Both are copied
// into the target repo's `.kiro/hooks/` on a successful onboarding.
export const HOOK_FILES = Object.freeze([
  'patchwork-guardrail.kiro.hook',
  'patchwork-guardrail.mjs',
]);

// A fresh Board scaffold: the header and the entry-format note, but NO demo
// entries — a new repo starts with an empty timeline. Matches the design's
// "Data Models > Board entry format" grammar note. `validate` skips non-entry
// (prose) lines, so a board with no `[time] ...` lines is valid.
const BOARD_TEMPLATE = [
  '# Patchwork Board',
  '',
  'Attributed, append-only, chronological timeline of every human and agent',
  'contribution across incidents.',
  '',
  'Entry format: `[time] @who \u00B7 Role (human|agent) \u00B7 type:` followed by a short description.',
  '',
].join('\n');

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

/**
 * Extract a `{ major, minor, patch }` version from a version string such as
 * `"v20.11.1"` or `"20.11.1"`. Returns null when no numeric version is found.
 *
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }|null}
 */
export function parseNodeVersion(version) {
  const m = String(version).trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Parse the MINIMUM version from an `engines.node` range such as `">=20.0.0"`
 * (or a bare `">=20"`). Absent minor/patch default to 0. Returns null when no
 * numeric version can be found.
 *
 * @param {string} range
 * @returns {{ major: number, minor: number, patch: number }|null}
 */
export function parseMinVersion(range) {
  const m = String(range).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
  };
}

/**
 * Whether `current` is greater than or equal to `min` (semantic compare on
 * major, then minor, then patch).
 *
 * @param {{major:number,minor:number,patch:number}} current
 * @param {{major:number,minor:number,patch:number}} min
 * @returns {boolean}
 */
export function meetsMinimum(current, min) {
  if (current.major !== min.major) return current.major > min.major;
  if (current.minor !== min.minor) return current.minor > min.minor;
  return current.patch >= min.patch;
}

/**
 * Read the required Node version range from the source Power's package.json
 * (`engines.node`). Read from ONE place rather than hardcoding a second copy of
 * the requirement (the version lives only in package.json).
 *
 * @param {string} [sourceDir]
 * @returns {string|null}
 */
export function readRequiredNodeRange(sourceDir = DEFAULT_SOURCE_DIR) {
  const pkgPath = path.join(sourceDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return (pkg.engines && pkg.engines.node) || null;
}

/**
 * Validate that the running/target Node version satisfies the Protocol Engine's
 * requirement. This is the gate that runs BEFORE any filesystem change.
 *
 * @param {object} [options]
 * @param {string} [options.currentVersion]  version to check (default process.version).
 * @param {string} [options.sourceDir]       Power root holding package.json.
 * @param {string} [options.requiredRange]   override the range (else read from package.json).
 * @returns {{ ok: boolean, required: string|null, current: string, message: string }}
 */
export function checkNodeDependency({
  currentVersion = process.version,
  sourceDir = DEFAULT_SOURCE_DIR,
  requiredRange,
} = {}) {
  const range = requiredRange || readRequiredNodeRange(sourceDir);
  const min = range ? parseMinVersion(range) : null;
  const current = parseNodeVersion(currentVersion);

  if (!current) {
    return {
      ok: false,
      required: range,
      current: currentVersion,
      message:
        `Patchwork onboarding stopped: could not determine the running Node ` +
        `version ("${currentVersion}"). Install Node ${range ?? '(see package.json engines)'} ` +
        `and re-run onboarding. No files were changed.`,
    };
  }

  if (!min) {
    // No engines requirement declared anywhere — fail closed rather than guess.
    return {
      ok: false,
      required: range,
      current: currentVersion,
      message:
        `Patchwork onboarding stopped: the required Node version could not be ` +
        `read from package.json (engines.node). No files were changed.`,
    };
  }

  const ok = meetsMinimum(current, min);
  return {
    ok,
    required: range,
    current: currentVersion,
    message: ok
      ? `Node ${currentVersion} satisfies the required ${range}.`
      : `Patchwork onboarding stopped: Node ${currentVersion} is below the ` +
        `required ${range}. Install Node ${range} or newer and re-run ` +
        `onboarding. No files were changed.`,
  };
}

/**
 * Install the Guardrail Hook files into the target repo's `.kiro/hooks/`.
 * Idempotent: a hook file already present in the target is PRESERVED (never
 * overwritten), so a user's local edits survive a re-run.
 *
 * @param {object} args
 * @param {string} args.targetDir  repo to install into.
 * @param {string} args.sourceDir  bundled Power root to copy from.
 * @returns {Array<{ file: string, action: 'installed'|'preserved', path: string }>}
 */
function installGuardrailHook({ targetDir, sourceDir }) {
  const targetHooksDir = path.join(targetDir, '.kiro', 'hooks');
  const sourceHooksDir = path.join(sourceDir, '.kiro', 'hooks');
  const results = [];

  for (const file of HOOK_FILES) {
    const dest = path.join(targetHooksDir, file);
    if (fileExists(dest)) {
      // Preserve existing content — do not clobber the user's hook.
      results.push({ file, action: 'preserved', path: dest });
      continue;
    }
    fs.mkdirSync(targetHooksDir, { recursive: true });
    fs.copyFileSync(path.join(sourceHooksDir, file), dest);
    results.push({ file, action: 'installed', path: dest });
  }

  return results;
}

/**
 * Scaffold the `patchwork/` workspace (board.md + incidents/) in the target
 * repo. Idempotent: an existing (possibly populated) board.md or incidents/
 * directory is PRESERVED rather than overwritten, so real incident history is
 * never clobbered on a re-run.
 *
 * @param {object} args
 * @param {string} args.targetDir  repo to scaffold into.
 * @returns {{ board: {action:'created'|'preserved',path:string}, incidents: {action:'created'|'preserved',path:string} }}
 */
function scaffoldWorkspace({ targetDir }) {
  const workspaceDir = path.join(targetDir, 'patchwork');
  const boardPath = path.join(workspaceDir, 'board.md');
  const incidentsDir = path.join(workspaceDir, 'incidents');

  let board;
  if (fileExists(boardPath)) {
    board = { action: 'preserved', path: boardPath };
  } else {
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(boardPath, BOARD_TEMPLATE, 'utf8');
    board = { action: 'created', path: boardPath };
  }

  let incidents;
  if (dirExists(incidentsDir)) {
    incidents = { action: 'preserved', path: incidentsDir };
  } else {
    fs.mkdirSync(incidentsDir, { recursive: true });
    incidents = { action: 'created', path: incidentsDir };
  }

  return { board, incidents };
}

/**
 * Run onboarding: check the Node dependency first, and ONLY on success install
 * the guardrail hook and scaffold the workspace. On a dependency failure it
 * returns immediately having made NO filesystem change (no half-scaffold).
 *
 * @param {object} [options]
 * @param {string} [options.targetDir]      repo to onboard (default process.cwd()).
 * @param {string} [options.sourceDir]      bundled Power root (default the engine's repo).
 * @param {string} [options.currentVersion] Node version to check (default process.version).
 * @param {string} [options.requiredRange]  override the required range (else package.json).
 * @returns {{
 *   ok: boolean,
 *   changed: boolean,
 *   dependency: { ok:boolean, required:string|null, current:string, message:string },
 *   hooks: Array<{file:string,action:string,path:string}>,
 *   workspace: { board:object, incidents:object }|null,
 *   message: string,
 * }}
 */
export function onboard({
  targetDir = process.cwd(),
  sourceDir = DEFAULT_SOURCE_DIR,
  currentVersion = process.version,
  requiredRange,
} = {}) {
  // 1. Dependency check FIRST — before any filesystem mutation.
  const dependency = checkNodeDependency({
    currentVersion,
    sourceDir,
    requiredRange,
  });

  // 2. On failure: stop cleanly. No hook install, no partial patchwork/ tree.
  if (!dependency.ok) {
    return {
      ok: false,
      changed: false,
      dependency,
      hooks: [],
      workspace: null,
      message: dependency.message,
    };
  }

  // 3. On success: install the hook and scaffold the workspace (idempotent).
  const hooks = installGuardrailHook({ targetDir, sourceDir });
  const workspace = scaffoldWorkspace({ targetDir });

  const changed =
    hooks.some((h) => h.action === 'installed') ||
    workspace.board.action === 'created' ||
    workspace.incidents.action === 'created';

  return {
    ok: true,
    changed,
    dependency,
    hooks,
    workspace,
    message: changed
      ? 'Patchwork onboarding complete: guardrail hook installed and workspace scaffolded.'
      : 'Patchwork onboarding: already set up; existing hook and workspace preserved.',
  };
}

/**
 * Parse the CLI flags onboarding accepts: `--target <dir>` and (rarely)
 * `--source <dir>`. Both `--flag <value>` and `--flag=<value>` forms work.
 *
 * @param {string[]} args argv after the script name.
 * @returns {{ targetDir?: string, sourceDir?: string }}
 */
function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--target') {
      options.targetDir = args[i + 1];
      i++;
    } else if (arg.startsWith('--target=')) {
      options.targetDir = arg.slice('--target='.length);
    } else if (arg === '--source') {
      options.sourceDir = args[i + 1];
      i++;
    } else if (arg.startsWith('--source=')) {
      options.sourceDir = arg.slice('--source='.length);
    }
  }
  return options;
}

/**
 * Thin runnable entry point: run onboarding, print a human-readable message
 * plus a machine-readable JSON line, and return the process exit code (0 on
 * success, 1 when the dependency check stopped onboarding).
 *
 * @param {string[]} argv full process argv.
 * @returns {number} process exit code.
 */
export function main(argv = process.argv) {
  const options = parseArgs(argv.slice(2));
  const result = onboard(options);

  console.log(result.message);
  console.log(
    JSON.stringify({
      command: 'onboard',
      ok: result.ok,
      changed: result.changed,
      dependency: result.dependency,
      hooks: result.hooks,
      workspace: result.workspace,
    }),
  );

  return result.ok ? 0 : 1;
}

// Run only when executed directly, not when imported by tests (mirrors
// cli.js / mcp.js). This keeps the module importable without side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv));
}
