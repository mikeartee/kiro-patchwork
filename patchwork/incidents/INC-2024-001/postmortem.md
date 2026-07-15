# Post-mortem - INC-2024-001

Incident: INC-2024-001

Compiled by the Scribe agent from the incident artifact chain.

## Root cause

The checkout endpoint crashed with a TypeError when two or more coupon codes
were applied. Commit c9ac237 introduced a loyalty bonus path that reads
`lastApplied.tier.multiplier`, but no coupon in the catalogue carries a `tier`
property.

## Applied fix

Reverted to additive flat-discount stacking logic, removing the unimplemented
loyalty bonus branch. The reproduction test now passes.

## Review outcome

Reviewer agent (patchwork-reviewer) issued PASS at fix_version 1. The fix
addresses the null reference and satisfies the reproduction test contract.

## Source artifacts

- incident.md
- analysis.md
- fix-proposal.md
- review.md
- decision-log.md
