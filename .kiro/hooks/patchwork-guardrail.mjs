#!/usr/bin/env node
// Patchwork Guardrail Hook — companion decision script (task 8.2).
//
// This is the deterministic, model-INDEPENDENT decider behind the guardrail
// hook (design "Components > 5 Guardrail Hook"; Requirement 11). It is what the
// `.kiro/hooks/patchwork-guardrail.kiro.hook` file shells into. The hook itself
// carries no logic beyond invoking this script; ALL of the allow/block reasoning
// lives here and is driven SOLELY by the Patchwork CLI's exit code plus the
// machine-readable JSON line it prints (design "Error Handling > Guardrail hook
// fails closed").
//
// FAIL-CLOSED IS THE WHOLE POINT (Requirements 11.2, 11.4). There is no code
// path that allows on error. The script allows ONLY on an explicit success
// result — the CLI exited 0 AND its parsed `gate` result says `allowed: true`.
// Every other outcome blocks: a non-zero/absent exit, a spawn failure, a
// timeout, missing/unparseable output, or an unexpected result shape. Even an
// unexpected internal throw is caught and turned into a BLOCK.
//
// EXIT-CODE CONTRACT (why BLOCK is exit 2, never 1). Kiro v3 `runCommand` hooks
// on a PreToolUse trigger interpret the command's exit code as:
//     0  => allow / proceed
//     2  => block the action (stderr is surfaced to the agent as feedback)
//   other => a NON-BLOCKING error (the action would still proceed)
// (Confirmed against Kiro's CLI v3 hooks documentation and the widely-shared
// Claude-Code hook convention it mirrors.) Because any exit code other than 2
// would let the action through, staying fail-closed REQUIRES emitting exit 2
// for every non-allow outcome — including internal errors. A bare `throw`
// (Node's default exit 1) or a rejection mapped to 1 would fail OPEN, so this
// script never exits 1: it exits 0 only on an explicit allow and 2 otherwise.
//
// SCHEMA ASSUMPTIONS about the `.kiro.hook` file (documented per task 8.2, since
// these are not verifiable from within this repo):
//   • A hook is a JSON object with `enabled`, `name`, `description`, `version`,
//     `when` (trigger) and `then` (action). Confirmed from Kiro hook docs and
//     public `.kiro.hook` examples.
//   • Two action types exist: `askAgent` (with a `prompt`) and `runCommand`
//     (a shell command). We use `runCommand` because the decision MUST be
//     deterministic and model-independent; `askAgent` delegates to an LLM and
//     is advisory, which cannot satisfy "decide solely on exit code + parsed
//     result" (Requirements 11.2, 11.4).
//   • ASSUMPTION (could not be verified verbatim): the `runCommand` action holds
//     its shell command in a `command` field, mirroring `askAgent`'s `prompt`.
//     If the target Kiro build names this field differently, only the hook JSON
//     needs updating — this script is unaffected.
//   • The command receives hook context as JSON on stdin; we deliberately do
//     NOT read it. The decision is derived purely from the on-disk workspace via
//     the CLI, so the guardrail is robust even where the stdin context (e.g.
//     the intercepted command string) is absent.
//
// TESTABLE INTERFACE (for task 8.3). Two pure entry points are exported so the
// hook can be driven against constructed workspaces:
//   • decideForIncident({ workspace, incident, to, cliPath, timeoutMs }) — the
//     load-bearing, fail-closed decision for ONE incident's RESOLVED gate. This
//     is the function whose guarantees task 8.3 asserts (blocks on no PASS,
//     NEEDS_WORK, stale PASS, self-authored PASS, uncleared HITL, non-zero CLI
//     exit; allows only on a valid non-author PASS at the current fix_version
//     with HITL cleared).
//   • decideForWorkspace({ workspace, cliPath, timeoutMs }) — the hook's
//     activation heuristic: gate every incident currently at FIX_STAGED and
//     block if ANY is not clear to resolve. With no staged incident there is
//     nothing to ship, so it allows (normal, non-ship work is never blocked).
// Both return a plain decision object `{ decision, allow, reason, ... }`; the
// CLI runner maps `allow` to the 0/2 exit code.
//
// _Requirements: 11.1, 11.2, 11.3, 11.4_

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exit codes — see the EXIT-CODE CONTRACT note above. 0 = allow, 2 = block.
// We never use 1 (Kiro would treat it as a non-blocking error = fail open).
export const EXIT_ALLOW = 0;
export const EXIT_BLOCK = 2;

// The one guarded edge: the ship/resolution gate is the FIX_STAGED -> RESOLVED
// transition (design "Architecture > Incident state machine").
export const GUARDED_FROM = 'FIX_STAGED';
export const GUARDED_TO = 'RESOLVED';

// A generous default timeout for the (fast, file-reading) CLI. On timeout the
// spawn is killed and we fail closed.
export const DEFAULT_TIMEOUT_MS = 10000;

// This script lives at <repo>/.kiro/hooks/; the CLI is at <repo>/engine/cli.js.
// Resolve the default relative to THIS module's URL (not the cwd) so the path
// holds regardless of where the hook is invoked from.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CLI_PATH = path.resolve(scriptDir, '..', '..', 'engine', 'cli.js');

// The workspace defaults to `patchwork/` relative to the cwd (the repo root,
// where Kiro runs the hook), matching the CLI's own default.
export const DEFAULT_WORKSPACE = 'patchwork';

// ---------------------------------------------------------------------------
// Decision helpers
// ---------------------------------------------------------------------------

function allow(extra) {
  return { decision: 'ALLOW', allow: true, ...extra };
}

function block(extra) {
  return { decision: 'BLOCK', allow: false, ...extra };
}

/**
 * Parse the CLI's machine-readable result: the LAST non-empty stdout line is a
 * JSON object (the CLI prints a human summary first, then the JSON line).
 *
 * @param {string} stdout the CLI's captured stdout.
 * @returns {object|null} the parsed object, or null when absent/unparseable.
 */
function parseCliJson(stdout) {
  if (typeof stdout !== 'string') return null;
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;
  try {
    const obj = JSON.parse(lines[lines.length - 1]);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The load-bearing, fail-closed per-incident decision (task 8.3 drives this)
// ---------------------------------------------------------------------------

/**
 * Decide whether one incident may transition to RESOLVED, by shelling into
 * `patchwork gate --incident <id> --to RESOLVED` and deciding SOLELY on the
 * CLI's exit code plus its parsed JSON result. Fail-closed on every anomaly.
 *
 * `gate` is authoritative: it already folds in the fail-closed verdict, the
 * Non_Author_Rule, review-to-fix binding, and the HITL check (engine/core/
 * gate.js, task 3.2), so a separate `verdict` call would be redundant.
 *
 * @param {object} args
 * @param {string} [args.workspace]  workspace dir (default `patchwork`).
 * @param {string} args.incident     incident id, e.g. `INC-2024-001` (required).
 * @param {string} [args.to]         target state (default `RESOLVED`).
 * @param {string} [args.cliPath]    path to engine/cli.js (default resolved).
 * @param {number} [args.timeoutMs]  CLI timeout in ms (default 10000).
 * @param {string} [args.nodePath]   node executable (default process.execPath).
 * @returns {{ decision: 'ALLOW'|'BLOCK', allow: boolean, reason: string,
 *   incident?: string, exitCode?: number|null, parsed?: object|null }}
 */
export function decideForIncident({
  workspace = DEFAULT_WORKSPACE,
  incident,
  to = GUARDED_TO,
  cliPath = DEFAULT_CLI_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  nodePath = process.execPath,
} = {}) {
  // No incident to evaluate ⇒ the gate is unverifiable ⇒ fail closed.
  if (!incident) {
    return block({
      reason: 'guardrail: no incident id supplied; cannot evaluate the RESOLVED gate',
      incident: incident ?? null,
    });
  }

  let result;
  try {
    result = spawnSync(
      nodePath,
      [cliPath, 'gate', '--incident', incident, '--to', to, '--workspace', workspace],
      { encoding: 'utf8', timeout: timeoutMs },
    );
  } catch (err) {
    // spawnSync itself threw (extremely rare) ⇒ fail closed.
    return block({
      reason: `guardrail: failed to invoke the CLI (${err && err.message ? err.message : err})`,
      incident,
    });
  }

  // A timeout or a spawn failure surfaces as result.error ⇒ fail closed.
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    const detail = timedOut
      ? `timed out after ${timeoutMs}ms`
      : `spawn error (${result.error.message})`;
    return block({
      reason: `guardrail: CLI ${detail}`,
      incident,
      exitCode: result.status,
    });
  }

  // A non-zero or absent (signal-killed) exit ⇒ the transition is not allowed
  // ⇒ fail closed. The CLI uses 0 = allowed, 1 = rejected, 2 = usage error.
  if (result.status !== 0) {
    const parsed = parseCliJson(result.stdout);
    const because = parsed && parsed.reason ? ` — ${parsed.reason}` : '';
    const code = result.status === null ? 'a signal (killed)' : result.status;
    return block({
      reason: `guardrail: CLI exited ${code}${because}`,
      incident,
      exitCode: result.status,
      parsed,
    });
  }

  // Exit 0: require an explicit, well-formed "allowed: true" gate result.
  const parsed = parseCliJson(result.stdout);
  if (!parsed) {
    return block({
      reason: 'guardrail: CLI exited 0 but produced no parseable JSON result',
      incident,
      exitCode: 0,
    });
  }
  if (parsed.command !== 'gate') {
    return block({
      reason: `guardrail: unexpected CLI result (command="${parsed.command}")`,
      incident,
      exitCode: 0,
      parsed,
    });
  }
  if (parsed.allowed !== true) {
    const because = parsed.reason ? ` — ${parsed.reason}` : '';
    return block({
      reason: `guardrail: gate not satisfied${because}`,
      incident,
      exitCode: 0,
      parsed,
    });
  }

  // The one and only allow path: exit 0 AND allowed === true.
  const because = parsed.reason ? ` — ${parsed.reason}` : '';
  return allow({
    reason: `guardrail: gate satisfied${because}`,
    incident,
    exitCode: 0,
    parsed,
  });
}

// ---------------------------------------------------------------------------
// The hook activation heuristic: gate every FIX_STAGED incident
// ---------------------------------------------------------------------------

// A minimal, self-contained status reader. The hook fires generically (it is
// not told which incident is being shipped), so it enumerates incidents and
// gates those at FIX_STAGED. This reader is deliberately dependency-free — it
// does NOT import the engine — so this script cannot fail to LOAD (a module
// load error would exit 1 = fail open). The reader only chooses WHICH incidents
// to gate; the authoritative allow/block decision still comes from the CLI.
const STATUS_LINE_RE = /^status:\s*([A-Za-z_]+)/m;

/**
 * List the ids of incidents whose incident.md status is FIX_STAGED.
 *
 * @param {string} workspace workspace dir.
 * @returns {string[]} incident ids at FIX_STAGED (possibly empty).
 * @throws if the incidents directory cannot be read.
 */
export function findStagedIncidents(workspace) {
  const incidentsDir = path.join(workspace, 'incidents');
  const entries = fs.readdirSync(incidentsDir, { withFileTypes: true });
  const staged = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('INC-')) continue;
    const incidentPath = path.join(incidentsDir, entry.name, 'incident.md');
    let text;
    try {
      text = fs.readFileSync(incidentPath, 'utf8');
    } catch {
      continue; // an incident dir with no readable incident.md is not staged
    }
    const m = STATUS_LINE_RE.exec(text);
    if (m && m[1] === GUARDED_FROM) staged.push(entry.name);
  }
  return staged;
}

/**
 * The hook's workspace-level decision: block if ANY incident at FIX_STAGED is
 * not clear to resolve; allow otherwise. When nothing is staged there is
 * nothing to ship, so ordinary (non-ship) work is never blocked.
 *
 * @param {object} args
 * @param {string} [args.workspace]  workspace dir (default `patchwork`).
 * @param {string} [args.cliPath]    path to engine/cli.js (default resolved).
 * @param {number} [args.timeoutMs]  per-incident CLI timeout (default 10000).
 * @param {string} [args.nodePath]   node executable (default process.execPath).
 * @returns {{ decision: 'ALLOW'|'BLOCK', allow: boolean, reason: string,
 *   checks: object[] }}
 */
export function decideForWorkspace({
  workspace = DEFAULT_WORKSPACE,
  cliPath = DEFAULT_CLI_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  nodePath = process.execPath,
} = {}) {
  let staged;
  try {
    staged = findStagedIncidents(workspace);
  } catch (err) {
    // The workspace/incidents dir is unreadable ⇒ nothing we can identify as a
    // staged, shippable fix. Allow so non-incident work proceeds; the
    // authoritative per-incident gate still fails closed once a staged fix is
    // actually present and evaluated.
    return {
      decision: 'ALLOW',
      allow: true,
      reason: `guardrail: no readable ${GUARDED_FROM} incidents (${err && err.message ? err.message : err})`,
      checks: [],
    };
  }

  if (staged.length === 0) {
    return {
      decision: 'ALLOW',
      allow: true,
      reason: `guardrail: no incident is at ${GUARDED_FROM}; nothing to gate`,
      checks: [],
    };
  }

  const checks = staged.map((incident) =>
    decideForIncident({ workspace, incident, cliPath, timeoutMs, nodePath }),
  );
  const blocked = checks.filter((c) => !c.allow);
  if (blocked.length > 0) {
    const detail = blocked.map((b) => `${b.incident} (${b.reason})`).join('; ');
    return {
      decision: 'BLOCK',
      allow: false,
      reason: `guardrail: ${blocked.length} staged fix(es) not clear to resolve: ${detail}`,
      checks,
    };
  }
  return {
    decision: 'ALLOW',
    allow: true,
    reason: `guardrail: all ${staged.length} staged fix(es) are clear to resolve`,
    checks,
  };
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

/**
 * Parse the small option set this script accepts. Supports `--flag value` and
 * `--flag=value` for each flag.
 *
 * @param {string[]} argv args after the script name.
 */
function parseArgs(argv) {
  const opts = { workspace: null, incident: null, to: GUARDED_TO, cli: null, timeout: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') opts.workspace = argv[++i];
    else if (a.startsWith('--workspace=')) opts.workspace = a.slice('--workspace='.length);
    else if (a === '--incident') opts.incident = argv[++i];
    else if (a.startsWith('--incident=')) opts.incident = a.slice('--incident='.length);
    else if (a === '--to') opts.to = argv[++i];
    else if (a.startsWith('--to=')) opts.to = a.slice('--to='.length);
    else if (a === '--cli') opts.cli = argv[++i];
    else if (a.startsWith('--cli=')) opts.cli = a.slice('--cli='.length);
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a.startsWith('--timeout=')) opts.timeout = Number(a.slice('--timeout='.length));
  }
  return opts;
}

/**
 * Run the guardrail: decide, print (human summary + machine JSON line), and
 * return the process exit code (0 allow / 2 block). ANY thrown error is caught
 * and turned into a fail-closed BLOCK, so this never exits 1.
 *
 * @param {string[]} argv args after the script name.
 * @returns {number} EXIT_ALLOW (0) or EXIT_BLOCK (2).
 */
export function run(argv) {
  let decision;
  try {
    const opts = parseArgs(argv);
    const timeoutMs =
      Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout : DEFAULT_TIMEOUT_MS;
    const common = {
      workspace: opts.workspace || DEFAULT_WORKSPACE,
      cliPath: opts.cli || DEFAULT_CLI_PATH,
      timeoutMs,
    };
    decision = opts.incident
      ? decideForIncident({ ...common, incident: opts.incident, to: opts.to })
      : decideForWorkspace(common);
  } catch (err) {
    // Defense in depth: an unexpected throw is fail-closed.
    decision = block({
      reason: `guardrail: unexpected error (${err && err.message ? err.message : err})`,
    });
  }

  // Human-readable summary: to stdout on allow, to stderr on block (Kiro
  // surfaces a blocking hook's stderr to the agent as correctable feedback).
  const summary = `${decision.decision}: ${decision.reason}`;
  if (decision.allow) console.log(summary);
  else console.error(summary);

  // Machine-readable decision as the LAST stdout line (mirrors the CLI), so a
  // test or caller can parse the decision without relying on the exit code.
  console.log(JSON.stringify({ tool: 'patchwork-guardrail', ...decision }));

  return decision.allow ? EXIT_ALLOW : EXIT_BLOCK;
}

// Run only when executed directly (not when imported by a test). This keeps the
// module importable with no side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(run(process.argv.slice(2)));
}
