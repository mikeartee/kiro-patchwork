// Pure render core for the optional read-only room dashboard (task 16).
//
// renderDashboard(snapshot) is a PURE, deterministic function: it takes an
// in-memory workspace snapshot (the exact shape engine/read-workspace.js
// produces) and RETURNS an HTML string. It performs NO disk access, NO network
// calls, NO LLM calls, and NO writes of any kind — it only reads the snapshot
// object it is handed and builds a string. The thin runnable adapter
// engine/dashboard.js owns the disk read (via the shared readWorkspace) and the
// printing, exactly mirroring the cli.js/mcp.js "core is pure, adapter does I/O"
// separation. Because this core never touches the workspace, the dashboard can
// never modify it (Requirement 17.3).
//
// It reuses the shared schema parsers rather than re-implementing any grammar:
// parseIncident for each incident.md status (Requirement 17.1) and
// parseBoardEntry for each board timeline line (Requirement 17.2). The
// artifact-chain order comes from RESOLUTION_ARTIFACTS so the dashboard and
// validate() agree on the canonical artifact set.
//
// _Requirements: 17.1, 17.2, 17.3_

import { parseIncident, parseBoardEntry, isSchemaError } from './schema.js';
import { RESOLUTION_ARTIFACTS } from './validate.js';

// How many of the most-recent board entries the dashboard surfaces. The Board
// is chronological (Requirement 2.5), so "recent" is simply the tail of the
// list. Kept as a named constant (not a config knob) so the view has one
// obvious meaning of "recent".
export const RECENT_ENTRY_LIMIT = 10;

// Map each artifact to the role that authors it (design "Roles and least
// privilege" + "Components"): the Commander files incident.md, the SRE writes
// analysis/fix-proposal, the Reviewer writes review.md, and the Scribe writes
// the decision log + post-mortem. Used to badge the artifact chain with the
// same Human/SRE/Reviewer/Scribe vocabulary as the board entries.
const ARTIFACT_OWNER = Object.freeze({
  'incident.md': 'Human',
  'analysis.md': 'SRE',
  'fix-proposal.md': 'SRE',
  'review.md': 'Reviewer',
  'decision-log.md': 'Scribe',
  'postmortem.md': 'Scribe',
});

/**
 * Map a parsed Board_Entry's role/kind to one of the four dashboard badges:
 * Human, SRE, Reviewer, or Scribe. Any human contributor badges as Human (the
 * Incident Commander is the human actor); an agent badges by its role. An
 * unrecognized agent role falls back to its own trimmed role text so no
 * information is silently dropped.
 *
 * @param {{ role?: string, kind?: 'human'|'agent' }} entry
 * @returns {string}
 */
export function roleBadge({ role, kind } = {}) {
  if (kind === 'human') return 'Human';
  const r = String(role ?? '').toLowerCase();
  if (r.includes('sre')) return 'SRE';
  if (r.includes('review')) return 'Reviewer';
  if (r.includes('scribe')) return 'Scribe';
  return String(role ?? 'Agent').trim() || 'Agent';
}

/** Escape text for safe interpolation into HTML. Workspace content is untrusted
 * (design "Security Considerations"), so every interpolated value is escaped —
 * cheap defense even though the page has no network/auth surface. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parse the well-formed board timeline entries out of a raw board.md string.
 * Mirrors validate()'s "a timeline line starts with [" convention so header and
 * prose lines are skipped. Malformed lines are the validator's concern, not the
 * dashboard's, so a line that fails the grammar is simply not surfaced here.
 *
 * @param {string|null|undefined} board raw board.md contents.
 * @returns {Array<{time:string,who:string,role:string,kind:string,type:string,description:string}>}
 */
function parseBoardEntries(board) {
  if (typeof board !== 'string') return [];
  const entries = [];
  for (const line of board.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('[')) continue;
    const parsed = parseBoardEntry(line);
    if (isSchemaError(parsed)) continue;
    entries.push(parsed);
  }
  return entries;
}

/** Render one incident's card: id, title, current status, and artifact chain. */
function renderIncident(id, files) {
  const fileMap = files && typeof files === 'object' ? files : {};

  // Current Incident_Status via the shared parser (Requirement 17.1). A missing
  // or unparseable incident.md reads as UNKNOWN rather than crashing the view.
  let status = 'UNKNOWN';
  let title = '';
  const incidentText = fileMap['incident.md'];
  if (typeof incidentText === 'string') {
    const parsed = parseIncident(incidentText);
    if (!isSchemaError(parsed)) {
      status = parsed.status;
      title = parsed.title;
    }
  }

  const artifactItems = RESOLUTION_ARTIFACTS.map((artifact) => {
    const present = typeof fileMap[artifact] === 'string';
    const owner = ARTIFACT_OWNER[artifact] ?? 'Agent';
    return (
      `      <li class="artifact ${present ? 'present' : 'missing'}">` +
      `<span class="badge badge-${owner.toLowerCase()}">${escapeHtml(owner)}</span> ` +
      `<span class="name">${escapeHtml(artifact)}</span> ` +
      `<span class="state">${present ? 'present' : 'missing'}</span></li>`
    );
  }).join('\n');

  return [
    `  <article class="incident" data-incident="${escapeHtml(id)}">`,
    `    <h3>${escapeHtml(id)}</h3>`,
    title ? `    <p class="title">${escapeHtml(title)}</p>` : '',
    `    <p class="status">Status: <strong class="status-value">${escapeHtml(status)}</strong></p>`,
    '    <h4>Artifact chain</h4>',
    '    <ul class="artifacts">',
    artifactItems,
    '    </ul>',
    '  </article>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Render the "Recent activity" section from the tail of the board entries. */
function renderRecentActivity(entries) {
  if (entries.length === 0) {
    return [
      '<section class="board">',
      '  <h2>Recent activity</h2>',
      '  <p>No board entries yet.</p>',
      '</section>',
    ].join('\n');
  }

  const rows = entries
    .map((e) => {
      const badge = roleBadge(e);
      return (
        '    <li class="entry">' +
        `<span class="time">${escapeHtml(e.time)}</span> ` +
        `<span class="badge badge-${badge.toLowerCase()}">${escapeHtml(badge)}</span> ` +
        `<span class="who">@${escapeHtml(e.who)}</span> ` +
        `<span class="type">${escapeHtml(e.type)}</span>: ` +
        `<span class="description">${escapeHtml(e.description)}</span></li>`
      );
    })
    .join('\n');

  return [
    '<section class="board">',
    '  <h2>Recent activity</h2>',
    '  <ul class="entries">',
    rows,
    '  </ul>',
    '</section>',
  ].join('\n');
}

/**
 * Render a read-only HTML dashboard for a workspace snapshot.
 *
 * PURE: takes the in-memory snapshot and returns an HTML string. It reads the
 * snapshot only and performs NO disk/network/LLM access and NO writes, so
 * rendering can never modify the Patchwork_Workspace (Requirement 17.3). The
 * page shows each incident's current status (Requirement 17.1), the recent
 * board entries (Requirement 17.2), and the artifact chain, each badged with
 * the Human/SRE/Reviewer/Scribe vocabulary.
 *
 * @param {{ board?: string|null, incidents?: Object<string, Object<string,string>>|null }} snapshot
 * @returns {string} the rendered HTML document.
 */
export function renderDashboard(snapshot) {
  const ws = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const incidents =
    ws.incidents && typeof ws.incidents === 'object' ? ws.incidents : {};

  // Incident ids sorted so the output is deterministic regardless of the
  // snapshot's key insertion order (matches validate()'s determinism stance).
  const incidentSections = Object.keys(incidents)
    .sort()
    .map((id) => renderIncident(id, incidents[id]))
    .join('\n');

  const recent = parseBoardEntries(ws.board).slice(-RECENT_ENTRY_LIMIT);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>Patchwork Room Dashboard</title>',
    '</head>',
    '<body>',
    '  <h1>Patchwork Room Dashboard</h1>',
    '  <p>Read-only view. This page renders workspace files and never modifies them.</p>',
    '  <section class="incidents">',
    '  <h2>Incidents</h2>',
    incidentSections || '  <p>No incidents yet.</p>',
    '  </section>',
    renderRecentActivity(recent),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
