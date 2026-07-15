// Workspace-snapshot generators for the Patchwork property tests, built on the
// seeded Rng from ./pbt.js. This is the "generators useful here" layer the
// design's Testing Strategy calls for. It is intentionally small and focused on
// what Property 3 (task 1.6) needs — random workspace snapshots (a mix of valid
// and invalid content) plus the order-independent shuffle that Property 3
// asserts is verdict-preserving.
//
// Reuse note: tasks 2.4 (random {from,to} status pairs) and 3.4 (random non-PASS
// strings) will add their own generators here, sharing the Rng/forAll core in
// ./pbt.js. Keep additions equally small and focused.

import { INCIDENT_STATUSES } from '../../core/schema.js';
import { RESOLUTION_ARTIFACTS } from '../../core/validate.js';
import { TRANSITIONS } from '../../core/gate.js';

// Separators used by the board-entry and remediation-step grammars.
const DOT = '\u00B7'; // middle dot between board-entry fields
const DASH = '\u2014'; // em dash before a remediation "verify:" clause

const WHOS = [
  'alice',
  'bob',
  'carol',
  'patchwork-sre',
  'patchwork-reviewer',
  'patchwork-scribe',
];
const ROLES = ['Incident Commander', 'SRE', 'Reviewer', 'Scribe'];
const KINDS = ['human', 'agent'];
const TYPES = ['report', 'analysis', 'verdict', 'decision', 'note', 'fix'];

// Short free-text fragments with no ":" or middle-dot, so they never collide
// with the board-entry / remediation grammars in surprising ways.
const PHRASES = [
  'root cause found',
  'checkout 500s on coupon stacking',
  'needs work',
  'looks good',
  'null branch missed',
  'reproduction test passes',
  '',
];

function genTime(rng) {
  const hh = String(rng.int(0, 23)).padStart(2, '0');
  const mm = String(rng.int(0, 59)).padStart(2, '0');
  return `2024-06-01T${hh}:${mm}Z`;
}

function genPhrase(rng) {
  return rng.pick(PHRASES);
}

// --- board lines -----------------------------------------------------------

/** A well-formed board timeline entry. */
function genValidBoardEntry(rng) {
  return (
    `[${genTime(rng)}] @${rng.pick(WHOS)} ${DOT} ` +
    `${rng.pick(ROLES)} (${rng.pick(KINDS)}) ${DOT} ` +
    `${rng.pick(TYPES)}: ${genPhrase(rng)}`
  );
}

/** A board timeline entry (starts with "[") that breaks the grammar. */
function genInvalidBoardEntry(rng) {
  const t = genTime(rng);
  const who = rng.pick(WHOS);
  const role = rng.pick(ROLES);
  const kind = rng.pick(KINDS);
  const type = rng.pick(TYPES);
  const phrase = genPhrase(rng);
  switch (rng.int(0, 3)) {
    case 0: // missing @author
      return `[${t}] ${role} (${kind}) ${DOT} ${type}: ${phrase}`;
    case 1: // missing "Role (human|agent)"
      return `[${t}] @${who} ${DOT} ${type}: ${phrase}`;
    case 2: // missing "type:" field (no colon in the trailing text)
      return `[${t}] @${who} ${DOT} ${role} (${kind}) ${DOT} ${phrase}`;
    default: // fields present but missing the separator after @who -> malformed
      return `[${t}] @${who} ${role} (${kind}) ${DOT} ${type}: ${phrase}`;
  }
}

// A prose / header line: never starts with "[", so validate treats it as a
// non-timeline line and skips it regardless of position.
const PROSE_LINES = [
  '# Patchwork Board',
  '',
  `Entry format: [time] @who ${DOT} Role (human|agent) ${DOT} type: desc`,
  'Some running notes about the incident room.',
  '## History',
];

function genProseLine(rng) {
  return rng.pick(PROSE_LINES);
}

/** A board.md body mixing prose lines, valid entries, and invalid entries. */
function genBoard(rng) {
  const lines = [];
  if (rng.bool(0.7)) lines.push('# Patchwork Board');
  if (rng.bool(0.5)) lines.push('');
  const n = rng.int(0, 6);
  for (let i = 0; i < n; i++) {
    switch (rng.int(0, 2)) {
      case 0:
        lines.push(genProseLine(rng));
        break;
      case 1:
        lines.push(genValidBoardEntry(rng));
        break;
      default:
        lines.push(genInvalidBoardEntry(rng));
    }
  }
  return lines.join('\n');
}

// --- remediation steps / fix-proposal --------------------------------------

function genValidRemediation(rng) {
  const tag = rng.pick(['AFK', 'HITL']);
  const action = genPhrase(rng) || 'revert the bad commit';
  const check = genPhrase(rng) || 'reproduction test passes';
  return `- [${tag}] ${action} ${DASH} verify: ${check}`;
}

function genInvalidRemediation(rng) {
  const tag = rng.pick(['AFK', 'HITL']);
  const action = genPhrase(rng) || 'revert the bad commit';
  const check = genPhrase(rng) || 'reproduction test passes';
  if (rng.bool()) {
    // Missing tag, but keeps a "verify:" clause so validate still flags it.
    return `- ${action} verify: ${check}`;
  }
  // Has a tag, but no "verify:" clause.
  return `- [${tag}] ${action}`;
}

function genFixProposal(rng) {
  const lines = ['# Fix Proposal', '', 'Proposed fix with tagged steps.', ''];
  const n = rng.int(0, 4);
  for (let i = 0; i < n; i++) {
    lines.push(rng.bool(0.7) ? genValidRemediation(rng) : genInvalidRemediation(rng));
  }
  return lines.join('\n');
}

// --- incident.md frontmatter ------------------------------------------------

function frontmatter(fields) {
  return ['---', ...fields, '---', ''].join('\n');
}

/**
 * Generate an incident.md case. Returns `{ text, status }` where:
 *   - `text` is the file contents, or `undefined` to mean "incident.md absent"
 *   - `status` is the effective valid status when the frontmatter parses, else
 *     `undefined` (used to decide whether the resolution-artifact set applies)
 */
function genIncidentMdCase(rng) {
  const id = `INC-2024-${String(rng.int(1, 999)).padStart(3, '0')}`;
  const title = genPhrase(rng) || 'Checkout endpoint returns 500';
  const fixVersion = rng.int(1, 3);

  switch (rng.int(0, 9)) {
    case 8:
      // Unknown status value -> incident.status.unknown; not a valid status.
      return {
        text: frontmatter([
          `id: ${id}`,
          `title: ${title}`,
          'status: FIXING_IT_NOW',
          `fix_version: ${fixVersion}`,
        ]),
        status: undefined,
      };
    case 9:
      // No frontmatter at all -> incident.frontmatter.missing.
      return { text: '# Incident\n\nNo frontmatter block here.\n', status: undefined };
    default: {
      // Valid frontmatter with a known status.
      const status = rng.pick(INCIDENT_STATUSES);
      return {
        text: frontmatter([
          `id: ${id}`,
          `title: ${title}`,
          `status: ${status}`,
          `fix_version: ${fixVersion}`,
        ]),
        status,
      };
    }
  }
}

const ARTIFACT_CONTENT = {
  'analysis.md': '# Analysis\n',
  'fix-proposal.md': '# Fix Proposal\n',
  'review.md': 'VERDICT: PASS\n',
  'decision-log.md': '# Decision Log\n',
  'postmortem.md': '# Post-mortem\n',
};

/** Generate one incident's artifact-file map (a mix of complete and partial). */
function genIncidentFiles(rng) {
  const files = {};
  const incidentCase = genIncidentMdCase(rng);

  // ~15% of the time incident.md is absent entirely (workspace.artifact.missing).
  if (incidentCase.text !== undefined && rng.bool(0.85)) {
    files['incident.md'] = incidentCase.text;
  }

  if (rng.bool(0.6)) files['fix-proposal.md'] = genFixProposal(rng);
  if (rng.bool(0.5)) files['analysis.md'] = ARTIFACT_CONTENT['analysis.md'];

  // A RESOLVED incident should hold the full artifact set; sometimes drop some
  // to produce resolution-stage missing-artifact problems.
  if (incidentCase.status === 'RESOLVED' && files['incident.md'] !== undefined) {
    const full = rng.bool(0.5);
    for (const artifact of RESOLUTION_ARTIFACTS) {
      if (artifact === 'incident.md') continue;
      if (full || rng.bool(0.6)) {
        files[artifact] = ARTIFACT_CONTENT[artifact] ?? `# ${artifact}\n`;
      }
    }
  }

  return files;
}

/**
 * Generate a random workspace snapshot: a mix of present/absent scaffold, and
 * zero or more incidents with valid and invalid content.
 * @param {import('./pbt.js').Rng} rng
 */
export function genWorkspace(rng) {
  const ws = {};

  // ~15% of the time the board is absent (workspace.board.missing).
  if (rng.bool(0.85)) ws.board = genBoard(rng);

  // ~15% of the time the incidents directory is absent (workspace.incidents.missing).
  if (rng.bool(0.85)) {
    const count = rng.int(0, 4);
    const incidents = {};
    const usedIds = new Set();
    for (let i = 0; i < count; i++) {
      let id;
      do {
        id = `INC-2024-${String(rng.int(1, 999)).padStart(3, '0')}`;
      } while (usedIds.has(id));
      usedIds.add(id);
      incidents[id] = genIncidentFiles(rng);
    }
    ws.incidents = incidents;
  }

  return ws;
}

// Rebuild an incident's file map with its keys in shuffled insertion order.
// validate() reads artifact files by explicit key, so key order must not affect
// the verdict — this is one of the order-independent transforms Property 3 tests.
function shuffleIncidentFiles(rng, files) {
  if (!files || typeof files !== 'object') return files;
  const out = {};
  for (const key of rng.shuffle(Object.keys(files))) {
    out[key] = files[key];
  }
  return out;
}

/**
 * Produce a verdict-equivalent reordering of a workspace snapshot by permuting
 * only order-independent content:
 *   - board.md timeline lines (each line yields at most one independent problem)
 *   - the insertion order of the incidents map (validate sorts incident ids)
 *   - the key order within each incident's file map (accessed by explicit key)
 *
 * It never changes any line's text, any file's contents, the set of incident
 * ids, or scaffold presence — so validate's verdict (ok + the multiset of
 * problems) must be identical. Structurally fresh objects are returned so the
 * original snapshot is never mutated.
 *
 * @param {import('./pbt.js').Rng} rng
 * @param {object} ws
 */
export function shuffleWorkspace(rng, ws) {
  const out = {};

  if ('board' in ws) {
    out.board =
      typeof ws.board === 'string'
        ? rng.shuffle(ws.board.split(/\r?\n/)).join('\n')
        : ws.board;
  }

  if ('incidents' in ws) {
    if (ws.incidents && typeof ws.incidents === 'object') {
      const incidents = {};
      for (const id of rng.shuffle(Object.keys(ws.incidents))) {
        incidents[id] = shuffleIncidentFiles(rng, ws.incidents[id]);
      }
      out.incidents = incidents;
    } else {
      out.incidents = ws.incidents;
    }
  }

  return out;
}

// --- state-machine transition pairs (task 2.4, Property 2) -----------------
// Random {from, to} status pairs for the gate() property test. The property is
// non-vacuous only if the generated stream exercises BOTH allowed and rejected
// outcomes, so the mix is deliberately biased (documented per branch):
//   ~40% a legal edge lifted straight from TRANSITIONS -> guarantees allowed
//        cases exist, so the biconditional cannot pass vacuously.
//   ~40% two independent known Incident_Status values  -> mostly illegal pairs
//        between real statuses, with the occasional legal edge by chance.
//   ~20% at least one unknown/typo status string       -> always rejected.
// TRANSITIONS is the shared source of truth the gate consults, so a pair drawn
// from it is legal by construction.

// Typo'd / unknown status strings — none are members of INCIDENT_STATUSES, so
// any pair containing one can never be in the transition table (always rejected
// with an "unknown incident status" reason). Includes a trailing-space and a
// case-mismatch variant to exercise the exact-match enum check.
const UNKNOWN_STATUSES = [
  'NOT_A_STATUS',
  'FIXING_IT_NOW',
  'reported', // case mismatch of a real status
  'RESOLVED ', // trailing space -> not an exact enum member
  'DONE',
  'FOO',
  '',
];

/**
 * A {from, to} pair where at least one side is an unknown/typo status, so the
 * pair is never a defined transition. Used both inside the biased mix and on
 * its own to assert unknown-status pairs are never allowed.
 * @param {import('./pbt.js').Rng} rng
 * @returns {{ from: string, to: string }}
 */
export function genUnknownStatusPair(rng) {
  // 0 = only `from` unknown, 1 = only `to` unknown, 2 = both unknown.
  const which = rng.int(0, 2);
  const side = (unknown) =>
    unknown ? rng.pick(UNKNOWN_STATUSES) : rng.pick(INCIDENT_STATUSES);
  return { from: side(which !== 1), to: side(which !== 0) };
}

/**
 * A random {from, to} Incident_Status pair for Property 2, biased so the stream
 * exercises legal edges, illegal-but-known pairs, and unknown-status pairs (see
 * the mix documented above).
 * @param {import('./pbt.js').Rng} rng
 * @returns {{ from: string, to: string }}
 */
export function genTransitionPair(rng) {
  const bucket = rng.int(0, 9);
  if (bucket < 4) {
    // ~40%: a legal edge straight from the transition table.
    const [from, to] = rng.pick(TRANSITIONS);
    return { from, to };
  }
  if (bucket < 8) {
    // ~40%: two independent known statuses (mostly illegal pairs).
    return { from: rng.pick(INCIDENT_STATUSES), to: rng.pick(INCIDENT_STATUSES) };
  }
  // ~20%: at least one unknown/typo status.
  return genUnknownStatusPair(rng);
}

// --- verdict review strings (task 3.4, Property 1) -------------------------
// Random review.md bodies for the parseVerdict() property test. Property 1
// states: for any string that is NOT exactly the canonical `VERDICT: PASS`
// line, parseVerdict returns NEEDS_WORK (fail-closed). "Not exactly the
// canonical line" must be read against verdict.js's documented exact-match
// rule: a review parses to PASS ONLY WHEN it has at least one recognised
// verdict line AND every recognised verdict line is exactly `VERDICT: PASS`
// (canonical token, single ASCII space, no leading indent, only trailing
// whitespace allowed). A review can therefore carry prose and still PASS.
//
// So the faithful generator produces "non-approving" reviews that, BY
// CONSTRUCTION, can never satisfy that rule, and the property asserts
// parseVerdict returns NEEDS_WORK for all of them. genApprovingReview is the
// mirror image — reviews that DO satisfy the rule — used by the positive sanity
// set to prove the property is non-vacuous (parseVerdict CAN return PASS).

// An INDEPENDENT re-implementation of verdict.js's exact-match PASS rule, used
// ONLY as a construction safeguard and cross-check oracle. It is deliberately
// NOT the function under test: the property tests import parseVerdict from the
// core, while this local oracle lets a generator guarantee it never emits an
// approving review without depending on the code it is meant to test.
export function wouldParsePass(text) {
  if (typeof text !== 'string') return false;
  let sawVerdictLine = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!/^\s*VERDICT:/i.test(rawLine)) continue; // trim-tolerant detection
    sawVerdictLine = true;
    if (rawLine.replace(/\s+$/, '') !== 'VERDICT: PASS') return false;
  }
  return sawVerdictLine;
}

// Neutralise a line that would accidentally read as a verdict line, so a family
// that is meant to contain NO verdict line (or only controlled ones) cannot be
// polluted by a stray `VERDICT:`-prefixed phrase/garbage line.
function stripVerdictPrefix(line) {
  return /^\s*VERDICT:/i.test(line) ? `note: ${line}` : line;
}

// Recognised verdict lines that are NOT the canonical PASS. Every entry is a
// verdict line (its trimmed text begins with `VERDICT:`) yet differs from
// `VERDICT: PASS` after trailing-whitespace is stripped, so any review whose
// verdict lines include at least one of these fails closed to NEEDS_WORK. This
// pool is the near-miss / typo / conflict material reused across families.
const NON_PASS_VERDICT_LINES = [
  'VERDICT: NEEDS_WORK',
  'VERDICT: NEEDS WORK',
  'VERDICT: FAIL',
  'VERDICT: PASSED', // typo (extra letter)
  'VERDICT: PAS', // typo (missing letter)
  'VERDICT:PASS', // no space after colon
  'VERDICT:  PASS', // two spaces after colon
  'VERDICT: pass', // lowercase value
  'verdict: pass', // lowercase keyword + value
  'Verdict: Pass', // mixed case
  'VERDICT: PASS.', // trailing punctuation (not trailing whitespace)
  'VERDICT: PASS ok', // extra trailing content
  'VERDICT: PASS (looks good)',
  'VERDICT: PASS!',
  '   VERDICT: PASS', // leading indent (e.g. inside a list/code fence)
  '\tVERDICT: PASS', // leading tab indent
  'VERDICT: MAYBE',
  'VERDICT:', // keyword only, no value
];

// Canonical-looking PASS lines that are NOT recognised as verdict lines because
// their trimmed text begins with a comment/quote marker, not `VERDICT:`. On
// their own (no other verdict line) a review holding only these has NO verdict
// line at all, so it fails closed.
const COMMENTED_PASS_LINES = [
  '# VERDICT: PASS', // markdown heading / shell comment
  '<!-- VERDICT: PASS -->', // html comment
  '> VERDICT: PASS', // blockquote
  '// VERDICT: PASS', // line comment
  '* VERDICT: PASS', // list bullet
];

// Whitespace-only / empty reviews: no verdict line, so NEEDS_WORK.
const BLANK_TEXTS = ['', '   ', '\n\n', '\t', '  \n  \n', '\r\n\r\n'];

// Characters for the "random garbage / unicode" family. Includes grammar-ish
// punctuation (":", "#", "<", ">") and a few non-ASCII code points so the
// family probes bytes the parser will never treat as a canonical PASS.
const GARBAGE_CHARS = [
  'a', 'B', 'z', 'Q', '0', '7', ' ', ':', '#', '<', '>', '-', '.', '!', '/',
  '\t', '\u00e9', '\u2603', '\u{1F4A5}', '\u03c0',
];

function genGarbageLine(rng) {
  const len = rng.int(0, 24);
  let s = '';
  for (let i = 0; i < len; i++) s += rng.pick(GARBAGE_CHARS);
  return s;
}

// Family: no verdict line at all — random prose/garbage, with any stray
// `VERDICT:`-prefixed line neutralised so the family truly has none.
function genNoVerdictText(rng) {
  const lines = [];
  const n = rng.int(0, 6);
  for (let i = 0; i < n; i++) {
    lines.push(rng.bool(0.5) ? genPhrase(rng) : genGarbageLine(rng));
  }
  return lines.map(stripVerdictPrefix).join('\n');
}

// Family: at least one NON-canonical verdict line (typo / near-miss / lowercase
// / indented / NEEDS_WORK), optionally surrounded by prose. Prose is stripped
// of verdict prefixes so the only recognised verdict lines are non-canonical.
function genNonCanonicalVerdictText(rng) {
  const lines = [];
  const pre = rng.int(0, 3);
  for (let i = 0; i < pre; i++) {
    lines.push(stripVerdictPrefix(rng.bool() ? genPhrase(rng) : genGarbageLine(rng)));
  }
  const k = rng.int(1, 3);
  for (let i = 0; i < k; i++) lines.push(rng.pick(NON_PASS_VERDICT_LINES));
  if (rng.bool(0.4)) lines.push(stripVerdictPrefix(genPhrase(rng)));
  return lines.join('\n');
}

// Family: commented-out / quoted canonical PASS lines only — none is a
// recognised verdict line, so the review has no verdict line and fails closed.
function genCommentedOutText(rng) {
  const lines = [];
  const pre = rng.int(0, 2);
  for (let i = 0; i < pre; i++) lines.push(stripVerdictPrefix(genPhrase(rng)));
  const k = rng.int(1, 2);
  for (let i = 0; i < k; i++) lines.push(rng.pick(COMMENTED_PASS_LINES));
  if (rng.bool(0.3)) lines.push(stripVerdictPrefix(genPhrase(rng)));
  return lines.join('\n');
}

// Family: CONFLICTING — a real canonical `VERDICT: PASS` line together with at
// least one other, non-canonical verdict line. This is the subtle case: the
// review DOES contain the canonical token, yet must still fail closed because
// not every verdict line is canonical.
function genConflictingText(rng) {
  const lines = [];
  if (rng.bool(0.5)) lines.push(stripVerdictPrefix(genPhrase(rng)));
  const verdictLines = ['VERDICT: PASS', rng.pick(NON_PASS_VERDICT_LINES)];
  if (rng.bool(0.3)) verdictLines.push('VERDICT: PASS'); // multiple canonical + a conflict
  for (const vl of rng.shuffle(verdictLines)) lines.push(vl);
  if (rng.bool(0.3)) lines.push(stripVerdictPrefix(genPhrase(rng)));
  return lines.join('\n');
}

// Family: empty / whitespace-only review.
function genBlankText(rng) {
  return rng.pick(BLANK_TEXTS);
}

// Family: random unicode / garbage lines.
function genGarbageText(rng) {
  const n = rng.int(0, 6);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(genGarbageLine(rng));
  return lines.join('\n');
}

const NON_APPROVING_FAMILIES = [
  ['no-verdict', genNoVerdictText],
  ['non-canonical-verdict', genNonCanonicalVerdictText],
  ['commented-out', genCommentedOutText],
  ['conflicting', genConflictingText],
  ['blank', genBlankText],
  ['garbage', genGarbageText],
];

/**
 * Generate a review string that, by construction, is NOT approving: parseVerdict
 * must return NEEDS_WORK for it. Returns `{ family, text }` so the property test
 * can assert every family was exercised (coverage / non-vacuity) and so a
 * failing example names the family it came from.
 *
 * Belt-and-suspenders safeguard: none of the families above can emit an
 * all-canonical-PASS review; the garbage family is the only one that could even
 * theoretically stumble onto one. We re-check every generated text with the
 * INDEPENDENT wouldParsePass oracle (not the function under test) and, on the
 * astronomically unlikely hit, force it non-approving by appending a
 * non-canonical verdict line — keeping the invariant "the emitted review is NOT
 * approving" true for every input.
 *
 * @param {import('./pbt.js').Rng} rng
 * @returns {{ family: string, text: string }}
 */
export function genNonApprovingReview(rng) {
  const [family, gen] = rng.pick(NON_APPROVING_FAMILIES);
  let text = gen(rng);
  if (wouldParsePass(text)) {
    text = `${text}\nVERDICT: NEEDS_WORK`;
    return { family: `${family}+safeguard`, text };
  }
  return { family, text };
}

// Canonical PASS lines that parseVerdict accepts: exactly `VERDICT: PASS`, with
// only trailing whitespace allowed (stripped by the parser), never a leading
// indent.
const PASS_LINE_VARIANTS = [
  'VERDICT: PASS',
  'VERDICT: PASS ', // trailing space allowed
  'VERDICT: PASS\t', // trailing tab allowed
  'VERDICT: PASS   ', // trailing spaces allowed
];

/**
 * Generate a review string that IS approving: random prose plus optional
 * Reviewer/Fix-Version metadata lines and exactly ONE recognised verdict line,
 * the canonical `VERDICT: PASS` (optionally with trailing whitespace/newline).
 * parseVerdict must return PASS. Used by the positive sanity set to prove the
 * property is non-vacuous — that parseVerdict CAN return PASS and the generator
 * boundary is correct.
 *
 * @param {import('./pbt.js').Rng} rng
 * @returns {string}
 */
export function genApprovingReview(rng) {
  const lines = [];
  if (rng.bool(0.7)) lines.push('# Review');
  if (rng.bool(0.5)) lines.push(`Reviewer: @${rng.pick(WHOS)}`);
  if (rng.bool(0.5)) lines.push(`Fix-Version: ${rng.int(1, 5)}`);
  if (rng.bool(0.6)) lines.push('');
  const n = rng.int(0, 4);
  for (let i = 0; i < n; i++) {
    lines.push(stripVerdictPrefix(genPhrase(rng) || 'tried to refute the fix'));
  }
  // Exactly one recognised verdict line, canonical PASS, placed last per the
  // review.md convention (order is not required by the rule, only canonicality).
  lines.push(rng.pick(PASS_LINE_VARIANTS));
  return lines.join('\n') + (rng.bool(0.3) ? '\n' : '');
}
