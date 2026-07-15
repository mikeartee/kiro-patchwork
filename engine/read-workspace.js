// Shared workspace disk-reader for the Patchwork Protocol Engine.
//
// This is the SINGLE disk-reading adapter used by BOTH surfaces — the CLI
// (engine/cli.js) and the MCP server (engine/mcp.js) — so they read a workspace
// from disk into an in-memory snapshot IDENTICALLY. That shared reader is the
// concrete expression of the design's "two surfaces, one core" invariant: the
// CLI a hook shells into and the MCP tool an agent calls can never disagree,
// because they build their snapshot the same way and then call the same pure
// core (design "Architecture > Two surfaces, one core").
//
// It is deliberately kept OUT of engine/core/. The core is pure and
// deterministic — no disk access, no wall-clock, no randomness — so that
// identical snapshots always yield identical results (Requirement 10.6). All
// disk I/O therefore lives here at the adapter layer, keeping the trust anchor
// side-effect free.
//
// _Requirements: 10.5, 10.6_

import fs from 'node:fs';
import path from 'node:path';

import { RESOLUTION_ARTIFACTS } from './core/schema.js';

// The workspace directory is `patchwork/` relative to the current working
// directory unless a caller overrides it (CLI `--workspace <dir>`, MCP
// `workspace` param, or the PATCHWORK_WORKSPACE env var). Exported so both
// surfaces share one default rather than defining their own.
export const DEFAULT_WORKSPACE = 'patchwork';

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a Patchwork workspace directory from disk into the snapshot shape that
 * the core commands (validate/gate/verdict) expect.
 *
 * The board file is read into `board` (null when absent). Each `INC-*`
 * subdirectory of `incidents/` becomes an entry whose value is a map of the
 * artifact filenames that actually exist to their contents. When the
 * `incidents/` directory itself is absent, `incidents` is null (a scaffold
 * problem the core reports).
 *
 * @param {string} workspaceDir path to the `patchwork/` workspace directory.
 * @returns {{ board: string|null, incidents: Object<string, Object<string,string>>|null }}
 */
export function readWorkspace(workspaceDir) {
  const boardPath = path.join(workspaceDir, 'board.md');
  const board = fileExists(boardPath) ? fs.readFileSync(boardPath, 'utf8') : null;

  const incidentsDir = path.join(workspaceDir, 'incidents');
  let incidents = null;
  if (dirExists(incidentsDir)) {
    incidents = {};
    for (const entry of fs.readdirSync(incidentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('INC-')) continue;
      const incidentDir = path.join(incidentsDir, entry.name);
      const files = {};
      for (const artifact of RESOLUTION_ARTIFACTS) {
        const artifactPath = path.join(incidentDir, artifact);
        if (fileExists(artifactPath)) {
          files[artifact] = fs.readFileSync(artifactPath, 'utf8');
        }
      }
      incidents[entry.name] = files;
    }
  }

  return { board, incidents };
}
