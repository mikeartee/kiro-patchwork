# Requirements Document

## Introduction

Kiro Patchwork is a shared, file-based incident-response workspace where a human and a team of AI agents work an incident from first symptom through a verified post-mortem and a staged fix. The workspace files are the single source of truth: every idea, decision, artifact, and contribution is recorded in a shared `patchwork/` directory that lives in one repository. The system is packaged as a Kiro Power so an entire team can install identical agent behavior into their own IDEs and collaborate against the same repo, with multiplayer achieved through shared git history and distinct commit authors rather than a live server.

The human acts as the Incident Commander who approves and decides. Three custom agents each play a well-defined, scoped role: an SRE agent that investigates and proposes (but never ships), an adversarial reviewer on a different model family whose mandate is to refute the proposed fix, and a scribe that maintains an append-only decision log and compiles the final post-mortem. A small deterministic protocol engine, exposed as both a CLI and an MCP server, enforces the workspace schema, the incident state machine, and a fail-closed review gate so that correctness does not depend on model judgment alone.

This feature is built for the Kiro "multiplayer workspace" birthday challenge. It is designed to satisfy the challenge's collaboration signals and deliverables:

- **Signal 1 (human adds to shared workspace):** Requirement 2, Requirement 8
- **Signal 2 (agent responds using shared context):** Requirement 4, Requirement 5, Requirement 7
- **Signal 3 (agent creates/updates a shared artifact):** Requirement 4, Requirement 5, Requirement 7
- **Signal 4 (human can approve/reject/edit/respond):** Requirement 8, Requirement 12
- **Signal 5 (two or more roles appear):** Requirement 4, Requirement 5, Requirement 7
- **Signal 6 (visible history of contributions):** Requirement 2, Requirement 7, Requirement 15
- **Signal 7 (final output from collaboration, not a single prompt):** Requirement 7
- **Deliverables (repo, README, explanation, env examples, demo):** Requirement 16

## Glossary

- **Patchwork**: The overall incident-response system, packaged as a Kiro Power, comprising the shared workspace protocol, three custom agents, a deterministic protocol engine, and onboarding.
- **Patchwork_Workspace**: The shared `patchwork/` directory that serves as the single source of truth for all incidents. Contains the Board and one subdirectory per incident.
- **Board**: The `patchwork/board.md` file; an attributed, append-only, chronological timeline of every human and agent contribution across incidents.
- **Incident_Directory**: A `patchwork/incidents/INC-<id>/` directory holding the artifacts for a single incident (`incident.md`, `analysis.md`, `fix-proposal.md`, `review.md`, `decision-log.md`, `postmortem.md`).
- **Incident_Record**: The `incident.md` file whose YAML frontmatter carries the incident identifier, title, and the incident status enum value.
- **Incident_Status**: The state of an incident, drawn from the ordered enum: REPORTED, INVESTIGATING, ANALYSIS_READY, AWAITING_APPROVAL, APPROVED, FIX_STAGED, RESOLVED, plus the branch states CHANGES_REQUESTED and PARKED_FOR_HUMAN.
- **Board_Entry**: A single timeline line in the Board using the format `[time] @who · Role (human|agent) · type:` followed by a short description.
- **Incident_Commander**: The human participant who reports incidents, answers triage questions, approves or rejects proposed fixes, and clears human-only remediation steps.
- **SRE_Agent**: The custom agent `patchwork-sre` that investigates an incident using the Sample_App logs and git history, asks triage questions, and authors `analysis.md` and `fix-proposal.md`. Write-scoped to `patchwork/**` with read-only git access and no push, merge, or branch capability.
- **Reviewer_Agent**: The custom agent `patchwork-reviewer`, running on a different model family from the SRE_Agent, whose mandate is to attempt to refute a proposed fix and to author `review.md`. Read-only except for writing `review.md`.
- **Scribe_Agent**: The custom agent `patchwork-scribe` that maintains the append-only `decision-log.md` and compiles `postmortem.md` from the incident artifact chain.
- **Protocol_Engine**: The deterministic Node engine that implements the `validate`, `gate`, and `verdict` commands over the Patchwork_Workspace.
- **Patchwork_CLI**: The command-line interface exposing the Protocol_Engine commands, invoked deterministically by the Guardrail_Hook.
- **Patchwork_MCP_Server**: The MCP (stdio) server exposing the Protocol_Engine commands as `validate`, `gate`, and `verdict` tools that agents call to self-check.
- **Verdict**: The final line of `review.md`, of the form `VERDICT: PASS` or `VERDICT: NEEDS_WORK`, parsed by the Protocol_Engine.
- **Non_Author_Rule**: The integrity constraint that the agent that authored `fix-proposal.md` cannot be the same agent that authors the PASS Verdict for that fix version.
- **Guardrail_Hook**: A Kiro hook, installed during onboarding, that invokes the Patchwork_CLI to block the transition to RESOLVED and any ship command unless a non-author PASS Verdict exists for the current fix version and all HITL steps are cleared.
- **Remediation_Step**: A single action in a fix or resolution plan, tagged either `[AFK]` (an agent may perform the action) or `[HITL]` (a human must perform the action), each paired with a verification check.
- **HITL_Step**: A Remediation_Step tagged `[HITL]` requiring human action, such as approving a rollback, rotating a credential, or clicking deploy.
- **Round_Cap**: The configured maximum number of SRE_Agent-to-Reviewer_Agent revision cycles permitted before the incident is parked for the human.
- **Onboarding**: The Power's first-use process that validates dependencies, installs the Guardrail_Hook into `.kiro/hooks/`, and scaffolds the Patchwork_Workspace.
- **Sample_App**: A local, deliberately vulnerable Node application in `sample-app/` with a planted bug, seeded log files, real git history, and a failing reproduction test, used to ground investigation and review.

## Requirements

### Requirement 1: Shared workspace scaffold

**User Story:** As an Incident Commander, I want a standard shared workspace structure created on first use, so that every human and agent reads and writes from one agreed source of truth.

#### Acceptance Criteria

1. WHEN Onboarding runs for the first time in a repository, THE Patchwork SHALL create the Patchwork_Workspace directory containing the Board file.
2. WHEN a new incident is opened, THE Patchwork SHALL create an Incident_Directory named `patchwork/incidents/INC-<id>/` containing an Incident_Record.
3. THE Incident_Record SHALL contain YAML frontmatter with an incident identifier, a title, and an Incident_Status value.
4. WHERE an Incident_Directory reaches the resolution stage, THE Patchwork SHALL contain the artifact set `incident.md`, `analysis.md`, `fix-proposal.md`, `review.md`, `decision-log.md`, and `postmortem.md` within that Incident_Directory.
5. IF a required workspace file or directory is missing when the Protocol_Engine validate command runs, THEN THE Protocol_Engine SHALL report the missing path and exit with a non-zero status.

### Requirement 2: Attributed append-only board timeline

**User Story:** As a team member, I want every contribution recorded on an attributed, append-only timeline, so that the full history of who did what and when is visible to everyone.

#### Acceptance Criteria

1. WHEN a human or an agent makes a contribution to an incident, THE Patchwork SHALL append one Board_Entry to the Board.
2. THE Board_Entry SHALL use the format `[time] @who · Role (human|agent) · type:` followed by a short description.
3. THE Board SHALL preserve all existing Board_Entry lines when a new Board_Entry is appended.
4. IF a Board_Entry omits the author field, the role field, or the contribution type field, THEN THE Protocol_Engine validate command SHALL report the malformed entry and exit with a non-zero status.
5. WHEN the Board is read, THE Patchwork SHALL present Board_Entry lines in chronological order of contribution.

### Requirement 3: Incident state machine

**User Story:** As an Incident Commander, I want each incident to advance through a defined set of states, so that the current stage of every incident is unambiguous.

#### Acceptance Criteria

1. WHEN an incident is first reported, THE Patchwork SHALL set the Incident_Status to REPORTED.
2. THE Patchwork SHALL permit an Incident_Status transition only along the ordered path REPORTED to INVESTIGATING to ANALYSIS_READY to AWAITING_APPROVAL to APPROVED to FIX_STAGED to RESOLVED.
3. WHEN the Reviewer_Agent records a NEEDS_WORK Verdict, THE Patchwork SHALL set the Incident_Status to CHANGES_REQUESTED.
4. WHILE an incident is in CHANGES_REQUESTED, THE Patchwork SHALL allow the Incident_Status to return to INVESTIGATING for revision.
5. IF a requested Incident_Status transition is not defined in the state machine, THEN THE Protocol_Engine gate command SHALL reject the transition and exit with a non-zero status.

### Requirement 4: SRE agent investigation and artifacts

**User Story:** As an Incident Commander, I want the SRE agent to investigate using the shared evidence and propose a fix, so that a grounded analysis exists without the agent being able to ship changes.

#### Acceptance Criteria

1. WHEN the SRE_Agent begins an investigation, THE SRE_Agent SHALL read the Sample_App logs and git history to gather evidence.
2. WHEN the SRE_Agent starts an investigation, THE SRE_Agent SHALL ask the Incident_Commander between two and three triage questions before writing analysis.
3. WHEN the SRE_Agent completes an investigation, THE SRE_Agent SHALL write a root-cause analysis to `analysis.md` and a proposed fix to `fix-proposal.md`.
4. WHEN the SRE_Agent has written the analysis and fix proposal, THE Patchwork SHALL set the Incident_Status to ANALYSIS_READY.
5. THE SRE_Agent SHALL restrict file writes to paths under `patchwork/**`.
6. IF the SRE_Agent attempts a git push, git merge, or git branch operation, THEN THE Patchwork SHALL deny the operation.

### Requirement 5: Adversarial review and fail-closed verdict

**User Story:** As an Incident Commander, I want an independent agent to try to refute the proposed fix and record a clear verdict, so that weak fixes are caught before approval.

#### Acceptance Criteria

1. WHEN a fix proposal is ready for review, THE Reviewer_Agent SHALL attempt to refute the proposed fix using the incident evidence and write findings to `review.md`.
2. THE Reviewer_Agent SHALL end `review.md` with a Verdict line of exactly `VERDICT: PASS` or `VERDICT: NEEDS_WORK`.
3. IF the Verdict line is missing, malformed, or ambiguous, THEN THE Protocol_Engine verdict command SHALL treat the review as NEEDS_WORK.
4. THE Reviewer_Agent SHALL run on a different model family from the SRE_Agent.
5. THE Reviewer_Agent SHALL restrict file writes to the `review.md` file of the incident under review.

### Requirement 6: Review integrity and injection hardening

**User Story:** As an Incident Commander, I want the reviewer to resist manipulation and never rubber-stamp its own team's work, so that the review gate is trustworthy.

#### Acceptance Criteria

1. THE Reviewer_Agent SHALL treat the incident content and the fix proposal as untrusted input.
2. IF the incident content or the fix proposal contains embedded instructions such as directions to approve the fix, THEN THE Reviewer_Agent SHALL disregard the embedded instructions and continue the adversarial review.
3. IF the agent that authored `fix-proposal.md` is the same agent that authored a PASS Verdict for the current fix version, THEN THE Protocol_Engine gate command SHALL reject the PASS Verdict under the Non_Author_Rule.
4. WHEN the Protocol_Engine evaluates the review gate for a fix version, THE Protocol_Engine SHALL require a non-author PASS Verdict recorded against that same fix version.

### Requirement 7: Scribe decision log and post-mortem compilation

**User Story:** As a team member, I want a scribe agent to keep a running decision log and compile the final post-mortem, so that the outcome is a synthesized artifact drawn from the whole collaboration.

#### Acceptance Criteria

1. WHEN a decision is recorded during an incident, THE Scribe_Agent SHALL append an entry to `decision-log.md`.
2. THE Scribe_Agent SHALL preserve all existing entries in `decision-log.md` when appending a new entry.
3. WHEN an incident reaches RESOLVED, THE Scribe_Agent SHALL compile `postmortem.md` from the Incident_Record, `analysis.md`, `fix-proposal.md`, `review.md`, and `decision-log.md`.
4. THE compiled `postmortem.md` SHALL reference the incident identifier, the root cause, the applied fix, and the review outcome.

### Requirement 8: Human approval and HITL clearing

**User Story:** As an Incident Commander, I want to approve or reject the proposed fix and clear the steps only a human can perform, so that human authority gates the resolution.

#### Acceptance Criteria

1. WHEN an incident enters AWAITING_APPROVAL, THE Patchwork SHALL require an explicit approval or rejection from the Incident_Commander before further progress.
2. WHEN the Incident_Commander approves a fix, THE Patchwork SHALL set the Incident_Status to APPROVED.
3. WHEN the Incident_Commander rejects a fix, THE Patchwork SHALL set the Incident_Status to CHANGES_REQUESTED.
4. WHEN the Incident_Commander clears an HITL_Step, THE Patchwork SHALL append an audit Board_Entry attributed to the Incident_Commander recording the cleared step.
5. IF one or more HITL_Steps for an incident remain uncleared, THEN THE Protocol_Engine gate command SHALL reject the transition to RESOLVED.

### Requirement 9: Remediation step tagging and verification

**User Story:** As an Incident Commander, I want each remediation step labeled by who can perform it and paired with a verification check, so that responsibilities and completion criteria are explicit.

#### Acceptance Criteria

1. THE Patchwork SHALL tag each Remediation_Step as either `[AFK]` or `[HITL]`.
2. THE Patchwork SHALL pair each Remediation_Step with a verification check describing how completion of the step is confirmed.
3. WHERE a Remediation_Step is tagged `[HITL]`, THE Patchwork SHALL require the Incident_Commander to perform the step.
4. IF a Remediation_Step lacks a tag or lacks a verification check, THEN THE Protocol_Engine validate command SHALL report the incomplete step and exit with a non-zero status.

### Requirement 10: Deterministic protocol engine (CLI and MCP)

**User Story:** As a team member, I want a deterministic engine that checks the workspace, transitions, and verdicts, so that correctness does not depend on agent judgment and can be relied upon by hooks and agents alike.

#### Acceptance Criteria

1. THE Protocol_Engine SHALL provide a `validate` command that checks the Patchwork_Workspace against the workspace schema.
2. THE Protocol_Engine SHALL provide a `gate` command that determines whether a requested Incident_Status transition is permitted.
3. THE Protocol_Engine SHALL provide a `verdict` command that parses the Verdict line from `review.md`.
4. THE Patchwork SHALL expose the `validate`, `gate`, and `verdict` commands through the Patchwork_CLI.
5. THE Patchwork SHALL expose the `validate`, `gate`, and `verdict` commands as tools through the Patchwork_MCP_Server over stdio.
6. WHEN the Protocol_Engine is given identical workspace inputs, THE Protocol_Engine SHALL return identical results for the same command.

### Requirement 11: Guardrail ship gate

**User Story:** As an Incident Commander, I want a hook that blocks resolution or shipping unless the fix has passed independent review, so that unreviewed changes cannot be marked resolved.

#### Acceptance Criteria

1. WHEN a transition to RESOLVED is requested, THE Guardrail_Hook SHALL invoke the Patchwork_CLI gate command to evaluate the request.
2. IF no non-author PASS Verdict exists for the current fix version, THEN THE Guardrail_Hook SHALL block the transition to RESOLVED.
3. IF a ship command is invoked while the review gate is not satisfied, THEN THE Guardrail_Hook SHALL block the ship command.
4. WHEN the review gate is satisfied and all HITL_Steps are cleared, THE Guardrail_Hook SHALL allow the transition to RESOLVED.

### Requirement 12: Round-cap escape to human

**User Story:** As an Incident Commander, I want an incident parked for me when the SRE and reviewer cannot converge, so that unproductive loops surface to a human decision.

#### Acceptance Criteria

1. THE Patchwork SHALL track the number of SRE_Agent-to-Reviewer_Agent revision cycles for each incident.
2. IF the number of revision cycles reaches the Round_Cap without a PASS Verdict, THEN THE Patchwork SHALL set the Incident_Status to PARKED_FOR_HUMAN.
3. WHILE an incident is in PARKED_FOR_HUMAN, THE Patchwork SHALL require an Incident_Commander decision before further agent revision cycles proceed.
4. WHEN an incident is set to PARKED_FOR_HUMAN, THE Patchwork SHALL append a Board_Entry recording that the Round_Cap was reached.

### Requirement 13: Kiro Power packaging and onboarding

**User Story:** As a team member, I want to install Patchwork as a Kiro Power that activates on incident keywords and sets itself up, so that every member's IDE runs identical agent behavior against the shared repo.

#### Acceptance Criteria

1. THE Patchwork SHALL provide a `POWER.md` file at the repository root containing frontmatter fields for name, displayName, description, keywords, and author, plus onboarding steps and steering.
2. WHERE incident-related keywords such as incident, outage, error, root cause, or postmortem appear, THE Patchwork SHALL activate and load the associated steering and MCP tools.
3. WHEN Onboarding runs, THE Patchwork SHALL validate that the Node dependency required by the Protocol_Engine is available.
4. WHEN Onboarding runs, THE Patchwork SHALL install the Guardrail_Hook into `.kiro/hooks/` and scaffold the Patchwork_Workspace.
5. THE Patchwork SHALL provide the SRE_Agent, Reviewer_Agent, and Scribe_Agent definitions in the repository `.kiro/agents/` directory.
6. THE Patchwork SHALL be installable from a public GitHub repository and from a local folder through the IDE Powers panel.

### Requirement 14: Sample app grounding

**User Story:** As an Incident Commander, I want a local sample application with a planted bug and real evidence, so that the agents' investigation and review are grounded in reproducible facts.

#### Acceptance Criteria

1. THE Sample_App SHALL contain a planted defect associated with an identifiable git commit.
2. THE Sample_App SHALL include seeded log files under `sample-app/logs/` that reflect the planted defect.
3. THE Sample_App SHALL include a reproduction test that fails while the planted defect is present.
4. WHEN the SRE_Agent investigates, THE Sample_App SHALL provide the git history and logs used as the evidence base for `analysis.md`.
5. THE Sample_App SHALL operate as a local-only application and SHALL NOT be configured for deployment.

### Requirement 15: Multiplayer via shared repository

**User Story:** As a team member, I want collaboration to flow through the shared repository with distinct authorship, so that multiple participants and roles visibly contribute without needing a live server.

#### Acceptance Criteria

1. THE Patchwork SHALL treat the shared git repository as the synchronization mechanism between participants.
2. WHEN a participant commits a contribution, THE Patchwork SHALL attribute the contribution to a distinct commit author.
3. THE Board SHALL retain contributions from multiple distinct participants and roles across synchronizations.
4. WHERE participants work asynchronously, THE Patchwork SHALL rely on git history rather than a real-time connection to reconcile contributions.

### Requirement 16: Challenge deliverables

**User Story:** As a challenge submitter, I want the required deliverables produced, so that the submission is complete and reproducible by reviewers.

#### Acceptance Criteria

1. THE Patchwork SHALL provide a README documenting installation, the collaboration flow, and how to run the demo.
2. THE Patchwork SHALL provide a written explanation of the Kiro and agentic-development approach between 150 and 300 words.
3. THE Patchwork SHALL provide environment variable examples that contain no real secrets.
4. THE Patchwork SHALL provide a demonstrable end-to-end flow that carries a seeded incident from report to compiled `postmortem.md`.

### Requirement 17: Read-only room dashboard (optional)

**User Story:** As a team member, I want an optional at-a-glance view of the incident room, so that current status and recent contributions are easy to scan.

#### Acceptance Criteria

1. WHERE the dashboard feature is enabled, THE Patchwork SHALL present the current Incident_Status for each incident.
2. WHERE the dashboard feature is enabled, THE Patchwork SHALL present recent Board_Entry lines.
3. WHERE the dashboard feature is enabled, THE Patchwork SHALL operate as a read-only view that does not modify the Patchwork_Workspace.
