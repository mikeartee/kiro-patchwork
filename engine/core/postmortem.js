// Post-mortem structural validator and decision-log append-only helpers for the
// Patchwork Protocol Engine (task 9.2).
//
// The Scribe agent (.kiro/agents/patchwork-scribe.md) COMPILES postmortem.md as
// model-generated prose, so its content is not produced deterministically by the
// engine. This module supplies the small, dependency-light DETERMINISTIC checks
// that pin the load-bearing structure the Scribe promises, so downstream tests
// (task 9.2) and the golden-path integration test (task 14.1) can confirm the
// four required elements are present and the whole artifact chain is linked
// without relying on model judgement.
//
// Like validate.js, every function here is pure: no disk access, no wall-clock,
// and no randomness, so identical inputs always yield identical outputs
// (Requirement 10.6). Problems use the same { path, rule, message } shape as
// validate() so the two validators read alike.
//
// What validatePostmortem checks (Requirements 7.3, 7.4), matching the exact,
// stable headings documented in the Scribe prompt:
//   - the `# Post-mortem - INC-<id>` title line (carries the incident id)
//   - the `Incident: INC-<id>` identifier metadata line (Req 7.4 identifier)
//   - the `## Root cause` section          (Req 7.4 root cause)
//   - the `## Applied fix` section         (Req 7.4 applied fix)
//   - the `## Review outcome` section      (Req 7.4 review outcome)
//   - that all five source artifacts are referenced/linked (Req 7.3 compiled
//     FROM incident.md, analysis.md, fix-proposal.md, review.md, decision-log.md)
//
// What the decision-log helpers model (Requirement 7.2):
//   - appendDecision(existingLog, newEntry) reproduces every existing byte as an
//     exact prefix, then adds the new entry below it (newest at the bottom).
//   - isAppendOnly(before, after) is true only when `after` preserves `before`
//     verbatim as a prefix, so dropping, reordering, or editing a prior entry is
//     detected as NOT append-only.
//
// _Requirements: 7.2, 7.3, 7.4_

/**
 * @typedef {Object} Problem
 * A single validation failure, naming the offending path and the broken rule.
 * Shares validate()'s shape so both validators are consumed the same way.
 * @property {string} path    Workspace-relative path of the offending file.
 * @property {string} rule    Stable, machine-readable id of the broken rule.
 * @property {string} message Human-readable description of the problem.
 */

/**
 * The five source artifacts a compiled post-mortem must draw from and link, so
 * a reader can trace every claim back to its origin (Requirement 7.3).
 * postmortem.md itself is the compiled OUTPUT, so it is not in this list.
 */
export const POSTMORTEM_SOURCE_ARTIFACTS = Object.freeze([
  'incident.md',
  'analysis.md',
  'fix-proposal.md',
  'review.md',
  'decision-log.md',
]);

// Escape any regex-special characters in an incident id before interpolating it
// into a matcher, so an id is always treated as a literal string.
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function problem(path, rule, message) {
  return { path, rule, message };
}

/**
 * Validate the structure of a compiled post-mortem.
 *
 * @param {string} text  The full contents of a compiled `postmortem.md`.
 * @param {{ incidentId?: string }} [options]
 *   `incidentId` (e.g. `"INC-2024-001"`) pins the title and identifier line to a
 *   specific incident. When omitted, those two checks only require the generic
 *   `# Post-mortem - <something>` title and an `Incident: <something>` line.
 * @returns {{ ok: boolean, problems: Problem[] }}
 *   `ok` is true only when `problems` is empty. Problems are emitted in a fixed
 *   order (title, identifier, the three required sections, then artifacts in
 *   POSTMORTEM_SOURCE_ARTIFACTS order) so identical inputs yield identical
 *   output (Requirement 10.6).
 */
export function validatePostmortem(text, options = {}) {
  const incidentId =
    options && options.incidentId != null ? String(options.incidentId) : null;
  const path = incidentId
    ? `patchwork/incidents/${incidentId}/postmortem.md`
    : 'postmortem.md';
  const problems = [];

  if (typeof text !== 'string') {
    problems.push(
      problem(
        path,
        'postmortem.text.missing',
        'Post-mortem text must be a string',
      ),
    );
    return { ok: false, problems };
  }

  // 1. Title line: `# Post-mortem - INC-<id>` (carries the incident identifier).
  const titleRe = incidentId
    ? new RegExp(`^#\\s+Post-mortem\\s*-\\s*${escapeRegExp(incidentId)}\\s*$`, 'm')
    : /^#\s+Post-mortem\s*-\s*\S+\s*$/m;
  if (!titleRe.test(text)) {
    problems.push(
      problem(
        path,
        'postmortem.title.missing',
        incidentId
          ? `Post-mortem is missing the "# Post-mortem - ${incidentId}" title line`
          : 'Post-mortem is missing the "# Post-mortem - INC-<id>" title line',
      ),
    );
  }

  // 2. `Incident: INC-<id>` identifier metadata line (Requirement 7.4).
  const identifierRe = incidentId
    ? new RegExp(`^Incident:\\s*${escapeRegExp(incidentId)}\\s*$`, 'm')
    : /^Incident:\s*\S+/m;
  if (!identifierRe.test(text)) {
    problems.push(
      problem(
        path,
        'postmortem.identifier.missing',
        incidentId
          ? `Post-mortem is missing the "Incident: ${incidentId}" identifier line`
          : 'Post-mortem is missing the "Incident: INC-<id>" identifier line',
      ),
    );
  }

  // 3. The three required sections, matched on their exact documented headings.
  const sections = [
    ['## Root cause', 'postmortem.root_cause.missing', 'Root cause'],
    ['## Applied fix', 'postmortem.applied_fix.missing', 'Applied fix'],
    ['## Review outcome', 'postmortem.review_outcome.missing', 'Review outcome'],
  ];
  for (const [heading, rule, label] of sections) {
    const headingRe = new RegExp(`^##\\s+${escapeRegExp(label)}\\s*$`, 'm');
    if (!headingRe.test(text)) {
      problems.push(
        problem(path, rule, `Post-mortem is missing the "${heading}" section`),
      );
    }
  }

  // 4. All five source artifacts are referenced/linked (Requirement 7.3).
  for (const artifact of POSTMORTEM_SOURCE_ARTIFACTS) {
    if (!text.includes(artifact)) {
      problems.push(
        problem(
          path,
          'postmortem.artifact.unlinked',
          `Post-mortem does not reference the source artifact ${artifact}`,
        ),
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Model an append to a decision log: preserve every existing byte as an exact
 * prefix, then add the new entry below the last one (Requirement 7.2). Because
 * the Scribe's write tool replaces the whole file, this is the single place that
 * defines "append": the returned string always satisfies
 * `result.startsWith(existingLog)`, so no prior entry can be dropped, reordered,
 * or edited by an append.
 *
 * @param {string} existingLog  Current contents of `decision-log.md` (may be '').
 * @param {string} newEntry     The new decision entry to append below the rest.
 * @returns {string}            The full decision log with the new entry appended.
 */
export function appendDecision(existingLog, newEntry) {
  const base = typeof existingLog === 'string' ? existingLog : '';
  const entry = typeof newEntry === 'string' ? newEntry : '';

  // Separate the new entry from prior content with a blank line, WITHOUT
  // altering any existing byte (the separator is only ever added after `base`).
  let separator = '';
  if (base.length > 0) {
    if (base.endsWith('\n\n')) separator = '';
    else if (base.endsWith('\n')) separator = '\n';
    else separator = '\n\n';
  }

  return base + separator + entry;
}

/**
 * Decide whether `after` is an append-only evolution of `before`: true only when
 * `after` preserves `before` verbatim as a leading prefix, so every prior byte
 * (and therefore every prior entry, in order) is still present and unchanged and
 * any new content appears strictly after it. Dropping, reordering, or editing a
 * prior entry changes the prefix and is reported as NOT append-only
 * (Requirement 7.2).
 *
 * @param {string} before  The decision log before the change.
 * @param {string} after   The decision log after the change.
 * @returns {boolean}
 */
export function isAppendOnly(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  return after.startsWith(before);
}
