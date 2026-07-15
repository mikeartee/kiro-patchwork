#!/usr/bin/env node
// Patchwork MCP server - the stdio surface of the deterministic Protocol Engine
// (design "Components > 3 Patchwork_MCP_Server"; task 5.1).
//
// This is the SECOND of the "two surfaces, one core": it registers `validate`,
// `gate`, and `verdict` as MCP tools over stdio whose handlers read a workspace
// snapshot from disk (via the SHARED ./read-workspace.js reader the CLI also
// uses) and call the IDENTICAL pure core functions the CLI calls. Because both
// adapters delegate to the same core, the CLI a Guardrail Hook shells into and
// the MCP tool an agent calls can never disagree (design "Two surfaces, one
// core"). Agents call these tools to self-check their work before claiming a
// transition (Requirement 10.5).
//
// The tools return STRUCTURED JSON — the exact decision object each core
// function returns — both as machine-readable `structuredContent` and as a
// JSON `text` block, so any MCP client can consume the result.
//
// SECURITY / CONFIG (Requirement 10.5; design "Security Considerations > No
// secrets in configuration"): configuration is via ENVIRONMENT VARIABLES ONLY,
// with NO embedded secrets. The only setting is the default workspace directory,
// read from PATCHWORK_WORKSPACE when set, else `patchwork/`. A per-call
// `workspace` argument overrides it.
//
// _Requirements: 10.5_

import { pathToFileURL } from 'node:url';

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { validate } from './core/validate.js';
import { gate } from './core/gate.js';
import { verdict } from './core/verdict.js';
import { parseIncident, isSchemaError } from './core/schema.js';
import { readWorkspace, DEFAULT_WORKSPACE } from './read-workspace.js';

// The registered MCP server name. This is a STABLE identifier that tasks 11.1
// (POWER.md) and 11.3 (mcp.json lint) MUST match verbatim — the server name in
// mcp.json has to equal the reference in POWER.md, and this constant is the
// single source of truth for that string. Keep it as "patchwork".
export const SERVER_NAME = 'patchwork';
export const SERVER_VERSION = '0.1.0';

/**
 * Resolve the default workspace directory from the environment, falling back to
 * the shared DEFAULT_WORKSPACE. Environment-variable configuration only, no
 * secrets (Requirement 10.5).
 *
 * @returns {string}
 */
function defaultWorkspaceDir() {
  const env = process.env.PATCHWORK_WORKSPACE;
  return typeof env === 'string' && env.trim() !== '' ? env : DEFAULT_WORKSPACE;
}

/**
 * Resolve the workspace directory for a tool call: an explicit per-call
 * `workspace` argument wins; otherwise fall back to the env-configured default.
 *
 * @param {string|undefined} workspaceArg
 * @returns {string}
 */
function resolveWorkspaceDir(workspaceArg) {
  return typeof workspaceArg === 'string' && workspaceArg.trim() !== ''
    ? workspaceArg
    : defaultWorkspaceDir();
}

// ---------------------------------------------------------------------------
// Tool handlers — disk read (shared reader) + IDENTICAL core call
// ---------------------------------------------------------------------------
//
// These are exported so the parity tests (task 5.2) can assert that, for the
// same snapshot, each tool returns the same decision object as the
// corresponding core function — the guard on the "two surfaces, one core"
// invariant. Each mirrors the matching CLI command's disk-reading logic exactly
// (see engine/cli.js), differing only in that it returns the decision object
// instead of printing it and setting an exit code.

/**
 * `validate` tool: read the workspace snapshot and call the core `validate`.
 *
 * @param {{ workspace?: string }} [args]
 * @returns {{ ok: boolean, problems: Array<{path:string,rule:string,message:string}> }}
 */
export function runValidate(args = {}) {
  const workspaceDir = resolveWorkspaceDir(args.workspace);
  const snapshot = readWorkspace(workspaceDir);
  return validate(snapshot);
}

/**
 * `gate` tool: resolve the transition's `from` from the incident's current
 * status (incident.md frontmatter) — exactly as the CLI does — then call the
 * core `gate` with the requested `to`. A missing/unparseable incident is
 * rejected fail-closed, matching the CLI's "the checker could not run defaults
 * to block" stance.
 *
 * @param {{ incidentId: string, to: string, workspace?: string }} args
 * @returns {{ allowed: boolean, reason: string }}
 */
export function runGate(args = {}) {
  const { incidentId, to } = args;
  const workspaceDir = resolveWorkspaceDir(args.workspace);
  const snapshot = readWorkspace(workspaceDir);

  const incidentFiles =
    snapshot.incidents && snapshot.incidents[incidentId]
      ? snapshot.incidents[incidentId]
      : null;

  if (incidentFiles === null) {
    return {
      allowed: false,
      reason: `incident "${incidentId}" not found in workspace "${workspaceDir}"`,
    };
  }
  if (typeof incidentFiles['incident.md'] !== 'string') {
    return {
      allowed: false,
      reason: `incident "${incidentId}" is missing incident.md`,
    };
  }
  const parsed = parseIncident(incidentFiles['incident.md']);
  if (isSchemaError(parsed)) {
    return {
      allowed: false,
      reason: `incident "${incidentId}" has invalid frontmatter: ${parsed.message}`,
    };
  }

  const from = parsed.status;
  // Core call — identical to the CLI's `gate` invocation.
  return gate(snapshot, { incidentId, from, to });
}

/**
 * `verdict` tool: read the incident's review.md and parse it with the
 * fail-closed core `verdict`. A missing incident or missing review.md leaves
 * the review text undefined, which `verdict` maps to NEEDS_WORK.
 *
 * @param {{ incidentId: string, workspace?: string }} args
 * @returns {{ verdict: 'PASS'|'NEEDS_WORK', author?: string, fixVersion?: number|string }}
 */
export function runVerdict(args = {}) {
  const { incidentId } = args;
  const workspaceDir = resolveWorkspaceDir(args.workspace);
  const snapshot = readWorkspace(workspaceDir);

  const incidentFiles =
    snapshot.incidents && snapshot.incidents[incidentId]
      ? snapshot.incidents[incidentId]
      : null;
  const reviewText =
    incidentFiles && typeof incidentFiles['review.md'] === 'string'
      ? incidentFiles['review.md']
      : undefined;

  return verdict(reviewText);
}

/**
 * Wrap a core decision object into an MCP CallToolResult, returning it BOTH as
 * machine-readable `structuredContent` and as a JSON `text` block. No
 * outputSchema is declared, so the SDK does not validate `structuredContent` —
 * it is passed through as-is for clients that consume structured output.
 *
 * @param {object} decision the decision object a core function returned.
 * @returns {{ content: Array<{type:'text',text:string}>, structuredContent: object }}
 */
function toToolResult(decision) {
  return {
    content: [{ type: 'text', text: JSON.stringify(decision) }],
    structuredContent: decision,
  };
}

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

// A short, shared note appended to each tool's `workspace` input description.
const WORKSPACE_ARG_DESC =
  'Workspace directory to read (defaults to the PATCHWORK_WORKSPACE env var, ' +
  'else "patchwork").';

/**
 * Build the Patchwork MCP server with its three tools registered. Exported (and
 * kept side-effect free — it does not connect a transport) so the smoke test
 * (task 5.3) can construct a server and assert the three tools are listed
 * without starting stdio.
 *
 * @returns {McpServer}
 */
export function createServer() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'validate',
    {
      title: 'Validate workspace',
      description:
        'Validate a Patchwork workspace against the schema. Returns ' +
        '{ ok, problems } where each problem names an offending path and the ' +
        'rule it broke.',
      inputSchema: {
        workspace: z.string().optional().describe(WORKSPACE_ARG_DESC),
      },
    },
    async ({ workspace }) => toToolResult(runValidate({ workspace })),
  );

  server.registerTool(
    'gate',
    {
      title: 'Gate an incident transition',
      description:
        'Decide whether an incident may transition to <to>. The transition ' +
        "`from` is read from the incident's incident.md frontmatter. Returns " +
        '{ allowed, reason }.',
      inputSchema: {
        incidentId: z
          .string()
          .describe('Incident id (the INC-<id> directory name).'),
        to: z.string().describe('Requested target Incident_Status.'),
        workspace: z.string().optional().describe(WORKSPACE_ARG_DESC),
      },
    },
    async ({ incidentId, to, workspace }) =>
      toToolResult(runGate({ incidentId, to, workspace })),
  );

  server.registerTool(
    'verdict',
    {
      title: 'Parse a review verdict',
      description:
        "Parse the incident's review.md verdict, fail-closed (anything " +
        'missing/malformed/ambiguous reads as NEEDS_WORK). Returns ' +
        '{ verdict, author?, fixVersion? }.',
      inputSchema: {
        incidentId: z
          .string()
          .describe('Incident id (the INC-<id> directory name).'),
        workspace: z.string().optional().describe(WORKSPACE_ARG_DESC),
      },
    },
    async ({ incidentId, workspace }) =>
      toToolResult(runVerdict({ incidentId, workspace })),
  );

  return server;
}

/**
 * Start the server on stdio. stdout is reserved for the MCP JSON-RPC protocol,
 * so all human-facing logging goes to stderr.
 */
async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Patchwork MCP server "${SERVER_NAME}" v${SERVER_VERSION} running on stdio`,
  );
}

// Run only when executed directly, not when imported by tests (mirrors cli.js).
// This keeps the module importable without starting a transport.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('Fatal error starting the Patchwork MCP server:', error);
    process.exit(1);
  });
}
