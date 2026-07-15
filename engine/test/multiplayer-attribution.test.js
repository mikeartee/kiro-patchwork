// Multiplayer-attribution tests (task 13.2, Requirement 15:
//   15.1 the shared git repository IS the synchronization mechanism.
//   15.2 a committed contribution is attributed to a DISTINCT commit author.
//   15.3 the Board RETAINS contributions from multiple distinct participants
//        and roles across synchronizations.
//   15.4 participants work asynchronously; git HISTORY reconciles contributions
//        rather than a real-time/live-server connection).
//
// ===========================================================================
// HONEST SCOPE — what is REAL git verification vs. a MODELED proxy
// ===========================================================================
// The design's multiplayer story is deliberately server-less: "multiplayer is
// achieved through shared git history and distinct commit authors rather than a
// live server" (design Overview; Req 15.1/15.4). This suite therefore models
// participants working ASYNCHRONOUSLY as divergent git branches and reconciles
// them with a real merge — never a network/live connection.
//
//   REAL GIT (actually executed here — the primary evidence):
//     * A throwaway repo is initialised in a temp dir. Four participants
//       (a human Incident Commander + the SRE/Reviewer/Scribe agents) each
//       append a distinct Board_Entry on their OWN branch under a DISTINCT
//       `--author`, then the branches are merged back. The Board file
//       (`board.md`) carries a committed `merge=union` attribute, which is
//       git's idiomatic reconciliation for an append-only shared log: on a
//       divergent append, git keeps BOTH sides (nothing is lost). We assert the
//       merged Board retains ALL four entries, that `git log` records DISTINCT
//       commit authors (Req 15.2), that reconciliation happened via merge
//       commits in history (Req 15.1), and that NO remote/live server is
//       involved (Req 15.4). The repo is deleted afterwards.
//
//   MODELED PROXY (deterministic, git-independent — the belt-and-suspenders):
//     * One test models the same thing purely in memory: two independent append
//       STREAMS sharing a common base entry are reconciled by union + a
//       chronological sort, using the REAL `parseBoardEntry` grammar. This runs
//       even where git is unavailable, so the retention/attribution property is
//       always covered. It is labelled a MODEL, not a real sync.
//
// The task allows EITHER a real repo OR an in-memory model; we prefer the real
// repo (git is present and the merge is fast + reliable) and keep the model as a
// deterministic complement. NO test performs network I/O.
//
// _Requirements: 15.1, 15.2, 15.3, 15.4_

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseBoardEntry, isSchemaError } from '../core/schema.js';
import { validate } from '../core/validate.js';

const DOT = '\u00B7'; // middle-dot separator between board-entry fields
const DASH = '\u2014'; // em dash used inside a free-text description

// ---------------------------------------------------------------------------
// Participants. The Commander's report is the shared base (T0); the three
// agents each contribute asynchronously on their own branch (T1..T3). Times are
// strictly increasing so a chronological timeline has an unambiguous order, and
// the branches are merged in that same order (a Scribe reconciling the room in
// time order). @who authors are all distinct, and roles cover a HUMAN commander
// plus AGENT roles — the "two or more roles" collaboration signal (Req 15.3).
// ---------------------------------------------------------------------------

const COMMANDER = {
  time: '2024-06-01T14:03Z',
  who: 'alice',
  role: 'Incident Commander',
  kind: 'human',
  type: 'report',
  desc: '/checkout 500s on coupon stacking',
  authorName: 'Alice Commander',
  authorEmail: 'alice@corp.test',
};

// The three agents, each on its own divergent branch off the base commit.
const AGENTS = [
  {
    time: '2024-06-01T14:07Z',
    who: 'patchwork-sre',
    role: 'SRE',
    kind: 'agent',
    type: 'analysis',
    desc: 'root cause traced to commit a1b2c3d',
    authorName: 'patchwork-sre',
    authorEmail: 'sre@corp.test',
    branch: 'sre',
  },
  {
    time: '2024-06-01T14:20Z',
    who: 'patchwork-reviewer',
    role: 'Reviewer',
    kind: 'agent',
    type: 'verdict',
    desc: `NEEDS_WORK ${DASH} fix misses the null branch`,
    authorName: 'patchwork-reviewer',
    authorEmail: 'reviewer@corp.test',
    branch: 'reviewer',
  },
  {
    time: '2024-06-01T14:25Z',
    who: 'patchwork-scribe',
    role: 'Scribe',
    kind: 'agent',
    type: 'decision',
    desc: 'logged the reviewer verdict and next steps',
    authorName: 'patchwork-scribe',
    authorEmail: 'scribe@corp.test',
    branch: 'scribe',
  },
];

const ALL_PARTICIPANTS = [COMMANDER, ...AGENTS];

/** Render a participant as a schema-valid Board_Entry line. */
function boardLine(p) {
  return `[${p.time}] @${p.who} ${DOT} ${p.role} (${p.kind}) ${DOT} ${p.type}: ${p.desc}`;
}

// ---------------------------------------------------------------------------
// git helpers (real repo). All calls run with an isolated config environment so
// the test is hermetic — it never reads the developer's global/system git
// config (which might set signing, hooks, or an autocrlf that would perturb the
// fixture). A missing `git` binary flips GIT_AVAILABLE so the real-git tests
// skip gracefully; the modeled test below still covers the property.
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devnull,
  GIT_CONFIG_SYSTEM: os.devnull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: 'file', // belt-and-suspenders: never touch the network
};

let GIT_AVAILABLE = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', env: GIT_ENV });
  GIT_AVAILABLE = true;
} catch {
  GIT_AVAILABLE = false;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchwork-mp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Build the async-multiplayer scenario in a REAL git repo and return the
 * directory plus the reconciled board text.
 *
 * Topology (server-less, Req 15.1/15.4):
 *   base (main)     : Commander files the report  -> author alice
 *     ├── branch sre     : appends the SRE line     -> author patchwork-sre
 *     ├── branch reviewer: appends the Reviewer line -> author patchwork-reviewer
 *     └── branch scribe  : appends the Scribe line  -> author patchwork-scribe
 *   main <- merge sre, then reviewer, then scribe (--no-ff, chronological order)
 *
 * board.md carries a committed `merge=union` attribute, so each divergent
 * append is reconciled by KEEPING BOTH sides — the append-only Board loses
 * nothing across synchronizations (Req 15.3).
 */
function buildRealRepo(t) {
  const dir = makeTempRepo(t);
  const boardPath = path.join(dir, 'board.md');

  git(dir, ['init', '-q', '-b', 'main']);
  // A fixed COMMITTER identity; contribution AUTHORS are set per-commit via
  // --author, which is what Req 15.2 ("distinct commit author") is about.
  git(dir, ['config', 'user.name', 'Patchwork Test']);
  git(dir, ['config', 'user.email', 'ci@patchwork.test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']); // keep the fixture byte-stable

  // The union merge driver is the reconciliation mechanism; commit the
  // attribute BEFORE branching so every branch inherits it.
  fs.writeFileSync(path.join(dir, '.gitattributes'), 'board.md merge=union\n');

  // Base commit: the Commander's report (the shared ancestor every agent
  // branches from).
  const header = ['# Patchwork Board', ''].join('\n');
  fs.writeFileSync(boardPath, `${header}\n${boardLine(COMMANDER)}\n`);
  git(dir, ['add', '-A']);
  git(dir, [
    'commit',
    '-q',
    `--author=${COMMANDER.authorName} <${COMMANDER.authorEmail}>`,
    '-m',
    'report: incident filed',
  ]);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();

  // Each agent works ASYNCHRONOUSLY on its own branch off the base commit.
  for (const agent of AGENTS) {
    git(dir, ['checkout', '-q', '-b', agent.branch, base]);
    fs.appendFileSync(boardPath, `${boardLine(agent)}\n`);
    git(dir, [
      'commit',
      '-q',
      '-am',
      `${agent.type}: ${agent.who}`,
      `--author=${agent.authorName} <${agent.authorEmail}>`,
    ]);
  }

  // Reconcile onto main in chronological order. --no-ff forces a merge commit
  // so the reconciliation is visible in history (Req 15.1); the reviewer and
  // scribe merges are genuinely divergent and exercise the union driver.
  git(dir, ['checkout', '-q', 'main']);
  for (const agent of AGENTS) {
    git(dir, ['merge', '--no-ff', '-m', `reconcile ${agent.branch}`, agent.branch]);
  }

  return { dir, board: fs.readFileSync(boardPath, 'utf8') };
}

// Timeline lines are those whose first non-whitespace char is "[" (mirrors
// validate()'s isBoardTimelineLine); header/prose lines are skipped.
function timelineLines(boardText) {
  return boardText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('['));
}

// ===========================================================================
// REAL GIT — 1. Board retention across synchronizations (Req 15.3)
// ===========================================================================

test(
  'real git: the Board retains EVERY participant contribution after divergent branches are reconciled (Req 15.3)',
  { skip: GIT_AVAILABLE ? false : 'git binary not available' },
  (t) => {
    const { board } = buildRealRepo(t);

    // Union reconciliation must not leave conflict markers behind.
    for (const marker of ['<<<<<<<', '=======', '>>>>>>>']) {
      assert.ok(!board.includes(marker), `merged board must contain no "${marker}" conflict marker`);
    }

    // Set-retention: every participant's exact entry line survived the merge.
    // (Set-based, so it is robust to the union driver's interleaving.)
    const present = new Set(timelineLines(board));
    for (const p of ALL_PARTICIPANTS) {
      assert.ok(
        present.has(boardLine(p)),
        `merged board must retain the ${p.role} entry from @${p.who}`,
      );
    }
    // No spurious/duplicated timeline entries: exactly the four contributions.
    assert.equal(
      timelineLines(board).length,
      ALL_PARTICIPANTS.length,
      'the merged board must hold exactly one entry per participant (none lost, none duplicated)',
    );

    // Every retained line is a schema-valid Board_Entry, and the reconciled
    // board passes the engine's own validate() (well-formed, append-only shape).
    const validation = validate({ board, incidents: {} });
    assert.equal(
      validation.ok,
      true,
      `reconciled board must pass validate(): ${JSON.stringify(validation.problems)}`,
    );

    // Order consistent with an append-only, CHRONOLOGICAL timeline: because the
    // branches were merged in timestamp order and the Board is append-only, the
    // reconciled entries appear in non-decreasing time order (ISO-8601 strings
    // sort lexically). This is the "visible history in chronological order"
    // signal (Req 15.3; cf. Req 2.5).
    const times = timelineLines(board).map((line) => {
      const parsed = parseBoardEntry(line);
      assert.ok(!isSchemaError(parsed), `retained line must parse: ${line}`);
      return parsed.time;
    });
    const sorted = [...times].sort();
    assert.deepEqual(times, sorted, 'reconciled entries must be in chronological order');
    assert.deepEqual(
      times,
      ALL_PARTICIPANTS.map((p) => p.time),
      'the chronological order must match report -> analysis -> verdict -> decision',
    );
  },
);

// ===========================================================================
// REAL GIT — 2. Distinct commit authors + distinct participants/roles
//               (Req 15.2, 15.3)
// ===========================================================================

test(
  'real git: each contribution is committed under a DISTINCT author, and the entries carry distinct @who authors across a human + agent roles (Req 15.2, 15.3)',
  { skip: GIT_AVAILABLE ? false : 'git binary not available' },
  (t) => {
    const { dir, board } = buildRealRepo(t);

    // (a) DISTINCT COMMIT AUTHORS (Req 15.2). The four CONTRIBUTION commits
    // (non-merge: the base report + one per agent branch) must each carry a
    // different author. Merge commits are excluded — they are the Scribe-style
    // reconciliation bookkeeping, not a participant's contribution.
    const contribAuthors = git(dir, ['log', '--no-merges', '--format=%ae'])
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const expectedAuthors = ALL_PARTICIPANTS.map((p) => p.authorEmail).sort();
    assert.deepEqual(
      [...contribAuthors].sort(),
      expectedAuthors,
      'the contribution commits must be authored by exactly the four distinct participants',
    );
    assert.equal(
      new Set(contribAuthors).size,
      ALL_PARTICIPANTS.length,
      'every contribution commit must have a distinct author (no shared identity)',
    );
    assert.ok(new Set(contribAuthors).size >= 2, 'at least two distinct commit authors (Req 15.2)');

    // (b) DISTINCT PARTICIPANTS + ROLES on the Board itself (Req 15.3). Parse
    // the retained entries and assert the @who handles are all distinct and the
    // roles cover a HUMAN Incident Commander plus at least one AGENT role.
    const parsed = timelineLines(board).map((line) => {
      const entry = parseBoardEntry(line);
      assert.ok(!isSchemaError(entry), `board entry must parse: ${line}`);
      return entry;
    });

    const whos = parsed.map((e) => e.who);
    assert.equal(new Set(whos).size, whos.length, 'every Board entry must have a distinct @who author');

    const roles = new Set(parsed.map((e) => e.role));
    assert.ok(roles.size >= 2, `two or more roles must appear on the Board, saw: ${[...roles].join(', ')}`);

    const kinds = new Set(parsed.map((e) => e.kind));
    assert.ok(kinds.has('human'), 'a human participant must appear');
    assert.ok(kinds.has('agent'), 'at least one agent participant must appear');
    assert.ok(
      parsed.some((e) => e.role === 'Incident Commander' && e.kind === 'human'),
      'the human Incident Commander must be among the retained contributions',
    );
  },
);

// ===========================================================================
// REAL GIT — 3. Reconciliation is via git history, NOT a live server
//               (Req 15.1, 15.4)
// ===========================================================================

test(
  'real git: contributions are reconciled through git history (merge commits), asynchronously, with NO remote/live server (Req 15.1, 15.4)',
  { skip: GIT_AVAILABLE ? false : 'git binary not available' },
  (t) => {
    const { dir } = buildRealRepo(t);

    // Req 15.4 — server-less: the repo has NO configured remote, so there is no
    // real-time/live connection; reconciliation relied only on local history.
    const remotes = git(dir, ['remote']).trim();
    assert.equal(remotes, '', 'the repo must have no remote configured (no live server)');

    // Req 15.1 — the shared repository IS the sync mechanism: reconciliation is
    // recorded as MERGE commits in history (one per agent branch integrated).
    const mergeCommits = git(dir, ['log', '--merges', '--format=%H'])
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(
      mergeCommits.length,
      AGENTS.length,
      'history must record one reconciliation merge commit per agent branch',
    );

    // Req 15.4 — ASYNC isolation: BEFORE reconciliation, each agent's branch
    // tip held ONLY its own contribution plus the shared base (it could not see
    // the others), which is exactly how asynchronous participants work. We prove
    // this from history via `git show <branch>:board.md`.
    for (const agent of AGENTS) {
      const branchBoard = git(dir, ['show', `${agent.branch}:board.md`]);
      const lines = new Set(timelineLines(branchBoard));
      assert.ok(lines.has(boardLine(COMMANDER)), `${agent.branch} must include the shared base entry`);
      assert.ok(lines.has(boardLine(agent)), `${agent.branch} must include its own contribution`);
      for (const other of AGENTS) {
        if (other === agent) continue;
        assert.ok(
          !lines.has(boardLine(other)),
          `${agent.branch} must NOT yet contain @${other.who}'s entry (async, pre-reconciliation)`,
        );
      }
    }
  },
);

// ===========================================================================
// MODELED PROXY (git-independent) — always runs
// ===========================================================================
// A deterministic, in-memory stand-in for the sync above: two independent
// append STREAMS that share the Commander's base entry are reconciled by
// dedup-union + a chronological sort, using the REAL parseBoardEntry grammar.
// This is explicitly a MODEL of git reconciliation (not a real sync); it
// guarantees the retention/attribution property is covered even where git is
// unavailable. It mirrors the task's alternative "concatenate/merge independent
// append streams and assert set-retention + chronological order".

/** Reconcile append streams: union by exact line, then chronological sort. */
function reconcileStreams(streams) {
  const seen = new Set();
  const merged = [];
  for (const stream of streams) {
    for (const line of stream) {
      if (seen.has(line)) continue; // a shared base entry appears in both streams
      seen.add(line);
      merged.push(line);
    }
  }
  return merged.sort((a, b) => {
    const ta = parseBoardEntry(a);
    const tb = parseBoardEntry(b);
    assert.ok(!isSchemaError(ta) && !isSchemaError(tb), 'streams must contain valid entries');
    return ta.time < tb.time ? -1 : ta.time > tb.time ? 1 : 0;
  });
}

test('modeled sync: reconciling independent append streams retains all distinct contributions in chronological order (Req 15.3)', () => {
  const base = boardLine(COMMANDER);

  // Two participants sync at different times, each having pulled the base entry.
  // Stream A: Commander base + SRE. Stream B: Commander base + Reviewer + Scribe.
  const streamA = [base, boardLine(AGENTS[0])];
  const streamB = [base, boardLine(AGENTS[1]), boardLine(AGENTS[2])];

  const reconciled = reconcileStreams([streamA, streamB]);

  // Retention: the shared base is de-duplicated, and every distinct
  // contribution survives — exactly one entry per participant.
  assert.equal(reconciled.length, ALL_PARTICIPANTS.length, 'one retained entry per participant');
  const present = new Set(reconciled);
  for (const p of ALL_PARTICIPANTS) {
    assert.ok(present.has(boardLine(p)), `reconciled stream must retain @${p.who}'s entry`);
  }

  // Chronological order (Req 15.3 / 2.5).
  const times = reconciled.map((l) => parseBoardEntry(l).time);
  assert.deepEqual(times, ALL_PARTICIPANTS.map((p) => p.time), 'entries must be chronological');

  // Distinct authors + a human + agent roles (Req 15.2/15.3 signals).
  const entries = reconciled.map((l) => parseBoardEntry(l));
  assert.equal(new Set(entries.map((e) => e.who)).size, entries.length, 'distinct @who authors');
  assert.ok(new Set(entries.map((e) => e.role)).size >= 2, 'two or more roles appear');
  const kinds = new Set(entries.map((e) => e.kind));
  assert.ok(kinds.has('human') && kinds.has('agent'), 'a human and at least one agent contribute');

  // The reconciled Board is well-formed per the engine's own validator.
  const validation = validate({ board: reconciled.join('\n'), incidents: {} });
  assert.equal(validation.ok, true, `modeled board must validate: ${JSON.stringify(validation.problems)}`);
});
