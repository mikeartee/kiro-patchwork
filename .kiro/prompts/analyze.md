# /analyze — hand off to the SRE agent

Run this to hand a reported incident to the **`patchwork-sre`** agent for
investigation. This is a handoff: the SRE agent does the work of reading the
evidence, triaging with you, and writing the analysis and fix proposal. This
command's job is to route the incident to it and keep you in the loop.

## What this command does

1. **Identify the incident.** Determine the target `INC-<id>` — the incident the
   Commander names, or the one most recently opened by `/incident`. Confirm
   `patchwork/incidents/INC-<id>/incident.md` exists. The incident should be at
   `REPORTED` (or `INVESTIGATING`, if triage is resuming, or
   `CHANGES_REQUESTED`/`PARKED_FOR_HUMAN`, if the SRE is revising after review).

2. **Switch to the SRE agent.** Select the `patchwork-sre` custom agent from the
   agent selector and ask it to investigate incident `INC-<id>`. Do not
   re-implement its behavior here — its system prompt is the single source of
   truth. The SRE agent will, in order:
   - read the incident report, the `sample-app/logs/`, and read-only git history
     to gather evidence;
   - ask you **two to three** triage questions, then stop and wait for your
     answers;
   - write `analysis.md` (root-cause) and `fix-proposal.md` (the proposed fix
     with `[AFK]`/`[HITL]`-tagged remediation steps, each carrying a `verify:`
     clause and an `Author: patchwork-sre` line);
   - advance the status through `INVESTIGATING` to `ANALYSIS_READY`;
   - append its own attributed Board entry and self-check with the `patchwork`
     engine tools.

3. **Answer the triage questions.** As the Commander, respond to the SRE's 2–3
   questions (blast radius/severity, intended behavior of the failing path, any
   constraints on the fix). The SRE will not write analysis until you answer.

## Boundaries

- The SRE **proposes but never ships**: it is write-scoped to `patchwork/**`,
  has read-only git only (no push/merge/branch), and never performs or checks
  off a `[HITL]` step.
- This command does not itself write incident artifacts or the Board — the SRE
  agent owns that.
- The SRE never clears `[HITL]` steps; those are yours to clear later via
  `/human-itl`.

When the SRE reports `ANALYSIS_READY`, run `/review` to hand the fix proposal to
the independent Reviewer agent.
