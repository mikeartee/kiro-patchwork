// The validate() core command for the Patchwork Protocol Engine (task 1.3).
//
// validate() is a pure, deterministic function over an explicit in-memory
// workspace snapshot: no disk access, no wall-clock, and no randomness, so
// identical snapshots always yield identical results (Requirement 10.6). The
// CLI (task 1.4) is responsible for reading files from disk into a snapshot;
// this core module only inspects the snapshot and reports problems.
//
// It delegates the actual grammar checks to the shared schema parsers so the
// rules live in exactly one place: parseIncident for frontmatter, parseBoardEntry
// for timeline lines, and parseRemediationStep for fix-proposal remediation steps.
//
// Checks performed (design "Components › 1 validate" and "Error Handling ›
// Malformed or missing workspace files"):
//   - the workspace scaffold is present (board file + incidents structure)
//   - every incident.md has valid frontmatter with a known status
//   - every board timeline entry is well-formed
//   - every remediation step carries a tag and a verify: clause
//   - a resolution-stage (RESOLVED) incident holds the full artifact set
//
// _Requirements: 1.5, 2.4, 9.4, 10.1, 10.6_

import {
  parseIncident,
  parseBoardEntry,
  parseRemediationStep,
  isSchemaError,
} from './schema.js';

/**
 * @typedef {Object} WorkspaceSnapshot
 * An explicit, in-memory picture of the `patchwork/` workspace. The core never
 * touches disk, the wall-clock, or randomness; loading files into this shape is
 * the CLI's job (task 1.4). Identical snapshots therefore always produce
 * identical validate() results (Requirement 10.6).
 *
 * @property {string|null|undefined} [board]
 *   Contents of `patchwork/board.md`. `null`/`undefined` means the file is
 *   absent (a scaffold problem); an empty string means the file exists but
 *   holds no entries (valid — nothing to check).
 * @property {Object<string, IncidentFiles>|null|undefined} [incidents]
 *   Map of incident id (the `INC-<id>` directory name) to that incident's
 *   artifact files. `null`/`undefined` means the `incidents/` directory is
 *   absent (a scaffold problem); an empty object means the directory exists
 *   with no incidents yet (valid).
 */

/**
 * @typedef {Object<string, string>} IncidentFiles
 * Map of artifact filename (e.g. `"incident.md"`) to that file's contents. A
 * key is present only when the corresponding file exists in the snapshot; a
 * missing key means the artifact file does not exist.
 */

/**
 * @typedef {Object} Problem
 * A single validation failure, naming the offending path and the broken rule.
 * @property {string} path    Workspace-relative path of the offending file/dir.
 * @property {string} rule    Stable, machine-readable id of the broken rule.
 * @property {string} message Human-readable description of the problem.
 */

/**
 * The artifact set a resolution-stage (RESOLVED) Incident_Directory must hold
 * (Requirement 1.4; design "Data Models › Workspace layout").
 */
export const RESOLUTION_ARTIFACTS = Object.freeze([
  'incident.md',
  'analysis.md',
  'fix-proposal.md',
  'review.md',
  'decision-log.md',
  'postmortem.md',
]);

const WORKSPACE_ROOT = 'patchwork';
const BOARD_PATH = `${WORKSPACE_ROOT}/board.md`;
const INCIDENTS_PATH = `${WORKSPACE_ROOT}/incidents`;

// A board timeline entry is a line whose first non-whitespace character is "[".
// Header and prose lines in board.md ("# Patchwork Board", "Entry format: ...")
// do not start with "[", so they are skipped. This is why a prose line that
// merely mentions "[time]" mid-sentence is not treated as an entry.
function isBoardTimelineLine(line) {
  return line.trimStart().startsWith('[');
}

// A remediation-step candidate is a Markdown list item ("- " or "* ") that
// looks like a remediation step: it carries an [AFK]/[HITL] tag OR a "verify:"
// clause. Requiring the list marker keeps ordinary prose out (a paragraph that
// merely mentions "[AFK]" or "verify:" is not a list item). Accepting either
// signal lets validate still flag a step that is missing its tag OR its verify
// clause (Requirement 9.4), because parseRemediationStep reports the gap.
const LIST_ITEM_RE = /^\s*[-*]\s+/;
const REMEDIATION_TAG_RE = /\[(?:AFK|HITL)\]/;
const REMEDIATION_VERIFY_RE = /verify:/i;

function looksLikeRemediationStep(line) {
  if (!LIST_ITEM_RE.test(line)) return false;
  return REMEDIATION_TAG_RE.test(line) || REMEDIATION_VERIFY_RE.test(line);
}

function problem(path, rule, message) {
  return { path, rule, message };
}

/**
 * Validate a workspace snapshot against the Patchwork schema.
 *
 * @param {WorkspaceSnapshot} workspace
 * @returns {{ ok: boolean, problems: Problem[] }}
 *   `ok` is true only when `problems` is empty. Each Problem names the offending
 *   path and the rule broken. The problem list is emitted in a deterministic
 *   order (scaffold, then board entries, then incidents by sorted id) so that
 *   identical snapshots yield identical output and reordering independent
 *   incidents does not change the result (Requirement 10.6).
 */
export function validate(workspace) {
  const ws = workspace && typeof workspace === 'object' ? workspace : {};
  const problems = [];

  // 1. Workspace scaffold present (Requirements 1.1, 1.5, 10.1).
  if (ws.board == null) {
    problems.push(
      problem(
        BOARD_PATH,
        'workspace.board.missing',
        'Workspace is missing the board file',
      ),
    );
  }

  const incidents =
    ws.incidents && typeof ws.incidents === 'object' ? ws.incidents : null;
  if (incidents === null) {
    problems.push(
      problem(
        INCIDENTS_PATH,
        'workspace.incidents.missing',
        'Workspace is missing the incidents directory',
      ),
    );
  }

  // 2. Board timeline entries are well-formed (Requirements 2.2, 2.4).
  if (typeof ws.board === 'string') {
    for (const line of ws.board.split(/\r?\n/)) {
      if (!isBoardTimelineLine(line)) continue;
      const parsed = parseBoardEntry(line);
      if (isSchemaError(parsed)) {
        problems.push(problem(BOARD_PATH, parsed.rule, parsed.message));
      }
    }
  }

  // 3. Per-incident checks. Incident ids are sorted so the problem order is
  //    independent of the snapshot's insertion order (determinism, Req 10.6).
  if (incidents !== null) {
    for (const id of Object.keys(incidents).sort()) {
      validateIncident(id, incidents[id], problems);
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Validate a single incident's artifact files, pushing any Problems found.
 *
 * @param {string} id            The incident id (INC-<id> directory name).
 * @param {IncidentFiles} files  The incident's artifact file map.
 * @param {Problem[]} problems   Accumulator, mutated in place.
 */
function validateIncident(id, files, problems) {
  const dir = `${INCIDENTS_PATH}/${id}`;
  const fileMap = files && typeof files === 'object' ? files : {};

  // 3a. incident.md must be present with valid frontmatter (Req 1.2, 1.3, 1.5).
  //     An unparseable frontmatter is reported as a schema problem against the
  //     file rather than crashing the run.
  const incidentText = fileMap['incident.md'];
  let status;
  if (typeof incidentText !== 'string') {
    problems.push(
      problem(
        `${dir}/incident.md`,
        'workspace.artifact.missing',
        'Incident directory is missing incident.md',
      ),
    );
  } else {
    const parsed = parseIncident(incidentText);
    if (isSchemaError(parsed)) {
      problems.push(problem(`${dir}/incident.md`, parsed.rule, parsed.message));
    } else {
      status = parsed.status;
    }
  }

  // 3b. Remediation steps carry a tag + verify: clause (Req 9.1, 9.2, 9.4).
  const fixProposal = fileMap['fix-proposal.md'];
  if (typeof fixProposal === 'string') {
    for (const line of fixProposal.split(/\r?\n/)) {
      if (!looksLikeRemediationStep(line)) continue;
      const parsed = parseRemediationStep(line);
      if (isSchemaError(parsed)) {
        problems.push(
          problem(`${dir}/fix-proposal.md`, parsed.rule, parsed.message),
        );
      }
    }
  }

  // 3c. A resolution-stage incident holds the full artifact set (Req 1.4).
  if (status === 'RESOLVED') {
    for (const artifact of RESOLUTION_ARTIFACTS) {
      if (typeof fileMap[artifact] !== 'string') {
        problems.push(
          problem(
            `${dir}/${artifact}`,
            'workspace.artifact.missing',
            `Resolution-stage incident is missing required artifact ${artifact}`,
          ),
        );
      }
    }
  }
}
