#!/usr/bin/env node
// Patchwork read-only room dashboard - thin runnable adapter (task 16).
//
// This mirrors the cli.js/mcp.js separation exactly: the PURE core
// (engine/core/dashboard.js) turns a workspace snapshot into an HTML string
// with no side effects, and this adapter owns the I/O. It reads the workspace
// from disk via the SHARED readWorkspace reader (the same one the CLI and MCP
// server use) and prints the rendered HTML to stdout.
//
// It is strictly READ-ONLY: it reads workspace files and writes nothing back,
// so it can never modify the Patchwork_Workspace (Requirement 17.3). There is
// no LLM, no network, and no auth surface — the only inputs are files on disk
// and the only output is text on stdout. To capture the page as a file, redirect
// stdout OUTSIDE the workspace, e.g. `node engine/dashboard.js > dashboard.html`;
// the program itself never writes into patchwork/.
//
// _Requirements: 17.1, 17.2, 17.3_

import { pathToFileURL } from 'node:url';

import { renderDashboard } from './core/dashboard.js';
import { readWorkspace, DEFAULT_WORKSPACE } from './read-workspace.js';

/**
 * Parse the options accepted by the dashboard adapter. Supports both
 * `--workspace <dir>` and `--workspace=<dir>`, matching the CLI's flag style.
 *
 * @param {string[]} args argv after the script path.
 * @returns {{ workspace: string|null }}
 */
function parseArgs(args) {
  const options = { workspace: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace') {
      options.workspace = args[i + 1];
      i++;
    } else if (arg.startsWith('--workspace=')) {
      options.workspace = arg.slice('--workspace='.length);
    }
  }
  return options;
}

/**
 * Read the workspace snapshot from disk, render the read-only dashboard, and
 * print it to stdout. Returns the process exit code (always 0 — rendering a
 * view never "fails" the way a gate check can).
 *
 * @param {string[]} argv full process argv (node + script path + args).
 * @returns {number} process exit code.
 */
export function main(argv) {
  const options = parseArgs(argv.slice(2));
  const workspaceDir = options.workspace || DEFAULT_WORKSPACE;

  const snapshot = readWorkspace(workspaceDir);
  const html = renderDashboard(snapshot);

  process.stdout.write(html);
  return 0;
}

// Run only when executed directly, not when imported by tests (mirrors
// cli.js/mcp.js). This keeps the module importable without side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv));
}
