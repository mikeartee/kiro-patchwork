// Smoke test for the Patchwork MCP server (task 5.3).
//
// This is the lightest possible check on engine/mcp.js's SURFACE: start the
// server and assert it lists exactly the three expected tools — `validate`,
// `gate`, and `verdict` — no more, no fewer (design "Components > 3
// Patchwork_MCP_Server"; Requirement 10.5). The behavioural parity between each
// tool and its core function is covered separately by task 5.2
// (mcp.parity.test.js); this file only confirms the tool CATALOG the server
// advertises, so it is intentionally named `.smoke.` to sit alongside the
// other smoke suites without colliding with them.
//
// Approach: rather than spawn a subprocess and drive stdio (heavier and more
// brittle on Windows), we exercise the REAL MCP handshake IN-PROCESS using the
// SDK's in-memory linked transport pair. We connect a `Client` to the
// `McpServer` returned by createServer() and call `client.listTools()` — the
// same request path a live MCP client uses over stdio — then assert the
// returned tool names. This is the most faithful "the server lists the three
// tools" assertion available without a process boundary, and it stays fast and
// self-contained. Both transports are closed in a finally block so the
// `node --test` process exits cleanly and never hangs.
//
// _Requirements: 10.5_

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer, SERVER_NAME } from '../mcp.js';

// The exact tool set the server must expose, sorted for a stable comparison.
const EXPECTED_TOOLS = ['gate', 'validate', 'verdict'];

test('mcp smoke: the server lists EXACTLY validate, gate, and verdict over the protocol', async () => {
  const server = createServer();
  const client = new Client({
    name: 'patchwork-smoke-test-client',
    version: '0.0.0',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    // Await BOTH ends of the handshake before listing tools.
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    // Exactly the three expected tools — no more, no fewer.
    assert.deepEqual(
      names,
      EXPECTED_TOOLS,
      'the MCP server must expose exactly validate, gate, and verdict',
    );
  } finally {
    // Close both sides so the linked transports tear down and the test process
    // exits cleanly (no hang).
    await client.close();
    await server.close();
  }
});

test('mcp smoke: the registered server name is "patchwork"', () => {
  assert.equal(SERVER_NAME, 'patchwork');
});
