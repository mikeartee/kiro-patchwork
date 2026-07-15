// Config-lint tests for the patchwork-reviewer custom agent (task 8.4).
//
// This suite is a "lint" over the REAL agent configs on disk
// (.kiro/agents/patchwork-reviewer.json and .kiro/agents/patchwork-sre.json).
// It reads the actual JSON files (never a copy), so the lint tracks the shipped
// configs and fails if the guarantees the design promises are ever weakened.
//
// It asserts the two things task 8.4 calls for:
//   1. Write scope is review.md only (Req 5.5) — fs_write.allowedPaths is
//      exactly ["patchwork/incidents/**/review.md"], and the Reviewer CANNOT
//      write any other artifact. The check is behavioral, not string-matching:
//      a small glob matcher simulates the write-scoping decision so that
//      review.md is writable while board.md, incident.md, analysis.md,
//      fix-proposal.md, decision-log.md, and postmortem.md are all denied and
//      outside the allow scope. The key guarantee is that the Reviewer must
//      NOT be able to write board.md or any artifact other than review.md.
//   2. Different model family from the SRE (Req 5.4) — both configs' `model`
//      fields are read and classified into a model FAMILY (not just compared
//      as strings), then asserted to be different families with neither being
//      "unknown". Classifying into families makes the lint robust: if the
//      Reviewer were ever switched to another Claude model, the SRE and
//      Reviewer would share the "anthropic" family and this test would fail.
//
// _Requirements: 5.4, 5.5_

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// engine/test -> engine -> repo root -> .kiro/agents/<agent>.json
const AGENTS_DIR = path.join(__dirname, '..', '..', '.kiro', 'agents');
const REVIEWER_CONFIG_PATH = path.join(AGENTS_DIR, 'patchwork-reviewer.json');
const SRE_CONFIG_PATH = path.join(AGENTS_DIR, 'patchwork-sre.json');

const INC = 'INC-2024-001';

// Read the REAL configs once. Parsing here (not from a hard-coded copy) is the
// whole point of a config-lint: the assertions below track the shipped files.
const reviewerConfig = JSON.parse(fs.readFileSync(REVIEWER_CONFIG_PATH, 'utf8'));
const sreConfig = JSON.parse(fs.readFileSync(SRE_CONFIG_PATH, 'utf8'));

function reviewerFsWrite() {
  return (
    (reviewerConfig.toolsSettings && reviewerConfig.toolsSettings.fs_write) || {}
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Convert a gitignore-style glob (as used in toolsSettings path lists) into an
// anchored RegExp. `**` matches across path separators, `*` matches within a
// single segment, and regex metacharacters are escaped. This lets the test
// simulate the actual write-scoping decision rather than string-matching the
// pattern text, so the assertions stay honest about what the config permits.
function globToRegExp(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        // '**/' — the leading directory portion is optional.
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (c === '*') {
      re += '[^/]*';
      i += 1;
    } else if ('\\^$+?.()|{}[]'.includes(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchesAny(patterns, candidate) {
  return patterns.some((p) => globToRegExp(String(p)).test(candidate));
}

// Map a model id to its model family. Anchored, lower-cased prefix matching so
// any versioned member of a family (e.g. claude-sonnet-4, claude-opus-4) maps
// to the same family. Anything unrecognized maps to "unknown", which the
// model-family test treats as a failure so a mystery model can never silently
// satisfy the "different family" requirement.
function modelFamily(model) {
  const id = String(model || '').trim().toLowerCase();
  if (/^(claude|anthropic)/.test(id)) return 'anthropic';
  if (/^glm/.test(id)) return 'zhipu';
  if (/^(gpt|o1|o3)/.test(id)) return 'openai';
  if (/^gemini/.test(id)) return 'google';
  if (/^deepseek/.test(id)) return 'deepseek';
  if (/^minimax/.test(id)) return 'minimax';
  if (/^qwen/.test(id)) return 'qwen';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// 1. Write scope is review.md only (Requirement 5.5)
// ---------------------------------------------------------------------------

test('Reviewer config: fs_write.allowedPaths is exactly ["patchwork/incidents/**/review.md"] (Req 5.5)', () => {
  assert.deepEqual(
    reviewerFsWrite().allowedPaths,
    ['patchwork/incidents/**/review.md'],
    'the Reviewer must be write-scoped to the incident review.md only',
  );
});

test('Reviewer scope: an incident review.md is within the allowed write scope (Req 5.5)', () => {
  const allowed = reviewerFsWrite().allowedPaths || [];
  assert.ok(
    matchesAny(allowed, `patchwork/incidents/${INC}/review.md`),
    'the incident review.md must be writable by the Reviewer',
  );
});

// The other five incident artifacts plus the Board. The key guarantee of 5.5
// is that the Reviewer writes review.md and NOTHING else — so each of these
// must be both outside the allow scope AND explicitly covered by deniedPaths.
const OTHER_ARTIFACTS = [
  'board.md',
  'incident.md',
  'analysis.md',
  'fix-proposal.md',
  'decision-log.md',
  'postmortem.md',
];

test('Reviewer scope: every non-review artifact is outside the allow scope and explicitly denied (Req 5.5)', () => {
  const allowed = reviewerFsWrite().allowedPaths || [];
  const denied = reviewerFsWrite().deniedPaths || [];
  for (const artifact of OTHER_ARTIFACTS) {
    const p = `patchwork/incidents/${INC}/${artifact}`;
    assert.ok(
      !matchesAny(allowed, p),
      `allow scope must NOT grant ${artifact}, but it matched "${p}"`,
    );
    assert.ok(
      matchesAny(denied, p),
      `deniedPaths must include a pattern covering ${artifact}, but nothing matched "${p}"`,
    );
  }
});

test('Reviewer scope: board.md cannot be written (Req 5.5, key guarantee)', () => {
  const allowed = reviewerFsWrite().allowedPaths || [];
  const denied = reviewerFsWrite().deniedPaths || [];
  // Both the top-level Board and any incident-scoped board.md must be blocked.
  for (const p of ['patchwork/board.md', `patchwork/incidents/${INC}/board.md`]) {
    assert.ok(
      !matchesAny(allowed, p),
      `the Reviewer must NOT be able to write "${p}"`,
    );
    assert.ok(
      matchesAny(denied, p),
      `deniedPaths must explicitly block "${p}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Different model family from the SRE (Requirement 5.4)
// ---------------------------------------------------------------------------

test('Reviewer runs on a different model family from the SRE (Req 5.4)', () => {
  const reviewerFamily = modelFamily(reviewerConfig.model);
  const sreFamily = modelFamily(sreConfig.model);

  assert.notEqual(
    reviewerFamily,
    'unknown',
    `reviewer model "${reviewerConfig.model}" was not classified into a known family`,
  );
  assert.notEqual(
    sreFamily,
    'unknown',
    `sre model "${sreConfig.model}" was not classified into a known family`,
  );
  assert.notEqual(
    reviewerFamily,
    sreFamily,
    `Reviewer (${reviewerConfig.model} -> ${reviewerFamily}) and SRE ` +
      `(${sreConfig.model} -> ${sreFamily}) must run on different model families`,
  );
});

test('modelFamily helper: classifies known ids and is stable within a family (control)', () => {
  // Non-vacuous guard: prove the classifier actually groups models rather than
  // returning a unique value per id. If it did the latter, the 5.4 test above
  // would pass vacuously.
  assert.equal(modelFamily('claude-sonnet-4'), 'anthropic');
  assert.equal(modelFamily('glm-5'), 'zhipu');
  assert.equal(modelFamily('gpt-4o'), 'openai');
  assert.equal(modelFamily('made-up-model'), 'unknown');
  // Two Claude models share a family, so the lint above would FAIL if the
  // Reviewer were ever switched to another Claude model — this is what makes
  // the "different family" guarantee robust.
  assert.equal(modelFamily('claude-sonnet-4'), modelFamily('claude-opus-4'));
});
