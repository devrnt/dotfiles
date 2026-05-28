---
name: triage
description: >-
  Best-effort bulk triage of Jira backlog tickets. Parses Jira URLs (e.g.
  https://artion-eu.atlassian.net/browse/AP-964), pre-filters each ticket to
  avoid rabbit holes and risky changes, then spawns one Cursor SDK agent per
  surviving ticket in its own git worktree. Each agent produces a concise
  Context / Reproduction / Investigation / Proposal report. Uses the Atlassian
  MCP for ticket data and the dbhub MCP to validate assumptions against the
  database. Use when the user says "triage", "triage these tickets", "look at
  my backlog", pastes multiple Jira URLs, or wants a parallel low-risk first
  pass over backlog items. Also supports a single-ticket local-chat mode when
  the user wants to triage one ticket interactively instead of fanning out.
---

# Triage

Bulk, best-effort Jira triage. The target is explicitly **low-hanging fruit**: if half of a batch comes back with a clear reproduction and a small proposed fix, the skill has done its job. Anything that looks like it needs a breaking change, a schema migration, or architectural judgement must be punted back to a human with a short "why skipped" note.

## When to use this skill

Use when:

- The user pastes a list of Jira URLs (`https://<site>.atlassian.net/browse/AP-123`) and says "triage these" / "look at these".
- The user says "triage my backlog" and provides a JQL filter or named backlog view.
- The user wants a parallel pass over small tickets without babysitting each one.

Use the **single-ticket mode** (see below) when the user wants to investigate one specific ticket right here in chat instead of fanning out agents.

## Prerequisites (verify before doing anything else)

1. **Atlassian MCP is available.** Probe `user-Atlassian.getVisibleJiraProjects` via `CallMcpTool` to confirm it responds and to discover the `cloudId`. If it errors with auth, stop and ask the user to run `mcp_auth` for the Atlassian server.
2. **dbhub MCP is available** (optional but strongly preferred — this is how the agents check assumptions). Probe `user-dbhub.search_objects` with a harmless query. If unavailable, proceed with a warning; the report template just won't have DB-backed evidence.
3. **`~/.agents/skills/triage/.env` exists and contains `CURSOR_API_KEY`.** Check the file:
   - If the file does not exist: tell the user to run `cp ~/.agents/skills/triage/.env.example ~/.agents/skills/triage/.env` and open it in their editor to paste the key. Stop; do not proceed.
   - If the file exists but `CURSOR_API_KEY=` is empty or missing: tell the user which line to fill in. Stop.
   - **Never read, echo, or otherwise expose the key value.** Check only for presence: `grep -q '^CURSOR_API_KEY=.\+' ~/.agents/skills/triage/.env`. That returns exit 0 if a non-empty value is set, exit 1 otherwise. No value is ever printed.
   - Mint a key at https://cursor.com/dashboard → Integrations → API Keys if the user doesn't have one.
4. **Node 24.x** — `fnm use 24.12.0` (or `nvm use 24.12.0`) from the repo root. The orchestrator uses ESM and `await using`.

Print a one-line status for each of the four checks before proceeding. Example:

```
✅ Atlassian MCP reachable (cloudId=...)
✅ dbhub MCP reachable
✅ ~/.agents/skills/triage/.env has CURSOR_API_KEY set
✅ node v24.11.0
```

## Input

Accept any of:

- One or more Jira URLs: `https://artion-eu.atlassian.net/browse/AP-964`.
- One or more bare keys: `AP-964`, `ART-12`, etc.
- A JQL string the user confirms, e.g. `project = AP AND status = "Backlog" AND labels = "low-hanging-fruit" ORDER BY created DESC`.

Normalise to a deduped list of issue keys. Extract the Jira site host from the first URL to derive `cloudId` via `getVisibleJiraProjects`.

## Workflow

Follow these phases in order. Do not skip phase 1.

### Phase 1 — Pre-filter (no agents yet)

For **each** ticket key, in the current chat session:

1. Fetch the issue with `user-Atlassian.getJiraIssue` (fields: `summary`, `description`, `status`, `issuetype`, `priority`, `labels`, `components`, `fixVersions`, `attachment`, `comment`).
2. Classify into one of three buckets using the rules below. The bias is **strongly towards "skip"** — false positives waste agent budget, false negatives just delay a ticket by a day.

**Bucket A — Investigate (spawn an agent):**

- Bug reports with a clear user-facing symptom *and* at least one of: stack trace, error message, specific URL, specific step-to-reproduce.
- Small feature tweaks with an unambiguous acceptance criterion (e.g. "change copy from X to Y", "add column Z to table T").
- Tickets explicitly labelled `good-first-issue`, `low-hanging-fruit`, or `quick-win`.

**Bucket B — Skip, needs human (report but don't spawn):**

- Touches auth, billing, permissions, migrations, or anything in `containers/data-api/prisma/migrations/`.
- Requires a schema change, API contract change, or new environment variable.
- Description is one line with no reproduction and no attachments.
- Status is `In Progress`, `In Review`, or already has a linked PR.
- Priority is `Blocker` or `Critical` (those need a human first).
- Spans more than 3 distinct components/services in its `components` field.
- Acceptance criteria are subjective ("make it nicer", "improve UX") with no measurable target.

**Bucket C — Investigate in current chat (single-ticket local mode):**

Only used when the user explicitly asked for one ticket to be handled here. Skip the fan-out; jump to Phase 4 using the current agent session as the executor.

Emit a short table before moving on:

```
| Key    | Bucket | One-line reason                                          |
|--------|--------|----------------------------------------------------------|
| AP-964 | A      | bug with stack trace in description                      |
| AP-971 | B      | requires DB migration (containers/data-api/prisma/…)     |
| AP-982 | B      | one-line description, no repro                           |
```

Ask the user to confirm before spawning agents. Default to proceeding only with Bucket A.

### Phase 2 — Prepare worktrees

For each confirmed Bucket A ticket:

- Branch name: `triage/<key-lower>` (e.g. `triage/ap-964`).
- Worktree path: `<repo-root>/../.triage-worktrees/<key-lower>`.
- Base: `origin/main` (fetch first).
- If the branch or worktree already exists, suffix with `-<short-timestamp>` rather than failing.

The orchestrator script handles this. Do not do it by hand.

### Phase 3 — Fan out agents

Run the orchestrator from the repo root:

```bash
node ~/.agents/skills/triage/scripts/triage.mjs \
  --keys AP-964,AP-971,AP-982 \
  --cloud-id <cloudId-from-phase-1> \
  --site https://artion-eu.atlassian.net \
  --concurrency 4 \
  --out ./.triage-reports
```

The script:

1. Creates a worktree per key and checks out `triage/<key-lower>` from `origin/main`.
2. For each key, calls `Agent.create({ local: { cwd: worktree }, model: { id: "composer-2" }, mcpServers: { atlassian, dbhub } })`.
3. Sends the ticket-specific prompt (see [prompt-template.md](prompt-template.md)). Single turn — no follow-ups.
4. Streams the run and enforces a **wall-clock budget of 15 minutes per ticket**; calls `run.cancel()` on overrun.
5. Distinguishes `CursorAgentError` (didn't start) from `result.status === "error"` (ran and failed). Logs both with `agentId` and `runId`.
6. Writes one markdown report per ticket to `--out`. Always writes, even on failure — the report explains why there's no proposal.
7. Disposes every agent in a `finally`.
8. Emits a final summary table: key, status (`finished` / `error` / `startup-failed` / `skipped-timeout`), branch, report path.

First-time install of SDK deps:

```bash
cd ~/.agents/skills/triage && npm install
```

### Phase 4 — Single-ticket local mode

If the user wants to investigate one ticket interactively in the current chat, skip phases 2–3:

1. Fetch the ticket (Atlassian MCP).
2. Use the dbhub MCP to validate any assumptions directly (read-only queries only — see the [Guardrails](#guardrails) section).
3. Produce the same report structure (see [prompt-template.md](prompt-template.md)) as a chat response. Do not create a branch or worktree unless the user explicitly asks for a fix.

## Guardrails (apply to both modes)

- **Read-only database access.** dbhub queries must be `SELECT` / `EXPLAIN` only. Reject or refuse `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`.
- **No breaking changes.** If the fix requires changing an exported type, a public route, a Prisma schema, a migration, or any `.env*.example` key, stop and write that observation into the report instead of proceeding.
- **No cross-cutting refactors.** The diff (if any) should touch at most ~5 files and ~150 lines. Over that, stop and punt.
- **No external network calls from agents** beyond the MCPs and whatever the codebase already reaches.
- **Never force-push, never delete branches.** Worktrees are created and left in place so the human can inspect them.

## Report format

The orchestrator (and the single-ticket mode) must emit one markdown file per ticket using the template in [prompt-template.md](prompt-template.md). The four sections are non-negotiable: **Context**, **Reproduction**, **Investigation**, **Proposal**. Keep each under ~200 words. If a section is genuinely empty, write "none" — don't pad.

After all agents finish, the top-level summary the user sees in chat must be short:

```
Triage complete — 4/6 produced proposals.

✅ AP-964 — proposal ready: off-by-one in pagination (branch: triage/ap-964)
✅ AP-982 — proposal ready: missing translation key (branch: triage/ap-982)
⚠️  AP-990 — investigated, no safe fix (breaks API contract)
⚠️  AP-1003 — agent hit 15min budget, partial notes saved
⏭️  AP-971 — skipped in phase 1 (requires DB migration)
⏭️  AP-1011 — skipped in phase 1 (one-line description)

Reports: ./.triage-reports/
```

## What this skill does NOT do

- Open PRs. Branches are left local for the human to push and PR.
- Merge anything.
- Edit Jira (no comment, no status change, no assignee change) — unless the user explicitly asks after reviewing.
- Fix tickets that are already assigned to a human.

## Utility scripts

**`scripts/triage.mjs`** — the orchestrator described above. Run it with Node. See [scripts/README.md](scripts/README.md) for flags and examples.

**`scripts/triage.mjs --help`** — prints all flags.

## When things go wrong

- `CURSOR_API_KEY` missing → the orchestrator prints a multi-line hint pointing at `~/.agents/skills/triage/.env.example` and exits 1. Fix the `.env` file, rerun.
- `CURSOR_API_KEY` invalid → `CursorAgentError` on first `send()`. The script exits 1 with the SDK's error message (usually a 401). Usually a pasted-with-whitespace issue.
- `cloudId` lookup fails → Atlassian MCP not authenticated. Ask user to run `mcp_auth` for `user-Atlassian` and retry.
- Worktree creation fails because branch exists → the script auto-suffixes with a timestamp.
- An agent hangs → the 15-minute budget calls `run.cancel()`. Partial streamed output is saved to the report.
- Concurrency too high (machine saturates) → lower `--concurrency` (default 4). Each local agent spawns a real executor process.
