# Implementation Plan: Kiro Patchwork

## ⚠️ MANDATORY - READ BEFORE EVERY TASK ⚠️

**YOU MUST FOLLOW THESE RULES FOR EVERY TASK:**

1. **Shell Commands**: Use `controlPwshProcess` ONLY. NEVER use `executePwsh`.
2. **Gap Analysis**: Perform TWO gap analysis passes BEFORE marking any task complete.
3. **Show Your Work**: Gap analysis must be visible in your response.

If you skip any of these, you have violated the protocol.

---

## Overview

This plan builds Kiro Patchwork test-first, in dependency order. The deterministic Protocol Engine (Tasks 1-4) is built and covered by tests before any agent depends on it, because the engine is the trust anchor whose correctness must not rely on model judgment. The vulnerable sample app (Task 5) is created before the SRE agent that reads it. The scoped agents, guardrail hook, and slash-command prompts (Tasks 6-9) sit on top of the verified engine. Packaging and onboarding (Tasks 10-11) wrap everything as a Kiro Power. The final wiring task (Task 12) ties the pieces into one demoable end-to-end flow with a golden-path integration test and the challenge deliverables. Task 13 is an optional read-only dashboard.

Implementation language is **Node.js** with the built-in `node:test` runner and `node:assert`, matching the dependency-light choice in the design. Property-based tests use a small in-repo generator layer (no external PBT dependency).

The design's Testing Strategy defines three properties, referenced throughout:
- **Property 1: Verdict fails closed for all non-PASS inputs** — for any string that is not exactly `VERDICT: PASS`, `parseVerdict` returns `NEEDS_WORK`.
- **Property 2: Gate never allows an undefined transition** — for any `{from, to}` pair, `gate` allows it only if it is in the transition table.
- **Property 3: Validate is deterministic and order-independent** — for any workspace snapshot, reordering order-independent content yields the same validation verdict.

## Development Principles

**IMPORTANT**: Follow these principles strictly during implementation:

1. **Build ugly and working before making it clean**
   - Get it working first
   - Refactor later if needed
   - Don't optimize prematurely

2. **If something isn't specified, ask - don't invent**
   - No assumptions
   - No "improvements"
   - No "I noticed we could also..."

3. **Build exactly what's specified. Nothing more.**
   - No extra features
   - No extra abstractions
   - No extra config options

4. **Stop and ask if stuck for 10+ minutes**
   - Don't waste time debugging hallucinated APIs
   - Use Context7 to check library docs
   - Ask for clarification on ambiguous requirements

5. **Property tests are optional for MVP**
   - Tasks marked with `*` can be skipped
   - Focus on getting core functionality working
   - Add comprehensive tests in v2

## Non-Requirements (What NOT to Build)

To maintain simplicity and focus, this implementation explicitly **DOES NOT** include:

❌ Real-time multiplayer server, websockets, or live presence (multiplayer is via shared git history and distinct commit authors only)
❌ Authentication, user accounts, or an identity system
❌ Deploying or hosting the sample app (it is deliberately vulnerable and local-only)
❌ Integrations with external incident tools (PagerDuty, Slack, Opsgenie, etc.)
❌ Auto-merge or auto-ship of a fix (a human always approves; the gate only permits, it never ships)
❌ Agents beyond patchwork-sre, patchwork-reviewer, and patchwork-scribe
❌ A heavy test framework or external property-testing dependency (use node:test + a small in-repo generator)
❌ Configuration options for things with one obvious answer
❌ Abstractions added "for future flexibility"
❌ Any write/edit capability in the optional dashboard (read-only only)

**System Characteristics:**

✅ A file-based shared workspace (Markdown + YAML frontmatter) as the single source of truth
✅ A deterministic Node protocol engine (validate/gate/verdict) exposed as both a CLI and an MCP server over the same core
✅ Three scoped custom agents: SRE (no push/merge/branch), Reviewer (different model family, adversarial, injection-hardened), Scribe (append-only log + post-mortem)
✅ A fail-closed guardrail hook enforcing a non-author PASS at the current fix_version plus cleared HITL, with a round-cap escape to the human
✅ Packaged as a Kiro Power with onboarding (validate Node, install hook, scaffold workspace)
✅ A local-only vulnerable sample app with a planted bug, seeded logs, real git history, and a failing reproduction test
✅ Tests via node:test + node:assert with an in-repo property-test generator (min 100 iterations)

## Context7 MCP Usage (CRITICAL)

**Before writing ANY code that uses a library, query Context7 for current documentation.**

**Required libraries to query Context7 for:**

- `@modelcontextprotocol/sdk` — creating a stdio MCP server, registering tools, and defining tool input schemas / handlers (for engine/mcp.js)
- `yaml` — parsing and validating YAML frontmatter in incident.md, IF a YAML library is used (prefer a minimal parser to stay dependency-light; query before adopting)
- `node:test` / `node:assert` — the built-in test runner and assertion API, including subtests and running with `node --test`

Note: for Kiro-specific config formats (POWER.md frontmatter, `.kiro/agents/*.json` toolsSettings, `.kiro/hooks/*.kiro.hook`, mcp.json), consult the Kiro documentation rather than Context7.

---

## Tasks

- [x] 1. Scaffold the engine, shared schema module, and `validate` command
  - [x] 1.1 Set up the engine project structure
    - Create `engine/` with `core/` (schema + commands), `cli.js`, and `test/` directories
    - Add a root `package.json` configured to run `node --test` and declaring the Node version required by the engine
    - Create a `patchwork/` workspace-layout reference (board.md + incidents/ structure) matching the design's Workspace layout
    - _Requirements: 1.1, 1.4_

  - [x] 1.2 Implement the shared schema parsers with TDD
    - Implement `parseIncident(text)` (YAML frontmatter: `id`, `title`, `status`, `fix_version`), `parseBoardEntry(line)`, and `parseRemediationStep(line)` returning either a parsed object or a `SchemaError`
    - Enforce the `Incident_Status` enum, the board-entry grammar `[time] @who · Role (human|agent) · type:`, and the remediation grammar (`[AFK]`/`[HITL]` tag + `verify:` clause)
    - Write these parsers test-first: one passing case plus one test per violation (missing status field, unknown status, board entry missing author/role/type, remediation step missing tag or missing verify clause)
    - _Requirements: 1.3, 2.2, 9.1, 9.2_

  - [x] 1.3 Implement the `validate(workspace)` core function
    - Take an explicit in-memory workspace snapshot (no wall-clock, no disk access, no randomness) and return `{ ok, problems: Problem[] }` where each problem names the offending path and the rule broken
    - Check: workspace scaffold present, each `incident.md` frontmatter valid with a known status, board entries well-formed, remediation steps carry tag + verification; a resolution-stage incident has the full artifact set
    - _Requirements: 1.5, 2.4, 9.4, 10.1, 10.6_

  - [x] 1.4 Implement the `patchwork validate` CLI command
    - Add `engine/cli.js` that reads the workspace from disk into a snapshot, calls `validate`, prints a human-readable summary plus a machine-readable JSON line, and exits non-zero when the problem list is non-empty (listing offending paths)
    - _Requirements: 1.5, 10.1, 10.4_

  - [x] 1.5 Write unit tests for `validate` and the CLI exit contract
    - Table-driven tests for each schema rule (valid + each violation) and an end-to-end CLI test asserting non-zero exit with offending paths on an invalid workspace and zero exit on a valid one
    - _Requirements: 1.5, 2.4, 9.4, 10.1_

  - [x] 1.6 Write property test: validate is deterministic and order-independent
    - **Property 3: Validate is deterministic and order-independent**
    - For any generated workspace snapshot, shuffling order-independent content (independent problems, equivalent entries) yields the same `ok`/`problems` verdict; run minimum 100 iterations; tag with `Feature: kiro-patchwork, Property 3`
    - _Requirements: 10.6_

- [x] 2. Implement the state-machine transition table and `gate` transition legality
  - [x] 2.1 Define the transition table and `gate` transition check
    - Encode the explicit transition table from the design (happy path REPORTED→…→RESOLVED plus CHANGES_REQUESTED and PARKED_FOR_HUMAN branch edges)
    - Implement `gate(workspace, { incidentId, from, to })` returning `{ allowed, reason }` that rejects any `{from, to}` pair absent from the table (at this stage, transition legality only — no RESOLVED guard yet)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 10.2_

  - [x] 2.2 Extend the CLI with the `gate` command
    - Add `patchwork gate --incident <id> --to <state>` that loads the snapshot, calls `gate`, prints summary + JSON, and maps allowed/rejected to exit code (0 allowed, non-zero rejected)
    - _Requirements: 10.2, 10.4_

  - [x] 2.3 Write unit tests for transition legality
    - Test every legal edge is allowed and representative illegal edges are rejected, including state-skipping on the happy path and undefined `{from, to}` pairs
    - _Requirements: 3.2, 3.5_

  - [x] 2.4 Write property test: gate never allows an undefined transition
    - **Property 2: Gate never allows an undefined transition**
    - For any random `{from, to}` pair of `Incident_Status` values, `gate` allows it only if the pair is in the transition table; every other pair is rejected; run minimum 100 iterations; tag with `Feature: kiro-patchwork, Property 2`
    - _Requirements: 3.5, 10.2_

- [x] 3. Implement verdict parsing, the Non_Author_Rule, fix-version binding, round-cap counting, and the RESOLVED guard
  - [x] 3.1 Implement fail-closed `parseVerdict` and the `verdict` core/CLI command
    - Implement `parseVerdict(reviewText)` normalizing to `PASS` only on an exact final `VERDICT: PASS` line; a missing, typo, commented-out, conflicting, empty, or unreadable line resolves to `NEEDS_WORK`
    - Implement `verdict(reviewText) -> { verdict, author?, fixVersion? }` and add `patchwork verdict --incident <id>` printing `PASS|NEEDS_WORK`
    - _Requirements: 5.2, 5.3, 10.3_

  - [x] 3.2 Extend `gate` with the RESOLVED guard and review-to-fix binding
    - For the `FIX_STAGED → RESOLVED` edge, require a non-author PASS verdict whose recorded `fix_version` equals the incident's current `fix_version`, and reject a PASS whose author equals the `fix-proposal.md` author (Non_Author_Rule)
    - Reject the transition when any `[HITL]` step remains uncleared; ignore stale PASS verdicts from earlier fix versions; keep the guard fail-closed
    - _Requirements: 6.3, 6.4, 8.5, 10.2_

  - [x] 3.3 Implement round-cap counting and PARKED_FOR_HUMAN routing
    - Track the SRE→Reviewer revision-cycle count per incident; when the count reaches the configured Round_Cap without a PASS, route CHANGES_REQUESTED to PARKED_FOR_HUMAN via the gate/transition logic
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 3.4 Write property test: verdict fails closed for all non-PASS inputs
    - **Property 1: Verdict fails closed for all non-PASS inputs**
    - For any generated string that is not exactly the canonical `VERDICT: PASS` line, `parseVerdict` returns `NEEDS_WORK`; run minimum 100 iterations; tag with `Feature: kiro-patchwork, Property 1`
    - _Requirements: 5.3, 10.3_

  - [x] 3.5 Write unit tests for the RESOLVED guard edge cases
    - Cover: valid non-author PASS at current fix_version allowed; stale PASS ignored; self-authored PASS rejected; uncleared HITL rejected; round-cap reached routes to PARKED_FOR_HUMAN
    - _Requirements: 6.3, 6.4, 8.5, 12.2_

- [x] 4. Checkpoint - engine core complete
  - Ensure all engine unit and property tests pass, ask the user if questions arise.

- [x] 5. Wrap the engine core as an MCP server
  - [x] 5.1 Implement the stdio MCP server
    - Add `engine/mcp.js` registering `validate`, `gate`, and `verdict` as MCP tools over stdio, each handler reading the workspace snapshot and calling the identical core functions, returning structured JSON; configure via environment variables only, no embedded secrets
    - _Requirements: 10.5_

  - [x] 5.2 Write MCP handler tests asserting parity with the core
    - For the same snapshot, assert each MCP tool returns the same decision as the corresponding core function (protects the "two surfaces, one core" invariant)
    - _Requirements: 10.5, 10.6_

  - [x] 5.3 Write an MCP smoke test
    - Start the server and assert it lists the three expected tools
    - _Requirements: 10.5_

- [x] 6. Build the local sample app with a planted bug and real evidence
  - [x] 6.1 Create the vulnerable sample service and commit the planted defect
    - Add a tiny local-only Node service under `sample-app/` (e.g. a `/checkout` endpoint that returns 500 under a specific condition) with the defect introduced by an identifiable git commit; do not configure it for deployment
    - _Requirements: 14.1, 14.5_

  - [x] 6.2 Seed log files reflecting the defect
    - Add seeded logs under `sample-app/logs/` that show the failure signature the SRE will investigate
    - _Requirements: 14.2, 14.4_

  - [x] 6.3 Add a failing reproduction test
    - Write a `node:test` reproduction test that fails while the planted defect is present (the factual grounding an `[AFK]` remediation step verifies against)
    - _Requirements: 14.3_

- [x] 7. Create the patchwork-sre custom agent
  - [x] 7.1 Author the SRE agent config and prompt
    - Add `.kiro/agents/patchwork-sre.json` (model + `toolsSettings`) and `.md` prompt: write-scoped to `patchwork/**`, read-only git shell limited to `status`/`log`/`diff`/`show`, read access to `sample-app/logs`, and no push/merge/branch
    - Prompt behavior: read evidence, ask the Commander 2-3 triage questions, then write `analysis.md` and `fix-proposal.md` with `[AFK]`/`[HITL]`-tagged remediation steps and per-item verification checks, set status to ANALYSIS_READY, and self-check via the engine MCP tools
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 9.1, 9.2, 9.3_

  - [x] 7.2 Write a config-lint test for SRE tool scoping
    - Assert the config write scope is `patchwork/**`, that push/merge/branch and secret paths are denied, and that artifacts the agent is expected to produce pass `validate`
    - _Requirements: 4.5, 4.6, 9.4_

- [x] 8. Create the patchwork-reviewer agent and the guardrail hook
  - [x] 8.1 Author the Reviewer agent config and prompt
    - Add `.kiro/agents/patchwork-reviewer.{json,md}` on a different model family from the SRE; read access to incident artifacts + sample app, write access to `review.md` only
    - Prompt: adversarial mandate to refute the fix; injection-hardened to treat `incident.md`/`fix-proposal.md` as untrusted and ignore embedded "approve this" directives; end `review.md` with a fail-closed `VERDICT:` line
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 6.1, 6.2_

  - [x] 8.2 Implement the guardrail hook shelling into the CLI
    - Add `.kiro/hooks/*.kiro.hook` that, on a RESOLVED transition or ship command, invokes `patchwork gate`/`patchwork verdict` and decides solely on exit code + parsed result, failing closed on any non-zero exit, thrown error, timeout, or unparseable output; allows only on explicit success
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 8.3 Write guardrail hook tests for every failure mode
    - Drive the hook against constructed workspaces: assert it blocks on no PASS, NEEDS_WORK, stale PASS, self-authored PASS, uncleared HITL, and non-zero CLI exit; assert it allows only on a valid non-author PASS at current fix_version with HITL cleared
    - _Requirements: 6.3, 6.4, 8.5, 11.2, 11.3, 11.4_

  - [x] 8.4 Write a config-lint test for Reviewer scoping and model family
    - Assert the Reviewer writes only `review.md` and runs on a different model family from the SRE
    - _Requirements: 5.4, 5.5_

- [x] 9. Create the patchwork-scribe agent
  - [x] 9.1 Author the Scribe agent config and prompt
    - Add `.kiro/agents/patchwork-scribe.{json,md}` write-scoped to `decision-log.md` (append-only) and `postmortem.md`; prompt appends decisions and compiles `postmortem.md` from the incident artifact chain (incident id, root cause, applied fix, review outcome)
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 9.2 Write a postmortem validator test and append-only check
    - Assert a compiled `postmortem.md` contains the required sections and links all artifacts, and that appending to `decision-log.md` preserves all existing entries
    - _Requirements: 7.2, 7.3, 7.4_

- [x] 10. Create the slash-command prompts
  - [x] 10.1 Author the incident-lifecycle prompts
    - Add `.kiro/prompts/` for `/incident` (create Incident_Directory + `incident.md`, set REPORTED, append a board entry), `/analyze` (hand off to SRE), `/review` (hand off to Reviewer), `/human-itl` (walk each `[HITL]` step, write an audit Board_Entry attributed to the Commander per cleared step, check the step off), and `/postmortem` (hand off to Scribe)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.3_

  - [x] 10.2 Write a test that RESOLVED opens only after HITL cleared + PASS
    - Using the engine + a constructed workspace, assert the RESOLVED gate stays closed until every HITL step is cleared and a non-author PASS exists at the current fix_version, then opens
    - _Requirements: 8.4, 8.5, 9.3_

- [x] 11. Package as a Kiro Power with onboarding
  - [x] 11.1 Author POWER.md and mcp.json
    - Create `POWER.md` at repo root with frontmatter (`name`, `displayName`, `description`, `keywords: [incident, outage, 500, error, rca, root cause, postmortem, sre]`, `author`), onboarding steps, and steering references; add `mcp.json` registering the engine MCP server with a name matching POWER.md, configured via env vars with no secrets
    - _Requirements: 13.1, 13.2, 13.5, 16.3_

  - [x] 11.2 Implement onboarding (dependency check + scaffold + hook install)
    - Onboarding validates the required Node dependency before any change; on success it installs the guardrail hook into `.kiro/hooks/` and scaffolds `patchwork/`; on failure it stops with an actionable message and does not half-scaffold
    - _Requirements: 13.3, 13.4_

  - [x] 11.3 Write a lint test for POWER.md and mcp.json
    - Assert required frontmatter fields are present and the MCP server name in `mcp.json` matches the reference in `POWER.md`
    - _Requirements: 13.1, 13.2_

- [x] 12. Checkpoint - agents, hook, and packaging complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Verify Power installation and multiplayer attribution
  - [x] 13.1 Verify install from local folder and public GitHub
    - Add scripts/tests that exercise importing the Power from a local folder and from a public GitHub repository, verify keyword activation loads the engine tools + steering, and verify onboarding installs the hook and scaffolds the workspace
    - _Requirements: 13.6_

  - [x] 13.2 Write a multiplayer attribution test
    - Assert the Board retains contributions from multiple distinct participants/roles across synchronizations and that entries carry distinct authors (git-history-based reconciliation, no live server)
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

- [x] 14. Wire the end-to-end flow and produce challenge deliverables
  - [x] 14.1 Implement the golden-path integration test
    - One end-to-end `node:test` that carries a seeded incident from report to compiled `postmortem.md` and asserts: RESOLVED is reachable only via a non-author PASS at the current `fix_version` with all HITL cleared (removing any one condition keeps it out of RESOLVED); the Board history is complete, attributed, and chronological; the compiled `postmortem.md` links the full artifact chain
    - _Requirements: 16.4, 8.5, 11.4, 2.5, 7.3, 7.4_

  - [x] 14.2 Write the README and Kiro/agentic explanation
    - README documents installation, the collaboration flow, and how to run the demo; add a 150-300 word explanation of the Kiro + agentic approach (Powers + MCP + Hooks + Steering + custom agents + Specs, with the team-install multiplayer framing)
    - _Requirements: 16.1, 16.2_

  - [x] 14.3 Add the environment variable examples
    - Add `.env.example` carrying key names with placeholder values and no real secrets
    - _Requirements: 16.3_

- [x] 15. Final checkpoint - full flow demoable
  - Ensure all tests pass and the seeded incident runs report-to-postmortem, ask the user if questions arise.

- [x] 16. (Optional) Build the read-only room dashboard
  - Add a thin read-only view that renders `board.md`, the current status, and the artifact chain with Human/SRE/Reviewer/Scribe badges; reads files only (no LLM, no network, no auth) and never modifies the workspace
  - Add a DOM/snapshot test asserting the rendered status and recent board entries; this task is clearly optional
  - _Requirements: 17.1, 17.2, 17.3_

## Notes

- Tasks (and sub-tasks) marked with `*` are optional test or verification steps and can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- Ordering guarantees no orphaned code: the deterministic engine (Tasks 1-5) is built and tested before the agents that call it, the sample app (Task 6) precedes the SRE that reads it, and Task 14 wires the pieces into one demoable report-to-postmortem flow.
- Each task references the specific acceptance criteria it fulfills for traceability.
- Property tests (Properties 1-3 from the design Testing Strategy) run a minimum of 100 iterations and are placed next to the code they validate to catch errors early.
- Checkpoints (Tasks 4, 12, 15) provide incremental validation points.
