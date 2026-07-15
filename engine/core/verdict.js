// The verdict() / parseVerdict() core commands for the Patchwork Protocol
// Engine (task 3.1).
//
// Like the rest of the core these are pure, deterministic functions: no disk
// access, no wall-clock, and no randomness, so identical inputs always produce
// identical outputs (Requirement 10.6). The CLI (`patchwork verdict`) and the
// MCP server (task 5.1) are thin adapters that read a workspace snapshot and
// call these functions.
//
// This module is the concrete expression of the fail-closed review gate: "no
// usable review can never read as approval" (design "Error Handling › Missing
// or ambiguous verdict"; Requirements 5.2, 5.3, 10.3).
//
// _Requirements: 5.2, 5.3, 10.3_

// ---------------------------------------------------------------------------
// The exact-match rule (fail-closed)
// ---------------------------------------------------------------------------
//
// A "verdict line" is any line whose trimmed text begins, case-insensitively,
// with the token `VERDICT:` (regex VERDICT_LINE_RE below). We deliberately
// recognise typo'd/lowercase verdict lines as verdict lines so a review that
// *tries* to declare a verdict but gets the form wrong still fails closed
// rather than being silently ignored — and so a lowercase or typo'd line can
// still conflict with a canonical one.
//
// parseVerdict(reviewText) returns 'PASS' if and only if BOTH hold:
//   1. there is at least one recognised verdict line, AND
//   2. EVERY recognised verdict line is EXACTLY `VERDICT: PASS` — the canonical
//      token `VERDICT:`, a single ASCII space, then `PASS`, case-sensitive, at
//      the very start of the line. Trailing whitespace / a trailing newline are
//      allowed; a LEADING indent is NOT (an indented `VERDICT: PASS`, e.g.
//      inside a code fence, is not a real verdict and fails closed).
//
// Everything else resolves to 'NEEDS_WORK' (fail-closed). Concretely, each of
// the following yields NEEDS_WORK:
//   - a missing verdict line (no line starts with `VERDICT:`)
//   - a typo:               `VERDICT: PASSED`, `VERDICT: PAS`, `VERDICT: pass`
//   - no space:             `VERDICT:PASS`
//   - extra content:        `VERDICT: PASS (looks good)`, `VERDICT: PASS!`
//   - lowercase keyword:    `verdict: pass`
//   - a leading indent:     `    VERDICT: PASS` (indented / code-fenced)
//   - a NEEDS_WORK verdict: `VERDICT: NEEDS_WORK`
//   - conflicting lines:    a `VERDICT: PASS` together with any other verdict
//                           line that is not exactly `VERDICT: PASS`
//   - a commented-out line: `<!-- VERDICT: PASS -->` or `# VERDICT: PASS`
//                           (its trimmed text does not begin with `VERDICT:`,
//                           so it is not a verdict line at all)
//   - an empty review, or a non-string / unreadable review
//
// Requiring EVERY verdict line to be canonical (rather than only the final one)
// is the strict, fail-closed reading of the design's "conflicting lines ...
// normalized to NEEDS_WORK": if all verdict lines are canonical PASS then the
// final one is PASS and none conflict; if any is not, the review is ambiguous
// and we refuse to read it as approval.
//
// NOTE for task 3.4 (Property 1 — "verdict fails closed for all non-PASS
// inputs"): a generated string yields PASS only when every recognised verdict
// line is exactly `VERDICT: PASS`. A generator asserting NEEDS_WORK must
// therefore avoid producing a review whose sole verdict line(s) are all the
// canonical PASS token.

/** The canonical PASS verdict token, matched exactly (case-sensitive). */
const CANONICAL_PASS = 'VERDICT: PASS';

/**
 * Recognises a "verdict line": a line whose trimmed text begins with the token
 * `VERDICT:` (case-insensitive on the keyword). Used to LOCATE verdict lines
 * and detect conflicts; the PASS decision itself uses the exact CANONICAL_PASS
 * comparison, not this regex.
 */
const VERDICT_LINE_RE = /^VERDICT:/i;

/**
 * Records the reviewer handle. Matches a line like `Reviewer: patchwork-reviewer`
 * (case-insensitive label). A leading `@` on the handle is stripped so it lines
 * up with the fix-proposal author for the Non_Author_Rule (task 3.2).
 */
const REVIEWER_RE = /^\s*Reviewer:\s*@?(.+?)\s*$/i;

/**
 * Records the fix version the review evaluated. Matches a line like
 * `Fix-Version: 1` (case-insensitive label). See parseFixVersion for coercion.
 */
const FIX_VERSION_RE = /^\s*Fix-Version:\s*(.+?)\s*$/i;

/**
 * Parse the review text and normalise it to a fail-closed verdict.
 *
 * @param {string} reviewText full contents of review.md (or any string).
 * @returns {'PASS'|'NEEDS_WORK'} 'PASS' only when every recognised verdict line
 *   is exactly `VERDICT: PASS`; 'NEEDS_WORK' for anything missing, malformed,
 *   conflicting, empty, or unreadable (fail-closed).
 */
export function parseVerdict(reviewText) {
  // An unreadable / non-string review can never read as approval.
  if (typeof reviewText !== 'string') return 'NEEDS_WORK';

  let sawVerdictLine = false;
  for (const rawLine of reviewText.split(/\r?\n/)) {
    // Detect a verdict line leniently (leading-indent tolerant) so an indented
    // or typo'd attempt still counts — and can therefore conflict / fail closed
    // rather than being silently skipped.
    if (!VERDICT_LINE_RE.test(rawLine.trim())) continue;
    sawVerdictLine = true;
    // Classify strictly: compare against the canonical token after stripping
    // ONLY trailing whitespace, so a leading indent, a typo, lowercase, extra
    // content, NEEDS_WORK, or a conflict with a canonical PASS all fail closed.
    if (rawLine.replace(/\s+$/, '') !== CANONICAL_PASS) return 'NEEDS_WORK';
  }

  // PASS requires at least one verdict line, and (by the loop above) every
  // verdict line was exactly canonical PASS.
  return sawVerdictLine ? 'PASS' : 'NEEDS_WORK';
}

// ---------------------------------------------------------------------------
// The review.md author / fix-version convention
// ---------------------------------------------------------------------------
//
// review.md records the two facts the gate needs to bind a review to a fix
// (task 3.2: Non_Author_Rule + review-to-fix binding) as two explicit,
// case-insensitive metadata lines placed near the top of the file:
//
//     Reviewer: patchwork-reviewer
//     Fix-Version: 1
//
//     # Review
//     ...adversarial findings...
//     VERDICT: PASS
//
// This convention is deliberately the simplest thing that works: two labelled
// lines the Reviewer_Agent (task 8.1) emits and the gate parses, with no
// frontmatter-delimiter edge cases. The first `Reviewer:` line and the first
// `Fix-Version:` line win; a leading `@` on the reviewer handle is stripped so
// it matches the fix-proposal author handle. When a line is absent the field is
// left undefined and the gate treats the review as unbindable (fail-closed).
//
// This is the source-of-truth note for task 8.1 (which authors review.md) and
// task 3.2 (which reads author/fixVersion off verdict() to enforce the gate).

/**
 * Coerce a Fix-Version scalar to an integer when it looks like one, mirroring
 * schema.parseIncident's fix_version handling so a review's fix version and an
 * incident's `fix_version` compare with `===` in the task-3.2 binding check.
 * (The design annotates fixVersion as a string; we coerce integer-like values
 * to numbers so the binding comparison is robust. Non-integer values pass
 * through unchanged.)
 *
 * @param {string} value the raw captured Fix-Version text.
 * @returns {number|string} an integer when integer-like, else the trimmed text.
 */
function parseFixVersion(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

/**
 * Parse a review into its fail-closed verdict plus the recorded reviewer and
 * fix version, when present.
 *
 * @param {string} reviewText full contents of review.md (or any string).
 * @returns {{ verdict: 'PASS'|'NEEDS_WORK', author?: string, fixVersion?: number|string }}
 *   `verdict` is always present (see parseVerdict). `author` and `fixVersion`
 *   are included only when their metadata line is present; otherwise the keys
 *   are omitted so a consumer can tell "not recorded" from a real value.
 */
export function verdict(reviewText) {
  const result = { verdict: parseVerdict(reviewText) };

  if (typeof reviewText !== 'string') return result;

  for (const rawLine of reviewText.split(/\r?\n/)) {
    if (result.author === undefined) {
      const m = REVIEWER_RE.exec(rawLine);
      if (m && m[1].trim() !== '') {
        result.author = m[1].trim();
        continue;
      }
    }
    if (result.fixVersion === undefined) {
      const m = FIX_VERSION_RE.exec(rawLine);
      if (m && m[1].trim() !== '') {
        result.fixVersion = parseFixVersion(m[1].trim());
      }
    }
  }

  return result;
}
