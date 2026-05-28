# triage scripts

## `triage.mjs`

Orchestrates a bulk triage pass. See `../SKILL.md` for the surrounding workflow.

### First-time setup

```bash
cd ~/.agents/skills/triage
npm install
chmod +x scripts/triage.mjs

cp .env.example .env
$EDITOR .env   # paste CURSOR_API_KEY, optionally set ATLASSIAN_MCP_CMD / DBHUB_MCP_CMD
```

`.env` is gitignored. The orchestrator loads it automatically; real shell env vars still win over the file if both are set.

### Running

From the repo root (so `git rev-parse --show-toplevel` resolves correctly):

```bash
node ~/.agents/skills/triage/scripts/triage.mjs \
  --keys AP-964,AP-982,AP-1003 \
  --cloud-id <uuid-from-getVisibleJiraProjects> \
  --site https://artion-eu.atlassian.net \
  --concurrency 4 \
  --out ./.triage-reports
```

### Flags

| Flag | Purpose |
| --- | --- |
| `--keys AP-1,AP-2` | Jira keys. Required. |
| `--cloud-id <uuid>` | Atlassian cloudId. Required. |
| `--site <url>` | Jira site base URL (for ticket links). Required. |
| `--concurrency <n>` | Parallel agents. Default 4. |
| `--out <dir>` | Where per-ticket reports go. Default `./.triage-reports`. |
| `--worktrees-root <dir>` | Where worktrees are created. Default `<repo>/../.triage-worktrees`. |
| `--dry-run` | Create the worktree plan but do not spawn agents. |

### Environment

The orchestrator loads `~/.agents/skills/triage/.env` automatically on startup. Anything already in the shell env takes precedence over the file.

- `CURSOR_API_KEY` — required (unless `--dry-run`). Mint at [Cursor dashboard → Integrations → API Keys](https://cursor.com/dashboard).
- `ATLASSIAN_MCP_CMD` — optional override for the Atlassian stdio MCP command. Default: `uvx mcp-atlassian`.
- `DBHUB_MCP_CMD` — optional override for the dbhub stdio MCP command. Default: `npx -y @dbhub/mcp`. **Point this at a Neon dev branch DSN, not prod.**

### Behaviour guarantees

- Each ticket gets its own branch `triage/<key-lower>` and its own worktree under `--worktrees-root`. Collisions are auto-suffixed with a timestamp.
- Every agent is wrapped in `try/finally` with `agent[Symbol.asyncDispose]()` — no leaked executors.
- `CursorAgentError` (didn't start) and `result.status === "error"` (started, failed) are distinguished in the exit code (`1` vs `2`) and in each report.
- A per-ticket 15-minute wall-clock budget calls `run.cancel()` on overrun.
- A markdown report is written for every ticket — including failures — so the summary is always actionable.
- The script never pushes or opens PRs. Branches are left local for the human.
