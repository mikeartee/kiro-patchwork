// Shared schema parsers for the Patchwork Protocol Engine (task 1.2).
//
// These are pure, deterministic functions: no disk access, no wall-clock, and
// no randomness, so identical inputs always produce identical outputs
// (Requirement 10.6). Each parser returns either a parsed object or a
// SchemaError. The validate() command (task 1.3) turns a SchemaError into a
// Problem that names the offending path and the rule that was broken.
//
// Grammars (from design "Data Models"):
//   Incident frontmatter : id, title, status (enum), fix_version (integer)
//   Board entry          : [time] @who \u00B7 Role (human|agent) \u00B7 type: description
//   Remediation step     : [AFK]|[HITL] action ... verify: check
//
// _Requirements: 1.3, 2.2, 9.1, 9.2_

// The middle-dot separator (U+00B7) used between board-entry fields.
const DOT = '\u00B7';

/**
 * The artifact set a resolution-stage (RESOLVED) Incident_Directory must hold
 * (Requirement 1.4; design "Data Models › Workspace layout"). Placed here in
 * schema.js because it is data-model knowledge consumed by validate, the
 * workspace reader, and the dashboard — not validation logic per se.
 */
export const RESOLUTION_ARTIFACTS = Object.freeze([
  'incident.md',
  'analysis.md',
  'fix-proposal.md',
  'review.md',
  'decision-log.md',
  'postmortem.md',
]);

/**
 * The ordered Incident_Status enum. Any status outside this set is a schema
 * violation (Requirements 1.3, 3).
 */
export const INCIDENT_STATUSES = Object.freeze([
  'REPORTED',
  'INVESTIGATING',
  'ANALYSIS_READY',
  'AWAITING_APPROVAL',
  'APPROVED',
  'FIX_STAGED',
  'RESOLVED',
  'CHANGES_REQUESTED',
  'PARKED_FOR_HUMAN',
]);

/**
 * A structured schema violation. `rule` is a stable machine-readable id, `field`
 * names the offending field (or null), and `message` is human-readable. Task 1.3
 * maps these onto validate() Problems with a file path.
 */
export class SchemaError {
  constructor(rule, message, field = null) {
    this.rule = rule;
    this.message = message;
    this.field = field;
  }
}

export function isSchemaError(value) {
  return value instanceof SchemaError;
}

// ---------------------------------------------------------------------------
// parseIncident
// ---------------------------------------------------------------------------

/**
 * Parse the YAML frontmatter of an incident.md file.
 *
 * @param {string} text full file text, expected to start with a `---` block.
 * @returns {{ id: string, title: string, status: string, fix_version: number|string|undefined } | SchemaError}
 */
export function parseIncident(text) {
  if (typeof text !== 'string') {
    return new SchemaError(
      'incident.frontmatter.missing',
      'Incident text must be a string',
      'frontmatter',
    );
  }

  const lines = text.split(/\r?\n/);

  // Skip leading blank lines, then require an opening `---` delimiter.
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() !== '---') {
    return new SchemaError(
      'incident.frontmatter.missing',
      'Incident is missing YAML frontmatter (expected a leading --- delimiter)',
      'frontmatter',
    );
  }

  const start = i + 1;
  let end = -1;
  for (let j = start; j < lines.length; j++) {
    if (lines[j].trim() === '---') {
      end = j;
      break;
    }
  }
  if (end === -1) {
    return new SchemaError(
      'incident.frontmatter.unterminated',
      'Incident frontmatter is not terminated by a closing --- delimiter',
      'frontmatter',
    );
  }

  const data = {};
  for (let j = start; j < end; j++) {
    const raw = lines[j];
    if (raw.trim() === '') continue;
    const colon = raw.indexOf(':');
    if (colon === -1) {
      return new SchemaError(
        'incident.frontmatter.malformed',
        `Frontmatter line is not a "key: value" pair: "${raw.trim()}"`,
        'frontmatter',
      );
    }
    const key = raw.slice(0, colon).trim();
    data[key] = parseScalar(raw.slice(colon + 1));
  }

  // Required fields per Requirement 1.3.
  for (const key of ['id', 'title', 'status']) {
    if (!(key in data) || data[key] === '') {
      return new SchemaError(
        `incident.${key}.missing`,
        `Incident frontmatter is missing required field "${key}"`,
        key,
      );
    }
  }

  if (!INCIDENT_STATUSES.includes(data.status)) {
    return new SchemaError(
      'incident.status.unknown',
      `Unknown incident status "${data.status}"`,
      'status',
    );
  }

  const result = {
    id: data.id,
    title: data.title,
    status: data.status,
    // fix_version is parsed for later tasks (3.2 review-to-fix binding). It is
    // not required by Requirement 1.3, so it may be undefined when absent.
    fix_version: parseFixVersion(data.fix_version),
  };
  return result;
}

/**
 * Parse a YAML scalar value: strip surrounding quotes, or strip a trailing
 * inline "# comment" on an unquoted value (matching YAML's rule that a `#`
 * begins a comment only at the start or when preceded by whitespace).
 */
function parseScalar(rawValue) {
  const v = rawValue.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'")) {
    const quote = v[0];
    const close = v.indexOf(quote, 1);
    if (close !== -1) return v.slice(1, close);
    return v.slice(1); // unterminated quote: best effort
  }
  for (let k = 0; k < v.length; k++) {
    if (v[k] === '#' && (k === 0 || /\s/.test(v[k - 1]))) {
      return v.slice(0, k).trimEnd();
    }
  }
  return v;
}

/** Coerce a fix_version scalar to an integer when it looks like one. */
function parseFixVersion(value) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

// ---------------------------------------------------------------------------
// parseBoardEntry
// ---------------------------------------------------------------------------

// Full grammar: [time] @who \u00B7 Role (human|agent) \u00B7 type: description
const BOARD_ENTRY_RE = new RegExp(
  '^\\[([^\\]]*)\\]\\s+@(\\S+)\\s+' +
    DOT +
    '\\s+(.+?)\\s+\\((human|agent)\\)\\s+' +
    DOT +
    '\\s+([^:' +
    DOT +
    ']+):\\s*(.*)$',
);

/**
 * Parse a single Board_Entry line.
 *
 * @param {string} line
 * @returns {{ time: string, who: string, role: string, kind: 'human'|'agent', type: string, description: string } | SchemaError}
 *
 * The `who` handle is returned without its leading "@". `kind` captures the
 * required (human|agent) designation from the grammar; the author, role, and
 * type fields are all required (Requirements 2.2, 2.4).
 */
export function parseBoardEntry(line) {
  const trimmed = String(line).trim();

  const m = BOARD_ENTRY_RE.exec(trimmed);
  if (m) {
    return {
      time: m[1].trim(),
      who: m[2],
      role: m[3].trim(),
      kind: m[4],
      type: m[5].trim(),
      description: m[6].trim(),
    };
  }

  // The line does not match the grammar; diagnose the specific missing field
  // so validate() can report it precisely.
  if (!/@\S+/.test(trimmed)) {
    return new SchemaError(
      'board.author.missing',
      'Board entry is missing the @author field',
      'author',
    );
  }
  if (!/\((human|agent)\)/.test(trimmed)) {
    return new SchemaError(
      'board.role.missing',
      'Board entry is missing the "Role (human|agent)" field',
      'role',
    );
  }
  if (!new RegExp('\\)\\s*' + DOT + '\\s*[^:' + DOT + ']+:').test(trimmed)) {
    return new SchemaError(
      'board.type.missing',
      'Board entry is missing the "type:" contribution-type field',
      'type',
    );
  }

  return new SchemaError(
    'board.malformed',
    'Board entry does not match the required grammar',
    null,
  );
}

// ---------------------------------------------------------------------------
// parseRemediationStep
// ---------------------------------------------------------------------------

// A leading list marker ("- " or "* ") is optional, and when present it may be
// followed by a task checkbox ("[ ]", "[x]", or "[X]"). The checkbox appears
// when a remediation step uses the /human-itl clear/uncleared form (task 10.1),
// e.g. "- [x] [HITL] …" (cleared) or "- [ ] [HITL] …" (uncleared). Both the
// bullet and any checkbox are stripped before the [AFK]/[HITL] tag so a checked
// or unchecked step parses as the SAME remediation step — its clear-state is
// the gate's concern (gate.hasUnclearedHitlStep), not the schema's. The checkbox
// is nested inside the bullet group so it is only consumed after a bullet, and
// the single-character class [ xX] can never swallow a multi-letter [AFK]/[HITL]
// tag. This keeps validate() consistent with gate's cleared-detection.
const LIST_MARKER_RE = /^\s*(?:[-*]\s+(?:\[[ xX]\]\s+)?)?/;
const TAG_RE = /^\[(AFK|HITL)\]\s*(.*)$/; // tag is case-sensitive / uppercase
const VERIFY_RE = /verify:\s*(.*)$/i; // the "verify" keyword is case-insensitive
const TRAILING_SEPARATOR_RE = /[\s\u2014\u2013-]+$/; // em/en dash or hyphen + space

/**
 * Parse a single Remediation_Step line.
 *
 * @param {string} line
 * @returns {{ tag: 'AFK'|'HITL', text: string, verification: string } | SchemaError}
 *
 * Requires a leading [AFK] or [HITL] tag and a trailing "verify:" clause
 * (Requirements 9.1, 9.2, 9.4).
 */
export function parseRemediationStep(line) {
  const stripped = String(line).replace(LIST_MARKER_RE, '');

  const tagMatch = TAG_RE.exec(stripped);
  if (!tagMatch) {
    return new SchemaError(
      'remediation.tag.missing',
      'Remediation step is missing a leading [AFK] or [HITL] tag',
      'tag',
    );
  }
  const tag = tagMatch[1];
  const remainder = tagMatch[2];

  const verifyMatch = VERIFY_RE.exec(remainder);
  if (!verifyMatch || verifyMatch[1].trim() === '') {
    return new SchemaError(
      'remediation.verify.missing',
      'Remediation step is missing a "verify:" clause',
      'verification',
    );
  }

  const verification = verifyMatch[1].trim();
  const text = remainder
    .slice(0, verifyMatch.index)
    .trim()
    .replace(TRAILING_SEPARATOR_RE, '')
    .trim();

  return { tag, text, verification };
}
