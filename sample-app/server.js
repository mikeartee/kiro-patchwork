// Local-only HTTP surface for the Patchwork sample app.
//
// !! DELIBERATELY VULNERABLE, LOCAL-ONLY !!
// This service exists solely as investigation grounding for Kiro Patchwork
// incident drills. It binds to 127.0.0.1 (never 0.0.0.0), ships no Dockerfile
// or deploy config, and MUST NOT be deployed or exposed to a network
// (Requirement 14.5). It uses only Node's built-in `http` module — no express,
// no external dependencies.
//
// Run it locally:
//   node sample-app/server.js
// Then POST to the endpoint (localhost only):
//   POST http://127.0.0.1:3000/checkout
//   {"subtotal": 100, "coupons": ["SAVE5"]}            -> 200 OK
//   {"subtotal": 100, "coupons": ["SAVE5", "SAVE10"]}  -> 500 (planted defect)
//
// A single coupon succeeds; stacking two or more valid coupons trips the
// planted coupon-stacking defect and returns HTTP 500. On a 500 the service
// logs a stable, recognizable failure signature to stderr — the same signature
// task 6.2 seeds into sample-app/logs/ for the SRE to investigate.
//
// _Requirements: 14.1, 14.5_

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { computeCheckout } from './checkout.js';

const HOST = '127.0.0.1'; // localhost only -- never bind 0.0.0.0
const PORT = Number(process.env.PORT ?? 3000);

/** Read and JSON-parse a request body; resolves to {} for an empty body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/checkout') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }

    try {
      const result = computeCheckout(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      // Stable, recognizable failure signature. Keep this format steady: the
      // SRE greps for it and task 6.2 seeds matching lines into the logs.
      const coupons = Array.isArray(body?.coupons) ? body.coupons : [];
      console.error(
        `[checkout] ERROR 500 /checkout coupons=${JSON.stringify(coupons)} ${err.name}: ${err.message}`
      );
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal server error' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// Only bind a socket when this file is run directly (node sample-app/server.js).
// Importing the module (e.g. from a future reproduction test) must not listen.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, HOST, () => {
    console.log(`[checkout] sample app listening on http://${HOST}:${PORT} (local-only)`);
  });
}
