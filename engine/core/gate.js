// The gate() core command for the Patchwork Protocol Engine (tasks 2.1, 3.2).
//
// gate() decides whether a requested Incident_Status transition is permitted.
// Like the rest of the core it is pure and deterministic: no disk access, no
// wall-clock, and no randomness, so identical inputs always produce identical
// outputs (Requirement 10.6). The CLI (task 2.2) and MCP server (task 5.1) are
// thin adapters that read a workspace snapshot and call this function.
//
// gate() decides in two layers:
//   Step 1 — transition legality (task 2.1). The explicit transition table
//     below is the SOLE source of allowed motion — any {from, to} pair absent
//     from the table is rejected (Requirements 3.5, 10.2). This is Property 2,
//     tested in task 2.4. Legality is independently queryable via the exported
//     `isDefinedTransition` / `TRANSITION_TABLE` without invoking the guard.
//   Step 2 — the RESOLVED guard (task 3.2). ONLY on the FIX_STAGED → RESOLVED
//     edge, and ONLY after Step 1 passes, gate() additionally requires a
//     non-author PASS verdict bound to the incident's current fix_version, plus
//     every [HITL] remediation step cleared. The guard is FAIL-CLOSED: any
//     missing/unreadable artifact, absent metadata line, stale/self-authored
//     PASS, or uncleared HITL rejects the transition. It can only ALLOW on
//     explicit satisfaction of all conditions (Requirements 6.3, 6.4, 8.5, 10.2;
//     design "Data Models › Review-to-fix binding", "Error Handling › Stale or
//     self-authored PASS", "Error Handling › Uncleared HITL and round-cap").
//   Step 3 — the round-cap guard (task 3.3). ONLY on the two CHANGES_REQUESTED
//     out-edges, and ONLY after Step 1 passes, gate() routes on the incident's
//     revision-cycle count vs the configured Round_Cap. The two edges are
//     complementary — exactly one is permitted at a time:
//       • CHANGES_REQUESTED → INVESTIGATING is allowed WHILE below the cap
//         (another SRE→Reviewer revision cycle is permitted), and rejected once
//         the cap is reached (no more revision cycles).
//       • CHANGES_REQUESTED → PARKED_FOR_HUMAN is allowed ONLY once the cap is
//         reached (the escape to a human), and rejected while below it (keep
//         revising, do not park early).
//     The revision-cycle count is derived from the incident's `fix_version`
//     (see revisionCycleCount below), so the routing is pure and per-incident
//     (Requirements 12.1, 12.2, 12.3; design "Architecture › Incident state
//     machine" cycle++ note, "Error Handling › Uncleared HITL and round-cap").
//
// Because the guards add REJECTIONS only on the FIX_STAGED → RESOLVED edge and
// the two CHANGES_REQUESTED out-edges, "gate allows a pair ⇒ the pair is in the
// table" still holds (allowing implies legality; the converse is not claimed
// once a guard is in play). Tests that assert pure table membership use
// `isDefinedTransition` / `TRANSITION_TABLE` rather than `gate` on an empty
// workspace.
//
// _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 6.3, 6.4, 8.5, 10.2, 12.1, 12.2, 12.3_

import { INCIDENT_STATUSES, parseIncident, isSchemaError } from './schema.js';
import { verdict } from './verdict.js';

// The middle arrow (U+2192) used when naming a transition in a reason string.
const ARROW = '\u2192';

/**
 * The explicit transition table, transcribed edge-for-edge from the design's
 * "Architecture › Incident state machine" diagram. Each entry is a `[from, to]`
 * pair. This ordered edge list is the literal, reviewable source of truth; the
 * `TRANSITION_TABLE` Map below is derived from it for O(1) lookups.
 *
 * Happy path:  REPORTED → INVESTIGATING → ANALYSIS_READY → AWAITING_APPROVAL →
 *              APPROVED → FIX_STAGED → RESOLVED (Requirement 3.2).
 * Branch edges: NEEDS_WORK / human rejection route through CHANGES_REQUESTED,
 *              which returns to INVESTIGATING or parks for a human; a parked
 *              incident resumes at INVESTIGATING (Requirements 3.3, 3.4, 8.3, 12).
 */
export const TRANSITIONS = Object.freeze([
  ['REPORTED', 'INVESTIGATING'],
  ['INVESTIGATING', 'ANALYSIS_READY'],
  ['ANALYSIS_READY', 'AWAITING_APPROVAL'],
  ['ANALYSIS_READY', 'CHANGES_REQUESTED'],
  ['AWAITING_APPROVAL', 'APPROVED'],
  ['AWAITING_APPROVAL', 'CHANGES_REQUESTED'],
  ['APPROVED', 'FIX_STAGED'],
  ['FIX_STAGED', 'RESOLVED'],
  ['CHANGES_REQUESTED', 'INVESTIGATING'],
  ['CHANGES_REQUESTED', 'PARKED_FOR_HUMAN'],
  ['PARKED_FOR_HUMAN', 'INVESTIGATING'],
]);

/**
 * The transition table as a Map from a `from` status to the Set of statuses it
 * may transition to. Derived from TRANSITIONS so the two never drift apart.
 * Exported so unit tests (task 2.3) and the property test (task 2.4) can assert
 * against the same table the gate consults.
 *
 * @type {ReadonlyMap<string, ReadonlySet<string>>}
 */
export const TRANSITION_TABLE = (() => {
  const table = new Map();
  for (const [from, to] of TRANSITIONS) {
    if (!table.has(from)) table.set(from, new Set());
    table.get(from).add(to);
  }
  return table;
})();

/**
 * Is `{from, to}` a transition defined in the table? An unknown status in the
 * pair can never be in the table, so it returns false (the pair is rejected).
 * This is the single, self-contained legality check that task 3.2 augments for
 * the FIX_STAGED → RESOLVED edge — it will keep this table check as step one and
 * add the guard conditions as step two.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isDefinedTransition(from, to) {
  const allowedTargets = TRANSITION_TABLE.get(from);
  return allowedTargets !== undefined && allowedTargets.has(to);
}

/**
 * Decide whether a requested Incident_Status transition is permitted.
 *
 * @param {import('./validate.js').WorkspaceSnapshot} workspace
 *   The workspace snapshot. Unused for pure transition legality (Step 1), but
 *   required by the RESOLVED guard (Step 2, task 3.2), which reads the
 *   incident's fix_version, the fix-proposal author, the review verdict, and
 *   the HITL step state from it for `incidentId`.
 * @param {{ incidentId?: string, from: string, to: string }} request
 *   The requested transition. `incidentId` selects the incident the RESOLVED
 *   guard resolves from the workspace; on the FIX_STAGED → RESOLVED edge a
 *   missing/undiscoverable incident is rejected fail-closed.
 * @returns {{ allowed: boolean, reason: string }}
 *   For every edge except FIX_STAGED → RESOLVED, `allowed` is true exactly when
 *   the pair is in the transition table. For FIX_STAGED → RESOLVED, `allowed`
 *   is true only when the table check passes AND the RESOLVED guard is fully
 *   satisfied. `reason` is a short, human-readable explanation either way.
 */
export function gate(workspace, request) {
  const { from, to } = request ?? {};

  // Step 1 — transition legality: the table is the sole source of allowed
  // motion. Any pair not present is rejected (Requirements 3.5, 10.2).
  if (!isDefinedTransition(from, to)) {
    // An unknown status can never be in the table; name that explicitly so a
    // caller can tell a typo'd status from a merely-undefined-but-valid edge.
    const knownFrom = INCIDENT_STATUSES.includes(from);
    const knownTo = INCIDENT_STATUSES.includes(to);
    if (!knownFrom || !knownTo) {
      const unknowns = [
        !knownFrom ? `from "${from}"` : null,
        !knownTo ? `to "${to}"` : null,
      ]
        .filter(Boolean)
        .join(' and ');
      return {
        allowed: false,
        reason: `unknown incident status (${unknowns})`,
      };
    }
    return {
      allowed: false,
      reason: `no transition defined from ${from} to ${to}`,
    };
  }

  // Step 2 (task 3.2) — RESOLVED guard: the FIX_STAGED → RESOLVED edge is the
  // one guarded edge. Everything the guard needs (the incident's fix_version,
  // the fix-proposal author, the review verdict/author/fix version, and the
  // HITL step state) is read from the workspace snapshot for `incidentId`.
  if (from === 'FIX_STAGED' && to === 'RESOLVED') {
    return resolvedGuard(workspace, request);
  }

  // Step 3 (task 3.3) — round-cap guard: the two CHANGES_REQUESTED out-edges are
  // routed on the incident's revision-cycle count vs the Round_Cap. Below the
  // cap only the → INVESTIGATING revision edge is permitted; at the cap only the
  // → PARKED_FOR_HUMAN escape edge is permitted.
  if (
    from === 'CHANGES_REQUESTED' &&
    (to === 'INVESTIGATING' || to === 'PARKED_FOR_HUMAN')
  ) {
    return roundCapGuard(workspace, request);
  }

  return {
    allowed: true,
    reason: `transition ${from}${ARROW}${to} is permitted`,
  };
}

// ---------------------------------------------------------------------------
// The RESOLVED guard (task 3.2)
// ---------------------------------------------------------------------------
//
// Conventions this guard reads (documented here as the SOURCE OF TRUTH for the
// tasks that WRITE these artifacts):
//
//   • fix-proposal.md author — task 7.1. Recorded as a single metadata line
//     near the top of fix-proposal.md, mirroring review.md's `Reviewer:` /
//     `Fix-Version:` convention (see verdict.js):
//
//         Author: patchwork-sre
//
//     The label is case-insensitive; the first `Author:` line wins; a leading
//     `@` on the handle is stripped so it compares directly to the review's
//     `Reviewer:` handle for the Non_Author_Rule. When the line is absent the
//     author is unknown and the guard fails closed (a PASS cannot be proven
//     non-author against an unknown fix author).
//
//   • HITL "cleared" marker — tasks 7.1 (writes the steps) and 10.1 (`/human-itl`
//     checks them off). A remediation step is a Markdown list item carrying a
//     `[HITL]` tag; it is CLEARED only when it has a CHECKED task checkbox:
//
//         - [x] [HITL] Rotate the leaked API key — verify: Commander confirms …   (cleared)
//         - [ ] [HITL] Rotate the leaked API key — verify: …                       (uncleared)
//         - [HITL] Rotate the leaked API key — verify: …                           (uncleared)
//
//     i.e. an unchecked `[ ]` OR a plain step with no checkbox is UNCLEARED.
//     This matches the design's `/human-itl` "check the step off" language
//     (task 10.1). NOTE for tasks 7.1 / 10.1 / 1.2: when fix-proposal.md steps
//     adopt the `- [ ]` / `- [x]` checkbox form, schema.parseRemediationStep
//     must be taught to skip a leading task checkbox before the [AFK]/[HITL]
//     tag, or validate() will misreport those steps as missing their tag. The
//     guard below scans the raw lines itself and does not depend on that.

/** The middle-dot label parser for the fix-proposal `Author:` line. */
const FIX_PROPOSAL_AUTHOR_RE = /^\s*Author:\s*@?(.+?)\s*$/i;

/**
 * A Markdown list item that carries a `[HITL]` tag, optionally preceded by a
 * task checkbox. Used to LOCATE HITL remediation steps in fix-proposal.md.
 */
const HITL_STEP_RE = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?\[HITL\]/;

/**
 * A HITL list item whose task checkbox is CHECKED (`- [x] [HITL] …`). Only a
 * checked box counts as cleared; an unchecked box or a plain (checkbox-less)
 * HITL step is uncleared.
 */
const HITL_CLEARED_RE = /^\s*[-*]\s+\[[xX]\]\s+\[HITL\]/;

/**
 * Extract the fix-proposal author handle from an `Author:` metadata line.
 *
 * @param {string} text full contents of fix-proposal.md (or any string).
 * @returns {string|undefined} the handle (leading `@` stripped), or undefined
 *   when no non-empty `Author:` line is present.
 */
export function parseFixProposalAuthor(text) {
  if (typeof text !== 'string') return undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = FIX_PROPOSAL_AUTHOR_RE.exec(line);
    if (m && m[1].trim() !== '') return m[1].trim();
  }
  return undefined;
}

/**
 * Does the fix proposal still have an UNCLEARED `[HITL]` remediation step?
 *
 * A HITL step is any list item carrying a `[HITL]` tag; it is cleared only when
 * its task checkbox is checked (`- [x] [HITL] …`). An unchecked `- [ ] [HITL]`
 * or a plain `- [HITL]` step is uncleared. A proposal with no HITL steps has
 * nothing to clear, so this returns false (Requirement 8.5).
 *
 * @param {string} fixProposalText full contents of fix-proposal.md (or any string).
 * @returns {boolean} true iff at least one HITL step remains uncleared.
 */
export function hasUnclearedHitlStep(fixProposalText) {
  if (typeof fixProposalText !== 'string') return false;
  for (const line of fixProposalText.split(/\r?\n/)) {
    if (!HITL_STEP_RE.test(line)) continue; // not a HITL remediation step
    if (!HITL_CLEARED_RE.test(line)) return true; // uncleared (unchecked / plain)
  }
  return false;
}

/**
 * Evaluate the FIX_STAGED → RESOLVED guard for one incident, fail-closed.
 *
 * Requires ALL of, else rejects with a specific reason:
 *   1. a PASS verdict in review.md whose recorded author differs from the
 *      fix-proposal author (Non_Author_Rule; Requirements 6.3, 6.4),
 *   2. that PASS recorded against the incident's CURRENT fix_version — a stale
 *      PASS from an earlier revision is ignored (Requirement 6.3, review-to-fix
 *      binding),
 *   3. every [HITL] remediation step cleared (Requirement 8.5).
 *
 * Any missing/unreadable review, missing fix-proposal, unparseable incident, or
 * absent metadata line is a fail-closed rejection: the guard can only ALLOW on
 * explicit satisfaction of all three conditions.
 *
 * @param {import('./validate.js').WorkspaceSnapshot} workspace
 * @param {{ incidentId?: string, from: string, to: string }} request
 * @returns {{ allowed: boolean, reason: string }}
 */
function resolvedGuard(workspace, request) {
  const incidentId = request?.incidentId;

  // Resolve the incident's artifact files from the snapshot. No incident to
  // check against ⇒ unverifiable ⇒ fail closed.
  const incidents =
    workspace && typeof workspace === 'object' && workspace.incidents
      ? workspace.incidents
      : null;
  const files =
    incidentId && incidents && typeof incidents === 'object'
      ? incidents[incidentId]
      : null;
  if (!files || typeof files !== 'object') {
    return {
      allowed: false,
      reason: `RESOLVED gate: incident "${incidentId ?? '?'}" not found in the workspace snapshot`,
    };
  }

  // 1. incident.md → the current fix_version the PASS must be bound to.
  const incidentText = files['incident.md'];
  if (typeof incidentText !== 'string') {
    return {
      allowed: false,
      reason:
        'RESOLVED gate: incident.md is missing (cannot bind a review to a fix version)',
    };
  }
  const incident = parseIncident(incidentText);
  if (isSchemaError(incident)) {
    return {
      allowed: false,
      reason: `RESOLVED gate: incident.md is unparseable (${incident.message})`,
    };
  }
  const currentFixVersion = incident.fix_version;
  if (currentFixVersion === undefined) {
    return {
      allowed: false,
      reason: 'RESOLVED gate: incident.md has no fix_version to bind the review to',
    };
  }

  // 2. fix-proposal.md → the author, for the Non_Author_Rule and the HITL scan.
  const fixProposalText = files['fix-proposal.md'];
  if (typeof fixProposalText !== 'string') {
    return {
      allowed: false,
      reason:
        'RESOLVED gate: fix-proposal.md is missing (cannot enforce the Non_Author_Rule)',
    };
  }
  const fixAuthor = parseFixProposalAuthor(fixProposalText);
  if (fixAuthor === undefined) {
    return {
      allowed: false,
      reason:
        'RESOLVED gate: fix-proposal.md has no "Author:" line (cannot enforce the Non_Author_Rule)',
    };
  }

  // 3. review.md → fail-closed verdict + recorded author + recorded fix version.
  const reviewText = files['review.md'];
  if (typeof reviewText !== 'string') {
    return {
      allowed: false,
      reason: 'RESOLVED gate: review.md is missing (no PASS verdict)',
    };
  }
  const review = verdict(reviewText);
  if (review.verdict !== 'PASS') {
    return {
      allowed: false,
      reason: 'RESOLVED gate: review.md does not record a PASS verdict',
    };
  }
  // Non_Author_Rule: a PASS cannot be authored by the fix author.
  if (review.author === undefined) {
    return {
      allowed: false,
      reason:
        'RESOLVED gate: review.md has no "Reviewer:" line (cannot verify the Non_Author_Rule)',
    };
  }
  if (review.author === fixAuthor) {
    return {
      allowed: false,
      reason: `RESOLVED gate: PASS is self-authored by "${fixAuthor}" (Non_Author_Rule)`,
    };
  }
  // Review-to-fix binding: the PASS must be recorded against the current fix
  // version; a stale PASS from an earlier revision is ignored.
  if (review.fixVersion === undefined) {
    return {
      allowed: false,
      reason:
        'RESOLVED gate: review.md has no "Fix-Version:" line (cannot bind the PASS to a fix version)',
    };
  }
  if (review.fixVersion !== currentFixVersion) {
    return {
      allowed: false,
      reason: `RESOLVED gate: PASS is stale — recorded against fix_version ${review.fixVersion}, incident is at ${currentFixVersion}`,
    };
  }

  // 4. Every [HITL] remediation step must be cleared.
  if (hasUnclearedHitlStep(fixProposalText)) {
    return {
      allowed: false,
      reason: 'RESOLVED gate: one or more [HITL] steps remain uncleared',
    };
  }

  return {
    allowed: true,
    reason: `transition FIX_STAGED${ARROW}RESOLVED is permitted (non-author PASS by "${review.author}" at fix_version ${currentFixVersion}, all HITL cleared)`,
  };
}

// ---------------------------------------------------------------------------
// The round-cap guard (task 3.3)
// ---------------------------------------------------------------------------
//
// COUNT-DERIVATION DECISION (documented here as the source of truth):
//
//   The revision-cycle count is derived from the incident's `fix_version`
//   frontmatter field, NOT from counting NEEDS_WORK entries on the Board.
//
//   Why fix_version and not the Board:
//     • Requirement 12.1 requires tracking revision cycles PER INCIDENT. The
//       Board (patchwork/board.md) is a single, workspace-wide, chronological
//       timeline whose entry grammar — `[time] @who · Role (human|agent) ·
//       type: desc` — carries NO incident id, so a NEEDS_WORK count taken from
//       the Board cannot be deterministically attributed to one incident.
//     • review.md holds only the LATEST verdict (it is overwritten each cycle),
//       so it carries no per-incident cycle history either.
//     • fix_version lives in each incident's incident.md frontmatter, is already
//       parsed by parseIncident, and the design states it is "incremented each
//       revision cycle; ties a review to a fix". It is therefore the per-incident
//       observable signal that directly tracks the `CHANGES_REQUESTED →
//       INVESTIGATING` "cycle++" in the design's state machine.
//
//   Mapping: fix_version starts at 1 (the initial fix proposal — zero revisions)
//   and increments once per completed revision cycle, so
//
//       revisionCycleCount = max(0, fix_version - 1)
//
//   Keeping the derivation in fix_version means the core stays pure and
//   deterministic (no transition-history replay), consistent with Requirement
//   10.6 and the rest of the engine.
//
// FAIL-BEHAVIOUR: when the incident, its incident.md, or a usable integer
// fix_version is absent, revisionCycleCount returns 0 (treated as "below the
// cap"). Unlike the RESOLVED guard — which fails CLOSED because letting an
// unreviewed fix through is unsafe — the round-cap is an ESCALATION mechanism,
// not a safety gate: when the count is indeterminate the safe default is to
// permit the ordinary forward revision edge (→ INVESTIGATING) and withhold the
// early escape (→ PARKED_FOR_HUMAN) until the cap is provably reached. This also
// keeps the empty-workspace legality matrix intact: with count 0,
// CHANGES_REQUESTED → INVESTIGATING stays allowed.

/**
 * The configured maximum number of SRE→Reviewer revision cycles permitted
 * before an incident is parked for the human (Round_Cap; Requirement 12.2).
 * A single exported constant is deliberately used instead of a configuration
 * system: the design specifies one "configured maximum" with no per-workspace
 * override, so there is one obvious value.
 *
 * @type {number}
 */
export const ROUND_CAP = 3;

/**
 * Look up one incident's artifact-file map in a workspace snapshot.
 *
 * @param {import('./validate.js').WorkspaceSnapshot} workspace
 * @param {string|undefined} incidentId
 * @returns {import('./validate.js').IncidentFiles|null} the file map, or null
 *   when the workspace/incident is absent or malformed.
 */
function getIncidentFiles(workspace, incidentId) {
  const incidents =
    workspace && typeof workspace === 'object' && workspace.incidents
      ? workspace.incidents
      : null;
  const files =
    incidentId && incidents && typeof incidents === 'object'
      ? incidents[incidentId]
      : null;
  return files && typeof files === 'object' ? files : null;
}

/**
 * The number of completed SRE→Reviewer revision cycles for an incident, derived
 * from its `fix_version` as `max(0, fix_version - 1)` (see the decision note
 * above). Pure and deterministic.
 *
 * Returns 0 when the incident, its incident.md, or a usable integer fix_version
 * is absent — "below the cap", the safe default for this escalation mechanism.
 *
 * @param {import('./validate.js').WorkspaceSnapshot} workspace
 * @param {string} [incidentId]
 * @returns {number} the revision-cycle count (never negative).
 */
export function revisionCycleCount(workspace, incidentId) {
  const files = getIncidentFiles(workspace, incidentId);
  if (!files) return 0;

  const incidentText = files['incident.md'];
  if (typeof incidentText !== 'string') return 0;

  const incident = parseIncident(incidentText);
  if (isSchemaError(incident)) return 0;

  const fixVersion = incident.fix_version;
  // parseIncident coerces an integer-like fix_version to a number; anything
  // else (missing, or a non-integer scalar) is not a usable cycle count.
  if (typeof fixVersion !== 'number' || !Number.isInteger(fixVersion)) return 0;

  return Math.max(0, fixVersion - 1);
}

/**
 * Has the incident reached the configured Round_Cap of revision cycles?
 *
 * @param {import('./validate.js').WorkspaceSnapshot} workspace
 * @param {string} [incidentId]
 * @returns {boolean} true iff revisionCycleCount(...) >= ROUND_CAP.
 */
export function isRoundCapReached(workspace, incidentId) {
  return revisionCycleCount(workspace, incidentId) >= ROUND_CAP;
}

/**
 * Route the two CHANGES_REQUESTED out-edges on the revision-cycle count.
 *
 * The edges are complementary — exactly one is permitted at a time:
 *   • → INVESTIGATING       allowed WHILE below the cap, rejected AT the cap.
 *   • → PARKED_FOR_HUMAN    allowed AT/ABOVE the cap, rejected below it.
 *
 * Being in CHANGES_REQUESTED already means there is no accepted PASS driving
 * forward progress (a PASS routes ANALYSIS_READY → AWAITING_APPROVAL, not into
 * CHANGES_REQUESTED), which is the "without a PASS" condition of Requirement
 * 12.2; the routing here is therefore purely a function of the cycle count.
 *
 * @param {import('./validate.js').WorkspaceSnapshot} workspace
 * @param {{ incidentId?: string, from: string, to: string }} request
 * @returns {{ allowed: boolean, reason: string }}
 */
function roundCapGuard(workspace, request) {
  const { incidentId, to } = request;
  const cycles = revisionCycleCount(workspace, incidentId);
  const capReached = cycles >= ROUND_CAP;

  if (to === 'INVESTIGATING') {
    if (capReached) {
      return {
        allowed: false,
        reason: `round-cap reached (${cycles}/${ROUND_CAP} revision cycles): no further SRE${ARROW}Reviewer cycles — park for a human instead`,
      };
    }
    return {
      allowed: true,
      reason: `transition CHANGES_REQUESTED${ARROW}INVESTIGATING is permitted (${cycles}/${ROUND_CAP} revision cycles used)`,
    };
  }

  // to === 'PARKED_FOR_HUMAN'
  if (!capReached) {
    return {
      allowed: false,
      reason: `round-cap not reached (${cycles}/${ROUND_CAP} revision cycles): continue revising rather than parking early`,
    };
  }
  return {
    allowed: true,
    reason: `transition CHANGES_REQUESTED${ARROW}PARKED_FOR_HUMAN is permitted (round-cap ${cycles}/${ROUND_CAP} reached)`,
  };
}
