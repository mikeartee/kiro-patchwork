// Shared incident-resolution helpers for the Patchwork Protocol Engine.
//
// Both surfaces (CLI and MCP server) need to resolve an incident's current
// status and call the core gate, or extract a review.md for the core verdict.
// This module concentrates that logic so the adapters stay thin and the
// resolution semantics (including fail-closed behavior for missing/unparseable
// incidents) are defined in exactly one place.
//
// Like read-workspace.js this lives OUTSIDE engine/core/ because it depends on
// the workspace snapshot shape (an I/O-adjacent concern), but every function
// here is pure over the snapshot — no disk access.

import { gate } from './core/gate.js';
import { verdict } from './core/verdict.js';
import { parseIncident, isSchemaError } from './core/schema.js';

/**
 * Resolve an incident's files from a workspace snapshot.
 *
 * @param {object} snapshot the workspace snapshot from readWorkspace.
 * @param {string} incidentId the incident id (INC-<id> directory name).
 * @returns {object|null} the incident's file map, or null if not found.
 */
function resolveIncidentFiles(snapshot, incidentId) {
  const incidents =
    snapshot && snapshot.incidents && typeof snapshot.incidents === 'object'
      ? snapshot.incidents
      : null;
  if (!incidents || !incidents[incidentId]) return null;
  return incidents[incidentId];
}

/**
 * Resolve an incident's current status from its incident.md frontmatter,
 * fail-closed. Returns either a successful resolution with `from` and the
 * parsed incident, or a gate-shaped rejection (allowed: false + reason).
 *
 * @param {object} snapshot the workspace snapshot.
 * @param {string} incidentId the incident id.
 * @param {string} workspaceDir workspace directory name (for error messages).
 * @returns {{ ok: true, from: string, incidentFiles: object } | { ok: false, result: { allowed: boolean, reason: string } }}
 */
export function resolveIncidentStatus(snapshot, incidentId, workspaceDir) {
  const incidentFiles = resolveIncidentFiles(snapshot, incidentId);

  if (incidentFiles === null) {
    return {
      ok: false,
      result: {
        allowed: false,
        reason: `incident "${incidentId}" not found in workspace "${workspaceDir}"`,
      },
    };
  }

  if (typeof incidentFiles['incident.md'] !== 'string') {
    return {
      ok: false,
      result: {
        allowed: false,
        reason: `incident "${incidentId}" is missing incident.md`,
      },
    };
  }

  const parsed = parseIncident(incidentFiles['incident.md']);
  if (isSchemaError(parsed)) {
    return {
      ok: false,
      result: {
        allowed: false,
        reason: `incident "${incidentId}" has invalid frontmatter: ${parsed.message}`,
      },
    };
  }

  return { ok: true, from: parsed.status, incidentFiles };
}

/**
 * Resolve the gate decision for an incident transition. Derives `from` from
 * the incident's current status and calls the core gate with the requested
 * `to`. Fail-closed on missing/unparseable incidents.
 *
 * @param {object} snapshot the workspace snapshot.
 * @param {{ incidentId: string, to: string, workspaceDir: string }} params
 * @returns {{ from: string|null, result: { allowed: boolean, reason: string } }}
 */
export function resolveAndGate(snapshot, { incidentId, to, workspaceDir }) {
  const resolved = resolveIncidentStatus(snapshot, incidentId, workspaceDir);

  if (!resolved.ok) {
    return { from: null, result: resolved.result };
  }

  const { from } = resolved;
  const result = gate(snapshot, { incidentId, from, to });
  return { from, result };
}

/**
 * Resolve the verdict for an incident's review.md. Extracts the review text
 * from the snapshot and calls the core verdict (fail-closed: a missing incident
 * or missing review.md yields NEEDS_WORK).
 *
 * @param {object} snapshot the workspace snapshot.
 * @param {string} incidentId the incident id.
 * @returns {{ verdict: 'PASS'|'NEEDS_WORK', author?: string, fixVersion?: number|string }}
 */
export function resolveAndVerdict(snapshot, incidentId) {
  const incidentFiles = resolveIncidentFiles(snapshot, incidentId);
  const reviewText =
    incidentFiles && typeof incidentFiles['review.md'] === 'string'
      ? incidentFiles['review.md']
      : undefined;

  return verdict(reviewText);
}
