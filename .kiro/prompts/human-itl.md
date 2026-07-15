# /human-itl — walk the human through the [HITL] steps

Run this as the **Incident Commander** to clear the human-in-the-loop steps of a
fix. A `[HITL]` remediation step is an action only a human may safely perform —
rotating a credential, approving a rollback, clicking deploy. The engine's
RESOLVED gate stays closed until every `[HITL]` step is cleared, so this command
is the human authority that unblocks resolution.

This command never performs a step for you and never clears a step you have not
confirmed. It walks you through each one, and for each step you clear it records
an audit entry on the Board and checks the step off.

## What this command does

Work the incident `INC-<id>` you are given, reading its
`patchwork/incidents/INC-<id>/fix-proposal.md`.

1. **Enumerate the `[HITL]` steps.** Find every remediation step tagged
   `[HITL]`. A step is **uncleared** when it is a plain `- [HITL] …` item or an
   unchecked `- [ ] [HITL] …` item; it is **cleared** only when its task
   checkbox is checked: `- [x] [HITL] …`. List the uncleared ones and their
   `verify:` clauses.

2. **Walk each uncleared step, one at a time.** For each uncleared `[HITL]` step:
   - Present the action and its `verify:` clause to the Commander.
   - **Stop and wait** for the Commander to perform the action themselves and
     confirm both that it is done and that the verification passed. Never carry
     out the action, and never assume it happened.

3. **On the Commander's confirmation, clear the step:**
   - **Check the step off** in `fix-proposal.md` by rewriting that one line so it
     begins with a checked task checkbox before the tag — turn
     `- [HITL] …` (or `- [ ] [HITL] …`) into `- [x] [HITL] …`. Change nothing
     else on the line and nothing elsewhere in the file. The checked box is the
     exact marker the engine reads as "cleared".
   - **Append one audit Board entry** to `patchwork/board.md`, attributed to the
     Commander, recording the cleared step. Preserve every existing line. Use
     the exact grammar (separators are the middle dot `·`):

     ```text
     [<ISO-8601 UTC time>] @<commander-handle> · Incident Commander (human) · hitl-cleared: <the step action> — verified: <how it was confirmed>
     ```

     For example:
     `[2024-06-01T15:10Z] @alice · Incident Commander (human) · hitl-cleared: rotated the coupon-service API key — verified: new key deployed`

   Write **exactly one** audit entry per step you clear (Requirement 8.4).

4. **Self-check with the deterministic engine.** After clearing steps, call the
   `patchwork` `gate` tool for the `FIX_STAGED → RESOLVED` transition on
   `INC-<id>`. The gate opens only when every `[HITL]` step is cleared **and** a
   non-author `PASS` exists at the current `fix_version`. If it still reports an
   uncleared `[HITL]` step, a step was not checked off correctly — fix the marker
   and re-check. If it reports a missing/stale/self-authored PASS instead, the
   HITL side is done; resolution is simply waiting on review, which is expected.

## Boundaries

- `[HITL]` steps are yours alone. Never perform one, and never check one off
  without the Commander's explicit confirmation.
- `[AFK]` steps are out of scope for this command — leave them untouched.
- The Board is append-only: add audit entries, never rewrite or reorder
  existing ones, and do not disturb any part of `fix-proposal.md` other than the
  single checkbox on a step you are clearing.

When all `[HITL]` steps are cleared and a non-author `PASS` is recorded at the
current `fix_version`, the guardrail will allow the incident to reach
`RESOLVED`. After it resolves, run `/postmortem`.
