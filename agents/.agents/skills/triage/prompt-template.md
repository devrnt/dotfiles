# Triage report template

Every ticket — whether triaged by a fan-out agent or in the current chat session — must produce a report with exactly these four sections, in this order. Missing sections must be written as `none` rather than omitted.

```markdown
# [KEY] — [Issue summary]

**Ticket:** https://<site>/browse/<KEY>
**Branch:** triage/<key-lower> (or "none" for single-ticket mode)
**Status:** finished | error | timeout | skipped
**Agent run:** <runId> (or "n/a")

## Context

What does this ticket actually ask for, in one short paragraph? Rephrase the
reporter's description in neutral terms. Include the affected area (page,
service, table, endpoint) and who is affected (role, tenant).

Max ~150 words.

## Reproduction

Concrete, minimal steps. Prefer a runnable form:

1. Go to `/installations/<id>`
2. Click "Create report" with an empty date range
3. Observe 500 in network tab / stack trace below

Include the exact error message / stack trace / screenshot reference if one
was attached to the ticket. If the ticket has no reproduction and none could
be inferred, say so explicitly and mark this section "none".

## Investigation

What did the agent actually check? Be specific. One bullet per finding,
each with the evidence:

- `containers/data-api/src/routes/installations.ts:142` — the handler passes
  `req.query.from` to Prisma without null-checking, which throws when the
  query parameter is omitted (confirms the stack trace).
- `dbhub`: `SELECT COUNT(*) FROM installations WHERE created_at IS NULL` →
  0 rows, so the upstream data is fine.
- Cross-referenced ticket AP-912 which fixed a similar issue in
  `organisations.ts` — same pattern, same fix.

If the investigation hit a wall (needs a breaking change, needs a migration,
unclear business intent), write one bullet explaining where and why, then
stop. Do not speculate further.

## Proposal

The smallest safe change that would resolve the ticket. If no safe change
exists, write "no safe change — needs human" and explain why in one
sentence.

When a fix is proposed, it must include:

- Files and rough line counts touched.
- The code change (or a short sketch), no more than ~30 lines.
- A one-line test plan (`npm test -- installations.test.ts`, a curl, a UI step).
- An explicit "risks / what could this break" line — always present, even
  if the answer is "nothing, it's a pure bugfix in a single handler".

Keep this section under ~200 words. If the proposed diff exceeds ~150
lines or ~5 files, stop and move this to "no safe change — needs human".
```

## Length budget

The entire report — all four sections — should be under ~800 words. A triage report that has to be scrolled isn't triage. If the investigation genuinely needs more detail, link out to a longer doc or a Confluence page rather than inflating the report.

## Anti-patterns

- **No "maybe", "could be", "I think"**. If it's unverified, say "not verified" and move on.
- **No restating the ticket in the Investigation section.** The Context section already did that.
- **No "next steps" section.** The Proposal *is* the next step. Either propose a concrete change or punt cleanly.
- **No code blocks in Context or Reproduction.** Those are for prose and numbered steps. Code blocks belong in Investigation (evidence) and Proposal (the change).
