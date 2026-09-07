# PROMPTS.md — one phase, one block

`phasekit run <phase>` finds the `## Phase <phase>` heading below and sends the fenced
block under it verbatim. Nothing else in this file reaches the agent, so the block has to
stand on its own.

Every block opens with a verification of the one before it. If a check fails:
**stop and report, do not repair silently and do not continue.**

---

## Phase 0 — Baseline & De-Chunking Cleanup

Nothing precedes this one, so the check is a baseline reading rather than a verification.

```
Read AGENT-RULES.md and PLAN.md.

CHECK FIRST: run the gates from PLAN.md section 1.1 (`npm test`) and report the exact
result of each test suite. This is the starting baseline; record it in your final
report so later phases have something to compare against. If something is broken in a
way PLAN.md does not describe, tell me before touching anything.

THEN: execute PHASE 0 in order. Follow the rules of engagement in section 1.2. For
each task: make the change, run the gates, update any documentation the change
invalidates, commit separately with a Conventional Commit message, and tick the task
in the ledger (section 9).

If a task turns out to be wrong or impossible, stop and report instead of
improvising. Do not start Phase 1.
```

---

## Phase 1 — Manifest V3 Side Panel & YouTube Seek Bridge

```
Read AGENT-RULES.md and PLAN.md.

CHECK FIRST — verify Phase 0 actually landed, do not trust the ledger:
  1. The gates (section 1.1) are all green (`npm test`).
  2. Grep `modules/config.js` for "chunking" — returns 0 matches.
  3. Grep `popup.html` for "split-select-inline" or "chip-merge" — returns 0 matches.
  4. Every Phase 0 box in the ledger is ticked AND has a commit behind it in git log.
Report each as pass or fail. If any fails, STOP and tell me — do not fix it silently
and do not continue into Phase 1.

THEN: execute PHASE 1 in order. Same rules as always: one commit per task, gates
green, docs updated in the same commit, ledger ticked. Stop at the end of the phase.
```

---

## Phase 2 — Universal Streaming LLM Client

```
Read AGENT-RULES.md and PLAN.md.

CHECK FIRST — verify Phase 1 actually landed, do not trust the ledger:
  1. The gates (section 1.1) are all green (`npm test`).
  2. `manifest.json` contains "sidePanel" permission and "side_panel" declaration.
  3. `content_youtube.js` exists and handles SEEK_TO message.
  4. Every Phase 1 box in the ledger is ticked AND has a commit behind it in git log.
Report each as pass or fail. If any fails, STOP and tell me — do not fix it silently
and do not continue into Phase 2.

THEN: execute PHASE 2 in order. Same rules as always: one commit per task, gates
green, docs updated in the same commit, ledger ticked. Stop at the end of the phase.
```

---

## Phase 3 — Streamlined Side Panel UI & Controller

```
Read AGENT-RULES.md and PLAN.md.

CHECK FIRST — verify Phase 2 actually landed, do not trust the ledger:
  1. The gates (section 1.1) are all green (`npm test`).
  2. `modules/llm-stream.js` exists and exports `streamCompletion`.
  3. Every Phase 2 box in the ledger is ticked AND has a commit behind it in git log.
Report each as pass or fail. If any fails, STOP and tell me — do not fix it silently
and do not continue into Phase 3.

THEN: execute PHASE 3 in order. Same rules as always: one commit per task, gates
green, docs updated in the same commit, ledger ticked. Stop at the end of the phase.
```

---

## Phase 4 — Background Routing & Verification

```
Read AGENT-RULES.md and PLAN.md.

CHECK FIRST — verify Phase 3 actually landed, do not trust the ledger:
  1. The gates (section 1.1) are all green (`npm test`).
  2. `sidepanel.html`, `sidepanel.css`, and `sidepanel.js` exist.
  3. Every Phase 3 box in the ledger is ticked AND has a commit behind it in git log.
Report each as pass or fail. If any fails, STOP and tell me — do not fix it silently
and do not continue into Phase 4.

THEN: execute PHASE 4 in order. Same rules as always: one commit per task, gates
green, docs updated in the same commit, ledger ticked. Stop at the end of the phase.
```

---

## resume

Use when you do not remember where a run stopped.

```
Read AGENT-RULES.md and PLAN.md. Look at the progress ledger, run the gates, and check
whether the last ticked task is actually reflected in the code — a ticked box with no
matching commit means a session ended early, and uncommitted edits in `git status` mean
one ended mid-task. Then tell me which task is genuinely next and what it involves.
Change nothing.
```

---

## task — any single task

Used automatically by `phasekit run <task>` whenever the target has a dot in it.

```
Read AGENT-RULES.md.

The task itself is quoted at the end of this prompt. Do not read all of PLAN.md:
grep it for the one line you need (the ledger row, a neighbouring task) instead.

CHECK FIRST: the gates are green, the working tree is clean, and the task
immediately before {{TASK}} in the ledger is both ticked and backed by a commit in
git log. Report each; if any fails, STOP and tell me.

THEN: execute task {{TASK}} and nothing else. Respect every constraint listed under
it — those are the invariants the task is most likely to break.

NEVER end your turn waiting on something. This runs unattended: there is no next
turn. No notification will reach you, no monitor will fire, nothing will wake you
up — ending the turn ends the process, and takes every background task you started
down with it. Run the gates and test suites in the FOREGROUND and let the call block.

One commit. Gates green before it. Documentation updated in the same commit. Tick
the ledger. Then stop.

Keep the context small as you work: read the part of a file you need rather than
the whole file, pipe long command output through `tail`, and never read a lock file.

--- the task, quoted from PLAN.md ---

{{SECTION}}
```

---

## audit

```
Read AGENT-RULES.md and PLAN.md, then check the documentation against the code. Report
what is stale, what is untrue, and any invariant with no test covering it. Cross-check
the ledger against the git log: every ticked task should have a commit behind it.
Change nothing.
```
