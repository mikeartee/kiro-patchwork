# Kiro Patchwork

Kiro Patchwork turns incident response into a shared, file-based workspace. A
human Incident Commander and three scoped AI agents (SRE, Reviewer, Scribe)
drive an incident from first symptom through an independently reviewed, staged
fix and a compiled post-mortem. The shared `patchwork/` directory is the single
source of truth, and multiplayer runs through shared git history and distinct
commit authors rather than a live server.

The trust anchor is a deterministic Protocol Engine (`engine/`) that enforces
the workspace schema, the incident state machine, and a fail-closed review
gate. The engine is exposed two ways over one shared core: a CLI the guardrail
hook shells into, and the `patchwork` MCP server that agents call to self-check.
Correctness does not depend on model judgment alone.

## Prerequisites

- Node.js `>=20.0.0` (declared in `package.json` `engines.node`).
- The engine's runtime dependencies restored with `npm install` after a clone.

## Installation

Patchwork is packaged as a Kiro Power: `POWER.md` and `mcp.json` live at the
repository root.

### 1. Install the Power through the Powers panel

Installing through the IDE Powers panel is a manual, GUI-driven action. Open
Kiro, go to the Powers panel, and add the Power one of two ways:

- **From a public GitHub repository:** choose the "from GitHub" option and paste
  the repository URL. Kiro clones the repo, reads `POWER.md`, and registers the
  `patchwork` MCP server declared in `mcp.json`.
- **From a local folder:** choose the "from local folder" option and select this
  repository's root (the directory that contains `POWER.md`).

After either path, activating on an incident keyword (`incident`, `outage`,
`500`, `error`, `rca`, `root cause`, `postmortem`, `sre`) loads the steering
under `.kiro/steering/` and the `patchwork` MCP tools (`validate`, `gate`,
`verdict`).

### 2. Run onboarding

Onboarding is fail-safe: it validates before it changes anything.

```bash
node engine/onboarding.js
```

Onboarding validates that Node `>=20.0.0` is available first. On success it
installs the guardrail hook into `.kiro/hooks/` and scaffolds the `patchwork/`
workspace (the Board plus the `incidents/` tree). It is idempotent: existing
hook files and a populated `patchwork/` tree are preserved, never clobbered. If
Node is unavailable or below the required version, onboarding stops with an
actionable message and makes no filesystem change, so a failure never leaves a
half-scaffolded repo.

### 3. (Optional) Verify install preconditions

```bash
node scripts/verify-install.mjs
```

This checks that the repository is a self-contained, relocatable Power a
Powers-panel install can consume on another machine (required artifacts present,
`package.json` self-contained, `mcp.json` launched with a relative command, and
no machine-specific paths). It cannot drive the IDE, so the Powers-panel install
itself stays a manual step.

## The collaboration flow

### The participants

- **Incident Commander (human):** reports incidents, answers triage questions,
  approves or rejects the proposed fix, and clears the human-only steps.
- **`patchwork-sre` (agent):** investigates from the sample-app logs and
  read-only git history, asks the Commander two to three triage questions, and
  writes `analysis.md` and `fix-proposal.md`. Write-scoped to `patchwork/**`,
  with no push, merge, or branch. It proposes but never ships.
- **`patchwork-reviewer` (agent):** runs on a different model family, treats the
  incident content as untrusted (injection-hardened), tries to refute the fix,
  and writes only `review.md`, ending with a fail-closed `VERDICT:` line.
- **`patchwork-scribe` (agent):** maintains the append-only `decision-log.md`
  and compiles `postmortem.md` from the incident artifact chain.

### The slash-command lifecycle

The lifecycle is driven by slash-command prompts in `.kiro/prompts/`:

1. `/incident` — file a symptom, create the incident directory and
   `incident.md`, set status `REPORTED`, and append a Board entry.
2. `/analyze` — hand off to the SRE agent, which triages and writes
   `analysis.md` and `fix-proposal.md`, reaching `ANALYSIS_READY`.
3. `/review` — hand off to the Reviewer agent, which writes `review.md` and a
   verdict. A non-author `PASS` moves the incident to `AWAITING_APPROVAL`;
   `NEEDS_WORK` routes it to `CHANGES_REQUESTED` for revision.
4. Human approval — the Commander approves (`APPROVED`) or rejects
   (`CHANGES_REQUESTED`).
5. `/human-itl` — walk each `[HITL]` step, record an audit Board entry
   attributed to the Commander per cleared step, and check the step off.
6. `RESOLVED` — the guardrail hook allows this transition only when the gate is
   satisfied.
7. `/postmortem` — hand off to the Scribe agent, which compiles `postmortem.md`.

### The gates

- **Human authority:** approval and every `[HITL]` step are human-only. When the
  SRE and Reviewer cannot converge within the round cap, the incident is parked
  for a human decision (`PARKED_FOR_HUMAN`).
- **Fail-closed guardrail:** the guardrail hook
  (`.kiro/hooks/patchwork-guardrail.kiro.hook`) shells into the CLI on a
  `RESOLVED` transition or ship command and decides solely on the exit code and
  parsed result. It blocks unless a non-author `PASS` exists at the incident's
  current `fix_version` and every `[HITL]` step is cleared. Any error, timeout,
  or unparseable output is treated as "gate not satisfied" and blocked.

### Multiplayer

There is no live server. Participants synchronize through the shared git
repository, each contribution is attributed to a distinct commit author, and the
append-only Board (`patchwork/board.md`) keeps a visible, chronological record
of who did what across incidents.

## Running the demo

The repository ships a seeded incident, `INC-2024-001` ("Checkout endpoint
returns 500 under coupon stacking"), already carried to `RESOLVED` with a
compiled `postmortem.md`. It shows the incident-directory layout at the
resolution stage under `patchwork/incidents/INC-2024-001/`.

### Walk it interactively

With the Power installed and onboarding run, walk a fresh incident through the
lifecycle above: `/incident` to file the symptom, then `/analyze`, `/review`,
approve, `/human-itl`, `RESOLVED`, and `/postmortem`. The SRE reads the
sample-app evidence, the Reviewer refutes, you gate at approval and HITL, and
the Scribe compiles the final post-mortem from the whole collaboration.

### The deterministic engine and tests

Run the test suite with the built-in Node test runner:

```bash
node --test
```

`node --test` discovers every `*.test.js` file in the repo. The engine suite
(including the golden-path integration test that carries a seeded incident from
report to a compiled post-mortem) passes green:

```bash
node --test engine/test
```

The sample app's reproduction test is expected to fail while the planted defect
is present:

```bash
node --test sample-app
```

The **three `sample-app/checkout.repro.test.js` failures are intentional**. They
reproduce the planted coupon-stacking bug (a `TypeError` on stacked coupons) and
stay red until a fix is staged. That failing test is the SRE's factual
grounding and the check an `[AFK]` remediation step verifies against.

### The engine CLI

The engine's `patchwork` bin (mapped to `engine/cli.js`) can be run directly.
The `verdict` call below reads the seeded incident's recorded `PASS`; the
`gate` call is the general form (its `from` state is read from `incident.md`):

```bash
node engine/cli.js validate
node engine/cli.js gate --incident <id> --to <state>
node engine/cli.js verdict --incident INC-2024-001
```

`validate` exits non-zero and lists offending paths on a malformed workspace;
`gate` exits non-zero when a transition is rejected; `verdict` prints
`PASS`/`NEEDS_WORK` and is fail-closed on anything missing, malformed, or
ambiguous.

## The Kiro + agentic approach

Kiro Patchwork is built as agentic development rather than a monolithic app, and
every moving part is a native Kiro primitive.

**Specs** drove the build: the requirements, design, and tasks under
`.kiro/specs/kiro-patchwork/` turned one idea into an ordered, test-first plan,
so the deterministic engine existed and was verified before any agent depended
on it.

**Powers** package the whole system. `POWER.md` and `mcp.json` at the repo root
make Patchwork installable through the IDE Powers panel. That is the team-install
framing: a whole team installs the same Power and runs identical agent behavior
against one shared repo, with no bespoke setup per person.

**Custom agents** encode least privilege. The SRE, Reviewer, and Scribe are
three scoped agents whose `toolsSettings` decide what each may touch: the SRE
proposes but cannot ship, the Reviewer runs on a different model family and
writes only its verdict, and the Scribe only logs and compiles.

**MCP** exposes the deterministic engine's `validate`, `gate`, and `verdict` as
tools agents call to self-check their own work before claiming a transition.

**Hooks** enforce the outcome. The guardrail hook shells the same engine core
and fails closed, blocking `RESOLVED` unless a non-author `PASS` and cleared
`[HITL]` steps exist, so correctness never rests on model judgment.

**Steering** carries the shared conventions and personas every install loads on
activation.

Multiplayer needs no live server: participants sync through shared git history
and distinct commit authors, and the append-only Board keeps a visible,
attributed record of who did what.
