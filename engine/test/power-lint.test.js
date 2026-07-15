// Lint tests for the Kiro Power packaging: POWER.md + mcp.json (task 11.3).
//
// This suite is a "lint" over the REAL packaging artifacts on disk (the repo
// root's POWER.md and mcp.json) and the engine's SERVER_NAME constant. It reads
// the actual files (never a copy), so the lint tracks the shipped Power and
// fails if the packaging guarantees the design promises are ever weakened.
//
// It asserts what task 11.3 calls for:
//   1. POWER.md exists at the repo root and its YAML frontmatter carries every
//      required field, present and non-empty: name, displayName, description,
//      keywords, author (Requirement 13.1).
//   2. `keywords` is a list containing the incident-activation keywords the
//      design specifies — at minimum incident, outage, 500, error, rca,
//      root cause, postmortem, sre (Requirement 13.2).
//   3. mcp.json is well-formed JSON with an `mcpServers` map, and the single
//      server key matches the `name` in POWER.md frontmatter (both "patchwork").
//   4. The mcp.json server key AND the POWER.md name both match SERVER_NAME
//      imported from engine/mcp.js — the true single source of truth all three
//      must agree on (design "Components > 3 Patchwork_MCP_Server": the server
//      name registered there must match the reference in POWER.md and mcp.json).
//   5. mcp.json carries no embedded secrets — env holds key names / plain
//      placeholder values only (Requirement 16.3; design "Security
//      Considerations > No secrets in configuration").
//
// The repo is dependency-light and hand-parses YAML frontmatter in
// engine/core/schema.js (parseIncident). This test reuses that approach with a
// small, purpose-built frontmatter parser rather than adding a YAML dependency:
// POWER.md frontmatter uses quoted string values and a JSON-style array for
// `keywords`, both of which a minimal parser handles.
//
// _Requirements: 13.1, 13.2_

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVER_NAME } from '../mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// engine/test -> engine -> repo root (mirrors onboarding.test.js).
const REPO_ROOT = path.join(__dirname, '..', '..');
const POWER_PATH = path.join(REPO_ROOT, 'POWER.md');
const MCP_PATH = path.join(REPO_ROOT, 'mcp.json');

// The frontmatter fields Requirement 13.1 requires, each present and non-empty.
const REQUIRED_FIELDS = ['name', 'displayName', 'description', 'keywords', 'author'];

// The incident-activation keywords the design pins for Requirement 13.2
// (design "Components > 7 Kiro Power packaging"). These are the MINIMUM set; a
// superset is allowed.
const REQUIRED_KEYWORDS = [
  'incident',
  'outage',
  '500',
  'error',
  'rca',
  'root cause',
  'postmortem',
  'sre',
];

// ---------------------------------------------------------------------------
// Minimal YAML-frontmatter parser (mirrors schema.js parseIncident's approach)
// ---------------------------------------------------------------------------

/**
 * Parse the leading `---` YAML frontmatter block of a Markdown file into a flat
 * key/value map. Values are parsed as either a JSON-style array (when the value
 * starts with `[`) or a scalar with surrounding quotes stripped. This is the
 * same shape POWER.md frontmatter uses; it is intentionally small rather than a
 * general YAML parser (the repo stays dependency-light).
 *
 * @param {string} text full file text, expected to start with a `---` block.
 * @returns {{ data: Record<string, unknown> } | { error: string }}
 */
function parseFrontmatter(text) {
  if (typeof text !== 'string') {
    return { error: 'file text must be a string' };
  }

  const lines = text.split(/\r?\n/);

  // Skip leading blank lines, then require an opening `---` delimiter.
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() !== '---') {
    return { error: 'missing a leading --- frontmatter delimiter' };
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
    return { error: 'frontmatter is not terminated by a closing --- delimiter' };
  }

  const data = {};
  for (let j = start; j < end; j++) {
    const raw = lines[j];
    if (raw.trim() === '') continue;
    const colon = raw.indexOf(':');
    if (colon === -1) continue; // ignore any non "key: value" continuation line
    const key = raw.slice(0, colon).trim();
    data[key] = parseValue(raw.slice(colon + 1));
  }
  return { data };
}

/**
 * Parse a single frontmatter value: a JSON-style array (starts with `[`) is
 * JSON-parsed; a quoted scalar has its surrounding quotes stripped; anything
 * else is returned trimmed.
 *
 * @param {string} rawValue
 * @returns {unknown}
 */
function parseValue(rawValue) {
  const v = rawValue.trim();
  if (v === '') return '';
  if (v[0] === '[') {
    try {
      return JSON.parse(v);
    } catch {
      return v; // leave malformed arrays as-is; the assertion will catch it
    }
  }
  if (v[0] === '"' || v[0] === "'") {
    const quote = v[0];
    const close = v.lastIndexOf(quote);
    if (close > 0) return v.slice(1, close);
    return v.slice(1); // unterminated quote: best effort
  }
  return v;
}

/**
 * Lightweight heuristic for "this env value looks like an embedded secret". A
 * plain placeholder such as "patchwork" is fine; a long high-entropy blob or a
 * value using a known secret marker is not (Requirement 16.3, kept lightweight).
 *
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeSecret(value) {
  const v = String(value);
  if (/(secret|password|passwd|token|api[_-]?key|private[_-]?key)/i.test(v)) {
    return true;
  }
  if (/^sk-/.test(v)) return true; // OpenAI-style secret key prefix
  if (/^AKIA[0-9A-Z]{16}$/.test(v)) return true; // AWS access key id
  // A long, space-free, high-entropy-looking blob (base64/hex-ish, 32+ chars).
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(v)) return true;
  return false;
}

// Read the REAL artifacts once. Parsing here (not from a hard-coded copy) is
// the whole point of a lint: the assertions below track the shipped files.
const powerText = fs.existsSync(POWER_PATH)
  ? fs.readFileSync(POWER_PATH, 'utf8')
  : null;
const parsedPower = powerText === null ? null : parseFrontmatter(powerText);
const power =
  parsedPower && !('error' in parsedPower) ? parsedPower.data : null;

const mcpText = fs.existsSync(MCP_PATH) ? fs.readFileSync(MCP_PATH, 'utf8') : null;

// ---------------------------------------------------------------------------
// Control: the parser actually extracted the frontmatter (non-vacuous guard)
// ---------------------------------------------------------------------------

test('control: POWER.md frontmatter parses into a non-empty field map', () => {
  assert.notEqual(powerText, null, 'POWER.md must be readable at the repo root');
  assert.ok(
    parsedPower && !('error' in parsedPower),
    `POWER.md frontmatter must parse: ${parsedPower && parsedPower.error}`,
  );
  // If this map were empty the required-field tests below would pass vacuously.
  assert.ok(
    Object.keys(power).length >= REQUIRED_FIELDS.length,
    'the parsed frontmatter must contain at least the required fields',
  );
});

// ---------------------------------------------------------------------------
// 1. POWER.md exists with all required frontmatter fields (Requirement 13.1)
// ---------------------------------------------------------------------------

test('POWER.md exists at the repo root (Req 13.1)', () => {
  assert.ok(fs.existsSync(POWER_PATH), 'POWER.md must exist at the repo root');
});

test('POWER.md frontmatter has every required field, present and non-empty (Req 13.1)', () => {
  for (const field of REQUIRED_FIELDS) {
    assert.ok(field in power, `frontmatter is missing required field "${field}"`);

    const value = power[field];
    if (field === 'keywords') {
      assert.ok(
        Array.isArray(value) && value.length > 0,
        '"keywords" must be a non-empty list',
      );
    } else {
      assert.equal(
        typeof value,
        'string',
        `"${field}" must be a string value`,
      );
      assert.notEqual(
        value.trim(),
        '',
        `"${field}" must be present and non-empty`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. keywords includes the incident-activation set (Requirement 13.2)
// ---------------------------------------------------------------------------

test('POWER.md keywords include the incident-activation set (Req 13.2)', () => {
  const keywords = power.keywords;
  assert.ok(Array.isArray(keywords), '"keywords" must be a list');
  for (const kw of REQUIRED_KEYWORDS) {
    assert.ok(
      keywords.includes(kw),
      `keywords must include the activation keyword "${kw}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. mcp.json is well-formed and its server key matches POWER.md name
// ---------------------------------------------------------------------------

test('mcp.json is well-formed JSON with an mcpServers map', () => {
  assert.notEqual(mcpText, null, 'mcp.json must exist at the repo root');
  // JSON.parse throws on malformed JSON, failing the test with a clear message.
  const mcp = JSON.parse(mcpText);
  assert.ok(
    mcp.mcpServers && typeof mcp.mcpServers === 'object' && !Array.isArray(mcp.mcpServers),
    'mcp.json must contain an "mcpServers" object map',
  );
});

test('the mcp.json server key matches the POWER.md frontmatter name (both "patchwork")', () => {
  const mcp = JSON.parse(mcpText);
  const serverKeys = Object.keys(mcp.mcpServers);
  assert.equal(serverKeys.length, 1, 'mcp.json must register exactly one server');

  const serverName = serverKeys[0];
  assert.equal(
    serverName,
    power.name,
    'the mcp.json server key must match POWER.md frontmatter "name"',
  );
});

// ---------------------------------------------------------------------------
// 4. Both match SERVER_NAME from engine/mcp.js (the single source of truth)
// ---------------------------------------------------------------------------

test('mcp.json server key and POWER.md name both match engine SERVER_NAME', () => {
  const mcp = JSON.parse(mcpText);
  const serverName = Object.keys(mcp.mcpServers)[0];

  assert.equal(
    serverName,
    SERVER_NAME,
    `mcp.json server key "${serverName}" must equal engine SERVER_NAME "${SERVER_NAME}"`,
  );
  assert.equal(
    power.name,
    SERVER_NAME,
    `POWER.md name "${power.name}" must equal engine SERVER_NAME "${SERVER_NAME}"`,
  );
});

// ---------------------------------------------------------------------------
// 5. No embedded secrets in mcp.json (Requirement 16.3, lightweight)
// ---------------------------------------------------------------------------

test('mcp.json env holds only plain, non-secret placeholder values (Req 16.3)', () => {
  const mcp = JSON.parse(mcpText);
  const serverName = Object.keys(mcp.mcpServers)[0];
  const env = mcp.mcpServers[serverName].env || {};

  for (const [key, value] of Object.entries(env)) {
    assert.equal(
      typeof value,
      'string',
      `env "${key}" must be a plain string, not a structured/secret value`,
    );
    assert.ok(
      !looksLikeSecret(value),
      `env "${key}" value "${value}" looks like an embedded secret`,
    );
  }
});

test('control: looksLikeSecret flags obvious secrets and clears plain placeholders', () => {
  // Non-vacuous guard: prove the heuristic actually discriminates, so the
  // no-secrets test above cannot pass simply because the check always returns
  // false.
  assert.equal(looksLikeSecret('patchwork'), false);
  assert.equal(looksLikeSecret('sk-abcdef0123456789abcdef0123456789'), true);
  assert.equal(looksLikeSecret('AKIAABCDEFGHIJKLMNOP'), true);
  assert.equal(looksLikeSecret('my-secret-token'), true);
});
