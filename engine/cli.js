#!/usr/bin/env node
// Patchwork CLI - entry point for the deterministic Protocol Engine commands.
//
// The CLI is a thin adapter (design "Components > 2 Patchwork_CLI"): it parses
// argv, reads the workspace from disk into an in-memory snapshot, calls the pure
// core, prints a human-readable summary plus a machine-readable JSON line, and
// maps the result to a process exit code. The core owns the decision logic; the
// CLI owns the side effects (disk + printing + exit code). Keeping disk access
// here preserves the core's determinism (Requirement 10.6).
//
// Subcommands are dispatched from argv[2]. `validate` (task 1.4), `gate`
// (task 2.2), and `verdict` (task 3.1) are implemented here. An unknown or
// absent command prints usage and exits non-zero.
//
// _Requirements: 1.5, 3.5, 5.2, 5.3, 10.1, 10.2, 10.3, 10.4_

import { pathToFileURL } from 'node:url';

import { validate } from './core/validate.js';
import { gate } from './core/gate.js';
import { verdict } from './core/verdict.js';
import { parseIncident, isSchemaError } from './core/schema.js';
import { readWorkspace, DEFAULT_WORKSPACE } from './read-workspace.js';

// The workspace directory defaults to `patchwork/` (design CLI signature:
// `patchwork validate [--workspace <dir>]`); DEFAULT_WORKSPACE is now shared
// with the MCP server via ./read-workspace.js so both surfaces agree.

// Exit codes: 0 = ok, 1 = protocol problems found, 2 = CLI usage error.
const EXIT_OK = 0;
const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;

function usage() {
  return [
    'Usage: patchwork <command> [options]',
    '',
    'Commands:',
    '  validate [--workspace <dir>]',
    '      Validate a Patchwork workspace against the schema',
    '      (default workspace: patchwork).',
    '',
    '  gate --incident <id> --to <state> [--workspace <dir>]',
    '      Check whether an incident may transition to <state>. The current',
    "      status (the transition's `from`) is read from the incident's",
    '      incident.md frontmatter (default workspace: patchwork).',
    '',
    '  verdict --incident <id> [--workspace <dir>]',
    "      Parse the incident's review.md and print PASS or NEEDS_WORK",
    '      (fail-closed: a missing/malformed/ambiguous review reads as',
    '      NEEDS_WORK) (default workspace: patchwork).',
    '',
    'Exit codes:',
    '  0  ok / transition allowed / verdict PASS',
    '  1  protocol problems found / transition rejected / verdict NEEDS_WORK',
    '  2  CLI usage error',
  ].join('\n');
}

/**
 * Parse the options accepted by the `validate` command.
 *
 * Supports both `--workspace <dir>` and `--workspace=<dir>`. When the flag is
 * omitted the caller falls back to DEFAULT_WORKSPACE.
 *
 * @param {string[]} args argv after the command name.
 * @returns {{ workspace: string|null }}
 */
function parseValidateArgs(args) {
  const options = { workspace: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace') {
      options.workspace = args[i + 1];
      i++;
    } else if (arg.startsWith('--workspace=')) {
      options.workspace = arg.slice('--workspace='.length);
    }
  }
  return options;
}

/**
 * Run the `validate` command: read the workspace, call the core, print a
 * human-readable summary and a machine-readable JSON line, and return the exit
 * code (0 when valid, 1 when the problem list is non-empty).
 *
 * @param {string[]} args argv after the command name.
 * @returns {number} process exit code.
 */
function runValidate(args) {
  const options = parseValidateArgs(args);
  const workspaceDir = options.workspace || DEFAULT_WORKSPACE;

  const snapshot = readWorkspace(workspaceDir);
  const result = validate(snapshot);

  // Human-readable summary.
  if (result.ok) {
    console.log(`validate: OK - workspace "${workspaceDir}" has no problems`);
  } else {
    const count = result.problems.length;
    console.log(
      `validate: FAIL - ${count} problem${count === 1 ? '' : 's'} in workspace "${workspaceDir}":`,
    );
    for (const p of result.problems) {
      console.log(`  - ${p.path}: ${p.message} [${p.rule}]`);
    }
  }

  // Machine-readable JSON line (last line, easy for a hook to parse).
  console.log(
    JSON.stringify({
      command: 'validate',
      workspace: workspaceDir,
      ok: result.ok,
      problems: result.problems,
    }),
  );

  return result.ok ? EXIT_OK : EXIT_PROBLEMS;
}

/**
 * Parse the options accepted by the `gate` command.
 *
 * Supports both `--flag <value>` and `--flag=<value>` for `--incident`, `--to`,
 * and `--workspace`. When a flag is omitted its value is null; the caller
 * treats missing `--incident`/`--to` as a usage error and falls back to
 * DEFAULT_WORKSPACE for an omitted `--workspace`.
 *
 * @param {string[]} args argv after the command name.
 * @returns {{ incident: string|null, to: string|null, workspace: string|null }}
 */
function parseGateArgs(args) {
  const options = { incident: null, to: null, workspace: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--incident') {
      options.incident = args[i + 1];
      i++;
    } else if (arg.startsWith('--incident=')) {
      options.incident = arg.slice('--incident='.length);
    } else if (arg === '--to') {
      options.to = args[i + 1];
      i++;
    } else if (arg.startsWith('--to=')) {
      options.to = arg.slice('--to='.length);
    } else if (arg === '--workspace') {
      options.workspace = args[i + 1];
      i++;
    } else if (arg.startsWith('--workspace=')) {
      options.workspace = arg.slice('--workspace='.length);
    }
  }
  return options;
}

/**
 * Run the `gate` command: resolve the incident's current status from disk, ask
 * the core whether the requested transition is permitted, print a
 * human-readable summary plus a machine-readable JSON line, and return the exit
 * code (0 allowed, non-zero rejected).
 *
 * The CLI's only job is to resolve the transition's `from` (the incident's
 * current status, read from its incident.md frontmatter) and pass it with the
 * requested `to` to the core `gate`. All transition-legality logic — and, from
 * task 3.2, the RESOLVED guard — lives in the core, not here. When the incident
 * cannot be found or its status cannot be parsed, the request is unverifiable
 * and is rejected fail-closed (non-zero), consistent with the engine's
 * "the checker could not run defaults to block" stance.
 *
 * @param {string[]} args argv after the command name.
 * @returns {number} process exit code.
 */
function runGate(args) {
  const options = parseGateArgs(args);

  // Both --incident and --to are required. A missing flag is a CLI usage error
  // (exit 2), matching the dispatch's treatment of an unknown command.
  if (!options.incident || !options.to) {
    console.error(
      'gate: missing required flag(s); both --incident <id> and --to <state> are required.',
    );
    console.error('');
    console.error(usage());
    return EXIT_USAGE;
  }

  const workspaceDir = options.workspace || DEFAULT_WORKSPACE;
  const incidentId = options.incident;
  const to = options.to;

  const snapshot = readWorkspace(workspaceDir);

  // Resolve the transition's `from` = the incident's current status, read from
  // its incident.md frontmatter. `from` stays null until we successfully parse
  // it so the JSON line always reports what we resolved.
  let from = null;
  let result;

  const incidentFiles =
    snapshot.incidents && snapshot.incidents[incidentId]
      ? snapshot.incidents[incidentId]
      : null;

  if (incidentFiles === null) {
    result = {
      allowed: false,
      reason: `incident "${incidentId}" not found in workspace "${workspaceDir}"`,
    };
  } else if (typeof incidentFiles['incident.md'] !== 'string') {
    result = {
      allowed: false,
      reason: `incident "${incidentId}" is missing incident.md`,
    };
  } else {
    const parsed = parseIncident(incidentFiles['incident.md']);
    if (isSchemaError(parsed)) {
      result = {
        allowed: false,
        reason: `incident "${incidentId}" has invalid frontmatter: ${parsed.message}`,
      };
    } else {
      from = parsed.status;
      // Core call — transition legality (plus the RESOLVED guard from task 3.2).
      result = gate(snapshot, { incidentId, from, to });
    }
  }

  // Human-readable summary. Uses ASCII "->" for portable console output.
  const edge = `${from ?? '?'} -> ${to}`;
  if (result.allowed) {
    console.log(`gate: ALLOWED - ${incidentId}: ${edge} (${result.reason})`);
  } else {
    console.log(`gate: REJECTED - ${incidentId}: ${edge} (${result.reason})`);
  }

  // Machine-readable JSON line (last line, easy for a hook to parse).
  console.log(
    JSON.stringify({
      command: 'gate',
      workspace: workspaceDir,
      incident: incidentId,
      from,
      to,
      allowed: result.allowed,
      reason: result.reason,
    }),
  );

  return result.allowed ? EXIT_OK : EXIT_PROBLEMS;
}

/**
 * Parse the options accepted by the `verdict` command.
 *
 * Supports both `--flag <value>` and `--flag=<value>` for `--incident` and
 * `--workspace`. When a flag is omitted its value is null; the caller treats a
 * missing `--incident` as a usage error and falls back to DEFAULT_WORKSPACE for
 * an omitted `--workspace`.
 *
 * @param {string[]} args argv after the command name.
 * @returns {{ incident: string|null, workspace: string|null }}
 */
function parseVerdictArgs(args) {
  const options = { incident: null, workspace: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--incident') {
      options.incident = args[i + 1];
      i++;
    } else if (arg.startsWith('--incident=')) {
      options.incident = arg.slice('--incident='.length);
    } else if (arg === '--workspace') {
      options.workspace = args[i + 1];
      i++;
    } else if (arg.startsWith('--workspace=')) {
      options.workspace = arg.slice('--workspace='.length);
    }
  }
  return options;
}

/**
 * Run the `verdict` command: read the incident's review.md from disk, parse it
 * with the fail-closed core `verdict`, print a human-readable summary plus a
 * machine-readable JSON line, and return the exit code.
 *
 * Exit-code choice (documented): 0 on PASS, non-zero (1) on NEEDS_WORK. This
 * makes the command directly useful in a pipeline and consistent with `gate`
 * (0 = go, 1 = stop). Because parsing is fail-closed, a missing incident, a
 * missing/empty review.md, or any malformed/ambiguous verdict reads as
 * NEEDS_WORK and therefore exits non-zero — "no usable review" can never exit
 * 0. The load-bearing guardrail that actually blocks RESOLVED/ship is `gate`
 * (task 3.2), not this command; `verdict`'s key job is printing PASS/NEEDS_WORK.
 *
 * @param {string[]} args argv after the command name.
 * @returns {number} process exit code.
 */
function runVerdict(args) {
  const options = parseVerdictArgs(args);

  // --incident is required. A missing flag is a CLI usage error (exit 2),
  // matching the dispatch's treatment of an unknown command.
  if (!options.incident) {
    console.error('verdict: missing required flag --incident <id>.');
    console.error('');
    console.error(usage());
    return EXIT_USAGE;
  }

  const workspaceDir = options.workspace || DEFAULT_WORKSPACE;
  const incidentId = options.incident;

  const snapshot = readWorkspace(workspaceDir);

  // A missing incident or a missing review.md leaves reviewText undefined,
  // which parseVerdict maps to NEEDS_WORK (fail-closed).
  const incidentFiles =
    snapshot.incidents && snapshot.incidents[incidentId]
      ? snapshot.incidents[incidentId]
      : null;
  const reviewText =
    incidentFiles && typeof incidentFiles['review.md'] === 'string'
      ? incidentFiles['review.md']
      : undefined;

  const result = verdict(reviewText);

  // Human-readable summary.
  console.log(`verdict: ${result.verdict} - ${incidentId}`);

  // Machine-readable JSON line (last line, easy for a hook to parse).
  console.log(
    JSON.stringify({
      command: 'verdict',
      workspace: workspaceDir,
      incident: incidentId,
      verdict: result.verdict,
      author: result.author,
      fixVersion: result.fixVersion,
    }),
  );

  return result.verdict === 'PASS' ? EXIT_OK : EXIT_PROBLEMS;
}

/**
 * Dispatch a Patchwork CLI invocation.
 *
 * @param {string[]} argv full process argv (including node + script path).
 * @returns {number} process exit code.
 */
export function main(argv) {
  const command = argv[2];
  const rest = argv.slice(3);

  switch (command) {
    case 'validate':
      return runValidate(rest);
    case 'gate':
      return runGate(rest);
    case 'verdict':
      return runVerdict(rest);
    default:
      console.error(usage());
      return EXIT_USAGE;
  }
}

// Run only when executed directly as the `patchwork` bin, not when imported by
// tests (task 1.5). This keeps the module importable without side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv));
}
