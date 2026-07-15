---
name: "patchwork"
displayName: "Kiro Patchwork"
description: "Kiro Patchwork turns incident response into a shared, file-based workspace where a human Incident Commander and three scoped agents (SRE, Reviewer, Scribe) drive an incident from first symptom to a reviewed, staged fix and a compiled post-mortem. A deterministic protocol engine enforces the workspace schema, the incident state machine, and a fail-closed review gate, exposed as both a CLI and this MCP server. Multiplayer runs through shared git history and distinct commit authors, so a whole team installs identical agent behavior against one repo."
keywords: ["incident", "outage", "500", "error", "rca", "root cause", "postmortem", "sre"]
author: "Kiro Patchwork Team"
icon: "logo.png"
---

# Kiro Patchwork

Kiro Patchwork is a shared, file-based incident-response workspace. A human
Incident Commander and three scoped AI agents work an incident from first
symptom through an independently reviewed, staged fix and a compiled
post-mortem. The shared `patchwork/` directory is the single source of truth;
multiplayer is achieved through shared git history and distinct commit authors
rather than a live server.

The trust anchor is a deterministic Protocol Engine (`engine/`) that enforces
the workspace schema, the incident state machine, and a fail-closed review
gate. The engine is exposed two ways over one shared core: a CLI the Guardrail
Hook shells into, and the `patchwork` MCP server registered in `mcp.json` that
agents call to self-check. Correctness does not depend on model judgment alone.

## Activation

Patchwork activates on incident-related keywords such as `incident`, `outage`,
`500`, `error`, `rca`, `root cause`, `postmortem`, and `sre`. On activation it
loads the associated steering and the `patchwork` MCP tools.

## Available MCP Server

This is a Guided MCP Power. `mcp.json` registers one stdio server named
`patchwork` (the name matches this file's `name` frontmatter), started with
`node engine/mcp.js`. The server is built on the Model Context Protocol SDK
(`@modelcontextprotocol/sdk`) and `zod`, both already declared in
`package.json` — no extra install step is required. It wraps the same
deterministic core as the CLI, so a gate decision an agent self-checks can
never disagree with the gate the hook enforces.

### Tools

| Tool | Purpose | Returns |
| --- | --- | --- |
| `validate` | Check a workspace against the schema (scaffold, frontmatter, board entries, remediation steps). | `{ ok, problems[] }` where each problem names an offending path and the broken rule. |
| `gate` | Decide whether an incident may transition to a target status. The `from` state is read from `incident.md`. | `{ allowed, reason }`. |
| `verdict` | Parse the incident's `review.md` verdict, fail-closed. | `{ verdict, author?, fixVersion? }` — anything missing, malformed, or ambiguous reads as `NEEDS_WORK`. |

### Tool usage

Agents self-check before claiming a transition. Typical flow: after writing
`analysis.md` and `fix-proposal.md`, call `validate` to confirm the workspace
is well-formed; before advancing to `RESOLVED`, call `gate` with
`to: RESOLVED`, which allows the edge only when a non-author `PASS` exists at
the incident's current `fix_version` and every `[HITL]` step is cleared.

## Onboarding

Onboarding runs on first use in a repository and is fail-safe: it validates
before it changes anything, so a failure never leaves a half-scaffolded repo.

1. **Validate the Node dependency first.** Confirm the Node version required by
   the Protocol Engine (`>=20.0.0`, see `package.json` `engines`) is available
   before making any change.
2. **On success, install and scaffold.** Install the Guardrail Hook into
   `.kiro/hooks/` and scaffold the `patchwork/` workspace (the Board plus the
   `incidents/` tree).
3. **On failure, stop cleanly.** If Node is unavailable or below the required
   version, stop with an actionable message and do not half-scaffold: do not
   install the hook and do not create a partial `patchwork/` tree. Re-run after
   installing Node to complete setup.

## Agents and steering references

The three personas ship in-repo under `.kiro/agents/` (Requirement 13.5). Each
is a scoped custom agent: a JSON config that sets its model and `toolsSettings`
plus a Markdown system prompt that defines its persona and protocol rules.

- **SRE** — `.kiro/agents/patchwork-sre.json` / `.kiro/agents/patchwork-sre.md`:
  investigates from the sample-app logs and read-only git history, asks the
  Commander triage questions, and writes `analysis.md` and `fix-proposal.md`.
  Write-scoped to `patchwork/**`; no push, merge, or branch.
- **Reviewer** — `.kiro/agents/patchwork-reviewer.json` /
  `.kiro/agents/patchwork-reviewer.md`: runs on a different model family from
  the SRE, treats incident content as untrusted, tries to refute the fix, and
  writes only `review.md`.
- **Scribe** — `.kiro/agents/patchwork-scribe.json` /
  `.kiro/agents/patchwork-scribe.md`: maintains the append-only
  `decision-log.md` and compiles `postmortem.md`.

The protocol and persona steering lives under `.kiro/steering/`. The
slash-command prompts that drive the lifecycle are in `.kiro/prompts/`:
`incident.md`, `analyze.md`, `review.md`, `human-itl.md`, and `postmortem.md`.
The fail-closed ship gate is the Guardrail Hook at
`.kiro/hooks/patchwork-guardrail.kiro.hook`.

## Configuration

Configuration is through environment variables only, with no secrets embedded
in `mcp.json`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PATCHWORK_WORKSPACE` | Directory the engine reads as the shared workspace. | `patchwork` |

See the Kiro MCP configuration reference at
<https://kiro.dev/docs/mcp/configuration/> for the full schema.

## Troubleshooting

- **The gate blocks a `RESOLVED` transition.** This is by design when the review
  gate is not satisfied. Confirm a non-author `PASS` verdict exists at the
  incident's current `fix_version` and that every `[HITL]` step is cleared, then
  retry.
- **`validate` reports missing paths.** The workspace scaffold or a required
  artifact is absent. Re-run onboarding to scaffold `patchwork/`, or add the
  missing artifact named in the problem list.
- **The MCP server does not start.** Verify Node `>=20.0.0` is installed and
  that `node engine/mcp.js` runs from the repo root.
