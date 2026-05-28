#!/usr/bin/env node
// Triage orchestrator — fans out Cursor SDK agents, one per Jira ticket, in isolated git worktrees.
// See ../SKILL.md for the full contract.

import { Agent, CursorAgentError } from "@cursor/sdk";
import { execa } from "execa";
import pLimit from "p-limit";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PER_TICKET_BUDGET_MS = 15 * 60 * 1000;
const DEFAULT_CONCURRENCY = 4;
const MODEL_ID = "composer-2";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ENV_PATH = path.join(SKILL_ROOT, ".env");
const SKILL_ENV_EXAMPLE_PATH = path.join(SKILL_ROOT, ".env.example");

async function loadSkillEnv() {
  let raw;
  try {
    raw = await fs.readFile(SKILL_ENV_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { loaded: false };
    throw error;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    const rawKey = trimmed.slice(0, equalsIndex).trim();
    let rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      rawValue = rawValue.slice(1, -1);
    }
    if (!(rawKey in process.env)) process.env[rawKey] = rawValue;
  }
  return { loaded: true };
}

function assertCursorKeyOrExplain(dryRun) {
  if (process.env.CURSOR_API_KEY && process.env.CURSOR_API_KEY.trim().length > 0) return;
  if (dryRun) return;
  const message = [
    "CURSOR_API_KEY is not set.",
    "",
    `Create ${SKILL_ENV_PATH} with your key:`,
    "",
    `  cp ${SKILL_ENV_EXAMPLE_PATH} ${SKILL_ENV_PATH}`,
    `  $EDITOR ${SKILL_ENV_PATH}`,
    "",
    "Or export it inline for this run only:",
    "",
    '  read -rs CURSOR_API_KEY && export CURSOR_API_KEY',
    "",
    "Get a key at https://cursor.com/dashboard (Integrations → API Keys).",
  ].join("\n");
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { keys: [], concurrency: DEFAULT_CONCURRENCY };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[++index];
    switch (token) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--keys":
        args.keys = next()
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean);
        break;
      case "--cloud-id":
        args.cloudId = next();
        break;
      case "--site":
        args.site = next().replace(/\/+$/, "");
        break;
      case "--concurrency":
        args.concurrency = Number(next());
        break;
      case "--out":
        args.out = next();
        break;
      case "--worktrees-root":
        args.worktreesRoot = next();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        throw new Error(`Unknown flag: ${token}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`triage — fan out Cursor SDK agents per Jira ticket

Usage:
  node scripts/triage.mjs --keys AP-123,AP-456 --cloud-id <uuid> --site https://<org>.atlassian.net [options]

Required:
  --keys <CSV>         Jira issue keys, comma-separated.
  --cloud-id <uuid>    Atlassian cloudId (from getVisibleJiraProjects).
  --site <url>         Jira site base URL (used for ticket links in reports).

Options:
  --concurrency <n>    Parallel agents. Default: ${DEFAULT_CONCURRENCY}.
  --out <dir>          Where per-ticket markdown reports go. Default: ./.triage-reports.
  --worktrees-root <d> Where to create worktrees. Default: <repo-root>/../.triage-worktrees.
  --dry-run            Plan only; do not spawn agents or create worktrees.
  -h, --help           This message.

Environment (loaded from ~/.agents/skills/triage/.env; shell env takes precedence):
  CURSOR_API_KEY       Required. https://cursor.com/dashboard (Integrations → API Keys)
  ATLASSIAN_MCP_CMD    Optional stdio command for the Atlassian MCP the agents use
                       (default: "uvx mcp-atlassian").
  DBHUB_MCP_CMD        Optional stdio command for the dbhub MCP
                       (default: "npx -y @dbhub/mcp").

First-time setup:
  cd ~/.agents/skills/triage && npm install && cp .env.example .env
  # then edit .env and paste your CURSOR_API_KEY
`);
}

async function getRepoRoot() {
  const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

async function ensureWorktree({ key, repoRoot, worktreesRoot }) {
  await execa("git", ["fetch", "origin", "main"], { cwd: repoRoot });

  const lowerKey = key.toLowerCase();
  let branch = `triage/${lowerKey}`;
  let worktreePath = path.join(worktreesRoot, lowerKey);

  const branchExists = await execa(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoRoot, reject: false },
  );
  const worktreeExists = await fs
    .stat(worktreePath)
    .then(() => true)
    .catch(() => false);

  if (branchExists.exitCode === 0 || worktreeExists) {
    const suffix = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    branch = `triage/${lowerKey}-${suffix}`;
    worktreePath = `${worktreePath}-${suffix}`;
  }

  await fs.mkdir(worktreesRoot, { recursive: true });
  await execa("git", ["worktree", "add", "-b", branch, worktreePath, "origin/main"], {
    cwd: repoRoot,
  });

  return { branch, worktreePath };
}

function buildPrompt({ key, site, branch }) {
  const ticketUrl = `${site}/browse/${key}`;
  return `You are triaging Jira ticket ${key} as part of a best-effort bulk pass.
Ticket: ${ticketUrl}
Branch: ${branch}
Worktree: the current working directory, already checked out from origin/main.

Your goal is a CONCISE report — Context, Reproduction, Investigation, Proposal —
for a human reviewer. The reviewer will decide whether to ship your fix.

Hard rules:
- You have ONE turn and a 15-minute wall-clock budget. Do not ask follow-up questions.
- Read-only database access only. SELECT and EXPLAIN are fine via the dbhub MCP.
  Reject any DML/DDL.
- DO NOT make breaking changes. If the fix would change a Prisma schema, a migration,
  an exported type, a public route, or a required env var — STOP and report
  "no safe change — needs human" with one sentence of why.
- The diff (if any) must touch at most ~5 files and ~150 lines.
- Use the Atlassian MCP (getJiraIssue) to re-read the ticket and any linked issues.
- Use the dbhub MCP to verify assumptions about data shape whenever relevant.

Output format — emit EXACTLY this markdown, no preamble, no trailing chat:

# ${key} — <one-line issue summary>

**Ticket:** ${ticketUrl}
**Branch:** ${branch}
**Status:** finished | error | no-safe-change
**Agent run:** <will be filled by the caller — leave as "inline" here>

## Context
<~150 words, who is affected and what they asked for>

## Reproduction
<numbered, concrete steps; or "none" if impossible to infer>

## Investigation
<bullet list, each bullet cites a file:line or an MCP query as evidence>

## Proposal
<smallest safe change, with files touched, ~30 lines of code sketch, a one-line
test plan, and an explicit "risks / what could this break" line. Or the literal
string "no safe change — needs human" with one sentence explaining why.>

If you decide to implement the fix, do so in this worktree (you're already on
${branch}). Make a single focused commit with a conventional message. Do not
push. Do not open a PR. After committing, the human will review the branch.

If you will NOT implement a fix (no safe change, or needs human), still emit the
report above with Status: no-safe-change and Proposal explaining why. Do not
leave uncommitted scratch files in the worktree in that case.

Begin.
`;
}

function buildMcpServers() {
  const atlassianCommand = (process.env.ATLASSIAN_MCP_CMD || "uvx mcp-atlassian").split(" ");
  const dbhubCommand = (process.env.DBHUB_MCP_CMD || "npx -y @dbhub/mcp").split(" ");
  return {
    atlassian: {
      type: "stdio",
      command: atlassianCommand[0],
      args: atlassianCommand.slice(1),
    },
    dbhub: {
      type: "stdio",
      command: dbhubCommand[0],
      args: dbhubCommand.slice(1),
    },
  };
}

async function writeReport({ outDir, key, content }) {
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, `${key}.md`);
  await fs.writeFile(reportPath, content, "utf8");
  return reportPath;
}

async function runOneTicket({ key, repoRoot, worktreesRoot, outDir, site, mcpServers, dryRun }) {
  const started = Date.now();
  const base = { ticket: key, status: "startup-failed", branch: null, worktreePath: null };

  let worktree;
  try {
    worktree = await ensureWorktree({ key, repoRoot, worktreesRoot });
  } catch (error) {
    const report = [
      `# ${key} — worktree setup failed`,
      "",
      `**Status:** error`,
      "",
      "## Context",
      "Could not prepare a git worktree for this ticket. The ticket was not investigated.",
      "",
      "## Reproduction",
      "none",
      "",
      "## Investigation",
      `- Worktree setup threw: \`${error.message}\``,
      "",
      "## Proposal",
      "no safe change — needs human",
      "",
    ].join("\n");
    const reportPath = await writeReport({ outDir, key, content: report });
    return { ...base, error: error.message, reportPath };
  }

  if (dryRun) {
    return {
      ...base,
      status: "dry-run",
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
    };
  }

  const prompt = buildPrompt({ key, site, branch: worktree.branch });
  let agent;
  let runId;
  let streamed = "";
  try {
    agent = Agent.create({
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: MODEL_ID },
      local: { cwd: worktree.worktreePath },
      mcpServers,
    });

    const run = await agent.send(prompt);
    runId = run.id;
    process.stderr.write(`[${key}] agentId=${agent.agentId} runId=${run.id}\n`);

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (run.supports("cancel")) {
        run.cancel().catch(() => {});
      }
    }, PER_TICKET_BUDGET_MS);

    try {
      for await (const event of run.stream()) {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text") streamed += block.text;
          }
        }
      }
      const result = await run.wait();
      clearTimeout(timeout);

      const effectiveStatus = timedOut
        ? "timeout"
        : result.status === "finished"
          ? "finished"
          : "error";

      const content = streamed.trim().length
        ? streamed.trim() + `\n\n<!-- agentId=${agent.agentId} runId=${run.id} status=${effectiveStatus} elapsedMs=${Date.now() - started} -->\n`
        : renderFallbackReport({ key, site, branch: worktree.branch, status: effectiveStatus, runId: run.id });

      const reportPath = await writeReport({ outDir, key, content });

      return {
        ticket: key,
        status: effectiveStatus,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        agentId: agent.agentId,
        runId: run.id,
        reportPath,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const isStartup = error instanceof CursorAgentError;
    const report = renderFallbackReport({
      key,
      site,
      branch: worktree.branch,
      status: isStartup ? "startup-failed" : "error",
      runId,
      errorMessage: error.message,
      partial: streamed,
    });
    const reportPath = await writeReport({ outDir, key, content: report });
    return {
      ticket: key,
      status: isStartup ? "startup-failed" : "error",
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      agentId: agent?.agentId,
      runId,
      reportPath,
      error: error.message,
    };
  } finally {
    if (agent) {
      await agent[Symbol.asyncDispose]().catch(() => {});
    }
  }
}

function renderFallbackReport({ key, site, branch, status, runId, errorMessage, partial }) {
  const lines = [
    `# ${key} — no agent output`,
    "",
    `**Ticket:** ${site}/browse/${key}`,
    `**Branch:** ${branch}`,
    `**Status:** ${status}`,
    `**Agent run:** ${runId ?? "n/a"}`,
    "",
    "## Context",
    "The triage agent did not produce a structured report. Raw context below.",
    "",
    "## Reproduction",
    "none",
    "",
    "## Investigation",
    errorMessage ? `- Agent error: \`${errorMessage}\`` : "- Agent produced no text output.",
    "",
    "## Proposal",
    "no safe change — needs human",
    "",
  ];
  if (partial && partial.trim().length) {
    lines.push("## Partial agent output", "", "```", partial.trim(), "```", "");
  }
  return lines.join("\n");
}

function renderSummary(results) {
  const emojiFor = (status) => {
    switch (status) {
      case "finished":
        return "✅";
      case "timeout":
        return "⚠️";
      case "error":
      case "startup-failed":
        return "❌";
      case "dry-run":
        return "📝";
      default:
        return "•";
    }
  };
  const lines = [
    "",
    `Triage complete — ${results.filter((result) => result.status === "finished").length}/${results.length} produced proposals.`,
    "",
  ];
  for (const result of results) {
    lines.push(
      `${emojiFor(result.status)} ${result.ticket} — ${result.status} (branch: ${result.branch ?? "n/a"}, report: ${result.reportPath ?? "n/a"})`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  const envLoaded = await loadSkillEnv();
  if (!args.keys.length) throw new Error("Pass --keys AP-1,AP-2 (comma-separated).");
  if (!args.cloudId) throw new Error("Pass --cloud-id <uuid> (from getVisibleJiraProjects).");
  if (!args.site) throw new Error("Pass --site https://<org>.atlassian.net.");
  assertCursorKeyOrExplain(Boolean(args.dryRun));
  if (envLoaded.loaded) process.stderr.write(`triage: loaded env from ${SKILL_ENV_PATH}\n`);

  const repoRoot = await getRepoRoot();
  const worktreesRoot = args.worktreesRoot
    ? path.resolve(args.worktreesRoot)
    : path.resolve(repoRoot, "..", ".triage-worktrees");
  const outDir = args.out ? path.resolve(args.out) : path.resolve(repoRoot, ".triage-reports");
  const mcpServers = buildMcpServers();
  const limit = pLimit(Math.max(1, args.concurrency));

  process.stderr.write(
    `triage: ${args.keys.length} ticket(s), concurrency=${args.concurrency}, worktrees=${worktreesRoot}, reports=${outDir}\n`,
  );

  const results = await Promise.all(
    args.keys.map((key) =>
      limit(() =>
        runOneTicket({
          key,
          repoRoot,
          worktreesRoot,
          outDir,
          site: args.site,
          mcpServers,
          dryRun: Boolean(args.dryRun),
        }),
      ),
    ),
  );

  process.stdout.write(renderSummary(results));

  const anyStartupFailure = results.some((result) => result.status === "startup-failed");
  const allFailed = results.every((result) => result.status === "error" || result.status === "startup-failed");
  if (anyStartupFailure) return 1;
  if (allFailed) return 2;
  return 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (error) => {
    process.stderr.write(`triage: ${error.stack ?? error.message}\n`);
    process.exit(1);
  },
);
