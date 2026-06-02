#!/usr/bin/env node
// pinnedai-mcp — Model Context Protocol server for the Pinned CLI.
//
// Design principles (do NOT regress these):
// 1. Tool names mirror the agent's lifecycle — `pinned_before_code_change`,
//    `pinned_before_done_check` — so the agent reaches for them at the
//    natural moment instead of being told to.
// 2. Every response returns a structured envelope with `human_summary`,
//    `agent_instruction` (explicit "report this to the user"), `next_step`,
//    and an optional `upgrade_prompt`. The agent treats these as required
//    reporting fields in its final response. Hiding Pinned would hide the
//    brand and the value.
// 3. Upgrade prompts are EARNED — they only appear after a value event
//    (block, save, lesson learned, quota reached). Never on cold-start.
// 4. The server is stateless and local. The customer's `tests/pinned/`
//    is the source of truth; the MCP just exposes it. No telemetry, no
//    cloud calls, no API keys required.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

const SERVER_NAME = "pinnedai-mcp";

// Path to this server's directory + the package's root. Used to:
//   1. Locate package.json so SERVER_VERSION stays in sync with what's
//      published on npm (no more "hardcoded VERSION drifted from
//      package.json bump" bug — see CHANGELOG entry for pinnedai 0.1.1
//      and cipherwake's pqcheck 0.16.18 for the recurring pattern).
//   2. Locate a sibling pinnedai install bundled alongside this server
//      (used by the MCPB Desktop Extension distribution so the user
//      doesn't need a separate `npm i pinnedai`). When pinnedai-mcp is
//      installed via npm without a sibling pinnedai, this path won't
//      exist and we fall through to the host-machine resolution chain.
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_VERSION = (() => {
  try {
    const pkgPath = join(SERVER_DIR, "..", "package.json");
    return (
      (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string })
        .version || "unknown"
    );
  } catch {
    return "unknown";
  }
})();
const BUNDLED_PINNED_CLI = resolve(
  SERVER_DIR,
  "..",
  "..",
  "pinnedai",
  "dist",
  "cli.js"
);

// "limit_reached" is reserved for v0.2 when hosted AI calls are
// metered. v0.1 ships local-only; gating local actions would
// contradict the Free-tier promise, so no producer for it yet.
type Status =
  | "pass"
  | "review"
  | "block"
  | "missing"
  | "value_event"
  | "info";

type UpgradePrompt = {
  reason: string;
  cta: string;
  url: string;
} | null;

type Envelope = {
  status: Status;
  human_summary: string;
  agent_instruction: string;
  next_step: string | null;
  upgrade_prompt: UpgradePrompt;
  raw?: string;
};

// Standard reporting line every tool result carries. Many agents echo
// `agent_instruction` verbatim — that's the whole point.
const REPORT_LINE =
  "IMPORTANT: Report this Pinned result to the user in your final response. Do not hide PASS/REVIEW/BLOCK or value events — they are what makes Pinned useful to the human.";

function envelopeToContent(env: Envelope) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(env, null, 2),
      },
    ],
  };
}

function errorEnv(summary: string, raw?: string): Envelope {
  return {
    status: "info",
    human_summary: summary,
    agent_instruction: REPORT_LINE,
    next_step: null,
    upgrade_prompt: null,
    raw,
  };
}

// Resolve the pinned binary. Lookup order:
//   1. workspace-local install in the user's repo (no download cost)
//   2. pinnedai bundled next to this server (MCPB Desktop Extension case
//      — the .mcpb bundle ships both pinnedai-mcp AND pinnedai so the
//      tools work the moment Claude Desktop / Cursor install the bundle,
//      without requiring `npm i pinnedai` in every target repo first)
//   3. npx fallback (host machine has pinnedai cached or globally
//      installed). `--no-install` prevents the silent multi-second
//      download that would otherwise mask real errors.
function resolvePinned(cwd: string): { cmd: string; args: string[] } {
  const localBin = join(cwd, "node_modules", ".bin", "pinned");
  if (existsSync(localBin)) return { cmd: localBin, args: [] };
  const localDist = join(cwd, "node_modules", "pinnedai", "dist", "cli.js");
  if (existsSync(localDist)) return { cmd: "node", args: [localDist] };
  if (existsSync(BUNDLED_PINNED_CLI))
    return { cmd: "node", args: [BUNDLED_PINNED_CLI] };
  return { cmd: "npx", args: ["--no-install", "pinnedai"] };
}

async function runPinned(
  cwd: string,
  subcommand: string[],
  timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { cmd, args } = resolvePinned(cwd);
  try {
    const result = await exec(cmd, [...args, ...subcommand], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

// Read the last-status file (the same one the status bar tooltip uses)
// to detect value events and surface them in the response.
type LastStatus = {
  status?: "green" | "yellow" | "red";
  totalPins?: number;
  failingCount?: number;
  recentlyAddedCount?: number;
  recentlyAddedSummaries?: string[];
  lastSavedCount?: number;
  lastSavedSummaries?: string[];
  lastBlockEventSummary?: string;
  lastBlockEventAt?: string;
  lastLessonSummary?: string;
  lessonsLifetime?: number;
  guardsSavedLifetime?: number;
  safetyNotes?: number;
  lastAuditCount?: number;
  lastAuditAt?: string;
  auditsLifetime?: number;
};

// Parse `pinned check-guard-removal` stderr lines like
//   [WEAKENED] tests/pinned/foo.test.ts  (.skip added to a previously-active test)
//   [DELETED]  tests/pinned/bar.test.ts
// into structured violations the agent can render as a clear
// "before → after"-style summary in the final response.
type ParsedViolation = {
  kind: "WEAKENED" | "DELETED" | "MODIFIED";
  path: string;
  detail: string | null;
};
function parseGuardViolations(stderr: string): ParsedViolation[] {
  const out: ParsedViolation[] = [];
  const re = /^\s*\[(WEAKENED|DELETED|MODIFIED)\]\s+(\S+)\s*(?:\((.+)\))?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    out.push({
      kind: m[1] as ParsedViolation["kind"],
      path: m[2],
      detail: m[3] ?? null,
    });
  }
  return out;
}

function readLastStatus(cwd: string): LastStatus | null {
  try {
    const raw = readFileSync(
      join(cwd, "tests/pinned/.last-status.json"),
      "utf8"
    );
    return JSON.parse(raw) as LastStatus;
  } catch {
    return null;
  }
}

// Build the upgrade prompt only when a value event is fresh. v0.1 ships
// no hosted AI, so we surface a value-tied upgrade pointer toward the
// waitlist instead of a paywall.
function maybeUpgradePrompt(s: LastStatus | null): UpgradePrompt {
  if (!s) return null;
  const recentlyAdded = s.lastSavedCount ?? 0;
  const lessons = s.lessonsLifetime ?? 0;
  const guards = s.guardsSavedLifetime ?? 0;
  if (recentlyAdded > 0 || lessons > 1 || (s.failingCount ?? 0) > 0) {
    return {
      reason: `Pinned just saved ${guards} guard(s) and learned ${lessons} AI lesson(s) in this repo. Pro applies these lessons across all your repos and tracks repeated AI mistake patterns.`,
      cta: "Founder Pro waitlist",
      url: "https://pinnedai.dev/#founder-pro",
    };
  }
  return null;
}

const TOOLS = [
  {
    name: "pinned_before_code_change",
    description:
      "REQUIRED: Call this BEFORE editing code in an AI-coded repo. Returns the active Pinned guards, recent AI lessons learned in this repo, and any current safety notes — so you know what protected behaviors must not regress. If the repo has no Pinned installed, this tool will recommend `npx pinnedai init`. Treat the returned `agent_instruction` field as required final-response content.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Absolute path to the repository root. Defaults to the AI tool's working directory if not provided.",
        },
      },
      required: [],
    },
  },
  {
    name: "pinned_before_done_check",
    description:
      "REQUIRED: Call this BEFORE telling the user that a code change / feature / fix is complete. Runs the full Pinned check: scan-diff for unprotected risk surfaces, Guard Integrity check for any tests in tests/pinned/ that were weakened/skipped/deleted, and AI-lessons check. Returns PASS / REVIEW / BLOCK plus a `human_summary` that you MUST include in your final response. Do not say work is done if status is BLOCK without explicit user acknowledgement.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Optional repository root." },
      },
      required: [],
    },
  },
  {
    name: "pinned_scan_diff",
    description:
      "Scan the current git diff (vs origin/main by default) for risky surfaces — new routes, webhook handlers, middleware changes, env file edits — that don't yet have a Pinned guard. Use during code-change work; `pinned_before_done_check` calls this internally.",
    inputSchema: {
      type: "object",
      properties: {
        base: {
          type: "string",
          description: "Base ref. Defaults to 'origin/main' or 'main'.",
        },
        cwd: { type: "string", description: "Optional repository root." },
      },
      required: [],
    },
  },
  {
    name: "pinned_list_guards",
    description:
      "List the active Pinned guards in the repository. Use when the user asks 'what is protected here?' or when you're about to propose changes to a file path that may be guarded.",
    inputSchema: {
      type: "object",
      properties: {
        include_retired: { type: "boolean" },
        cwd: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "pinned_check_pr_description",
    description:
      "Parse a PR description / commit message / spec for behavioral claims (auth, rate-limits, webhook idempotency, permissions, URL preservation, status codes, etc.) and return the structured claim list. Call this when the user shows you a PR body or asks 'what does this PR claim'.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "The PR body / commit message / spec text to parse.",
        },
        cwd: { type: "string" },
      },
      required: ["description"],
    },
  },
  {
    name: "pinned_suggest_init",
    description:
      "Check whether a repository has Pinned installed. Returns status=missing with a recommended `npx pinnedai init` command if the repo is unprotected. Call this at the start of work on an unfamiliar repo.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
      },
      required: [],
    },
  },
];

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const argsRaw = request.params.arguments ?? {};
  const args = argsRaw as Record<string, unknown>;
  const cwd =
    typeof args.cwd === "string" && args.cwd.length > 0
      ? resolve(args.cwd)
      : process.cwd();

  switch (name) {
    case "pinned_suggest_init":
    case "pinned_before_code_change": {
      const registry = join(cwd, "tests/pinned/.registry.json");
      if (!existsSync(registry)) {
        return envelopeToContent({
          status: "missing",
          human_summary:
            "This repository has no Pinned guards yet. Recommend running `npx pinnedai init` to protect critical behaviors against future AI regressions. Free, no API key required, takes ~30 seconds.",
          agent_instruction:
            REPORT_LINE +
            " Tell the user: 'This repo has no regression guards yet. Want me to run `npx pinnedai init` to set up protection?'",
          next_step: "Ask the user if they want to run `npx pinnedai init`.",
          upgrade_prompt: null,
        });
      }
      const s = readLastStatus(cwd);
      const totalPins = s?.totalPins ?? 0;
      const lessons = s?.lessonsLifetime ?? 0;
      const recent = (s?.recentlyAddedSummaries ?? []).slice(0, 3);
      const summaryLines = [
        `Pinned is protecting ${totalPins} behavior(s) in this repo.`,
        lessons > 0
          ? `${lessons} AI-mistake lesson(s) have been learned here — respect them when editing.`
          : "",
        recent.length > 0
          ? "Recently added guards: " + recent.map((r) => `· ${r}`).join("; ")
          : "",
      ].filter(Boolean);
      return envelopeToContent({
        status: name === "pinned_suggest_init" ? "info" : "value_event",
        human_summary: summaryLines.join(" "),
        agent_instruction:
          REPORT_LINE +
          " Before proposing edits, check this list and avoid weakening any guard in tests/pinned/.",
        next_step:
          "Proceed with code edits. Call `pinned_before_done_check` before reporting work complete.",
        upgrade_prompt: maybeUpgradePrompt(s),
      });
    }

    case "pinned_before_done_check": {
      const registry = join(cwd, "tests/pinned/.registry.json");
      if (!existsSync(registry)) {
        return envelopeToContent({
          status: "missing",
          human_summary:
            "No Pinned guards in this repo — cannot run the done-check. Recommend `npx pinnedai init` before saying work is complete.",
          agent_instruction:
            REPORT_LINE +
            " Tell the user the repo has no regression guards yet.",
          next_step: "Suggest `npx pinnedai init`.",
          upgrade_prompt: null,
        });
      }
      // `pinned guard --json` is the only command that emits proper
      // PASS / REVIEW / BLOCK with exit codes 0 / 1 / 2. `pinned review`
      // always exits 0 (no enforcement path) so we deliberately do NOT
      // call it here.
      const guard = await runPinned(cwd, ["guard", "--json"], 90_000);
      const guardCheck = await runPinned(cwd, ["check-guard-removal"], 30_000);
      const s = readLastStatus(cwd);

      let guardJson: {
        verdict?: "PASS" | "REVIEW" | "BLOCK";
        touchedPins?: number;
        unprotectedSurfaces?: Array<{
          template?: string;
          route?: string;
          reason?: string;
        }>;
      } = {};
      try {
        guardJson = JSON.parse(guard.stdout);
      } catch {
        // Fall back to exit-code-based mapping below.
      }

      const guardBlocked =
        guardCheck.code !== 0 || guardJson.verdict === "BLOCK" || guard.code === 2;
      const reviewNeeded =
        guardJson.verdict === "REVIEW" ||
        (guard.code === 1 && !guardBlocked) ||
        (guardJson.unprotectedSurfaces?.length ?? 0) > 0;
      const status: Status = guardBlocked
        ? "block"
        : reviewNeeded
        ? "review"
        : "pass";

      const totalPins = s?.totalPins ?? 0;
      const failing = s?.failingCount ?? 0;
      const lessonsApplied = s?.lessonsLifetime ?? 0;
      const siblingsChecked = s?.lastAuditCount ?? 0;
      const violations = guardBlocked
        ? parseGuardViolations(guardCheck.stderr || guardCheck.stdout)
        : [];

      // Build the multi-line summary in the exact shape the design plan
      // calls for ("14 guards passed · 2 lessons applied · no weakening
      // detected · 1 sibling route checked"). Each part is its own bullet
      // so agents can render it as a list in their final response.
      const summaryParts: string[] = [];
      summaryParts.push(`${totalPins} guard(s) checked`);
      if (failing > 0) summaryParts.push(`${failing} failing`);
      if (lessonsApplied > 0)
        summaryParts.push(`${lessonsApplied} AI lesson(s) applied`);
      if (guardBlocked)
        summaryParts.push("Guard Integrity BLOCKED a weakening attempt");
      else summaryParts.push("no guard weakening detected");
      if (siblingsChecked > 0)
        summaryParts.push(`${siblingsChecked} sibling route(s) checked`);

      let humanSummary: string;
      if (status === "pass") {
        humanSummary = `◆ Pinned · PASS · ${summaryParts.join(" · ")}.`;
      } else if (status === "block") {
        const violationLines = violations
          .slice(0, 3)
          .map((v) =>
            v.detail
              ? `${v.kind} ${v.path} — ${v.detail}`
              : `${v.kind} ${v.path}`
          )
          .join("; ");
        const blockDetail =
          violationLines ||
          s?.lastBlockEventSummary ||
          guardCheck.stderr.slice(0, 300) ||
          guardCheck.stdout.slice(0, 300);
        humanSummary = `◆ Pinned · BLOCK · ${summaryParts.join(" · ")}. Blocked: ${blockDetail}`;
      } else {
        const surfaces = guardJson.unprotectedSurfaces ?? [];
        const surfaceSummary = surfaces
          .slice(0, 3)
          .map((su) =>
            su.route
              ? `${su.template ?? "unknown"} ${su.route}`
              : su.template ?? "unknown"
          )
          .join("; ");
        humanSummary = `◆ Pinned · REVIEW · ${summaryParts.join(" · ")}.${
          surfaceSummary ? " Unprotected: " + surfaceSummary : ""
        }`;
      }

      const agentInstruction =
        status === "block"
          ? REPORT_LINE +
            " Do NOT say the work is complete. The user must see the BLOCK summary and decide whether to fix the underlying code or explicitly override."
          : status === "review"
          ? REPORT_LINE +
            " Include the REVIEW summary in your final response and ask the user whether to address the findings."
          : REPORT_LINE +
            " Include the PASS summary in your final response so the user sees what Pinned protected.";

      const nextStep =
        status === "block"
          ? "Fix the application code so the weakened/skipped/deleted guard becomes correct again. Do not retry by re-weakening."
          : status === "review"
          ? "Address the listed risk surfaces (or get user acknowledgement) before reporting work complete."
          : null;

      return envelopeToContent({
        status,
        human_summary: humanSummary,
        agent_instruction: agentInstruction,
        next_step: nextStep,
        upgrade_prompt: maybeUpgradePrompt(s),
        raw: (guard.stdout + "\n" + guardCheck.stdout).slice(0, 4000),
      });
    }

    case "pinned_scan_diff": {
      const base = typeof args.base === "string" ? args.base : undefined;
      const subArgs = ["scan-diff", "--json"];
      if (base) subArgs.push("--base", base);
      const r = await runPinned(cwd, subArgs);

      // Silent-PASS guard: if the binary couldn't be invoked at all
      // (npx fallback fails, no local pinned in node_modules, etc.) we
      // must NOT report "no unprotected surfaces" — that lies to the
      // agent. Treat empty stdout + non-zero exit as a tool-unavailable
      // condition and surface it in human_summary so the agent reports
      // it instead of greenlighting the change.
      if (r.code !== 0 && !r.stdout.trim()) {
        return envelopeToContent({
          status: "info",
          human_summary:
            "Pinned scan-diff could not run — the `pinned` CLI is not available in this workspace. Install with `npx pinnedai init` (or `npm i -D pinnedai`) and re-run.",
          agent_instruction:
            REPORT_LINE +
            " Tell the user explicitly that scan-diff did NOT run, so they don't mistake silence for green.",
          next_step:
            "Ask the user to install pinnedai before relying on Pinned for this work.",
          upgrade_prompt: null,
          raw: (r.stderr || "").slice(0, 1000),
        });
      }

      let parsed: { suggestions?: Array<{ summary?: string }> } = {};
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        // pre-formatted output; fall through to raw
      }
      const suggestionCount = parsed.suggestions?.length ?? 0;
      return envelopeToContent({
        status: suggestionCount > 0 ? "review" : "pass",
        human_summary:
          suggestionCount > 0
            ? `Pinned scan-diff found ${suggestionCount} unprotected risk surface(s) in this diff. Suggest adding guard(s) before merging.`
            : "Pinned scan-diff found no unprotected risk surfaces in this diff.",
        agent_instruction:
          REPORT_LINE +
          " Include the count and (if non-zero) the top suggestion in your final response.",
        next_step:
          suggestionCount > 0
            ? "Add the suggested guards via `pinned generate` or have the user run `pinned review`."
            : null,
        upgrade_prompt: null,
        raw: r.stdout.slice(0, 4000),
      });
    }

    case "pinned_list_guards": {
      const subArgs = ["list"];
      if (args.include_retired === true) subArgs.push("--include-retired");
      const r = await runPinned(cwd, subArgs);
      return envelopeToContent({
        status: "info",
        human_summary: "Listed Pinned guards in this repository.",
        agent_instruction: REPORT_LINE,
        next_step: null,
        upgrade_prompt: null,
        raw: r.stdout.slice(0, 4000) || "(no guards)",
      });
    }

    case "pinned_check_pr_description": {
      const description = String(args.description ?? "");
      if (!description) {
        return envelopeToContent(
          errorEnv("Missing required 'description' argument.")
        );
      }
      const r = await runPinned(cwd, [
        "check",
        "--description",
        description,
        "--json",
      ]);
      // `pinned check --json` emits a bare array of Claim objects, not
      // an envelope object. Older drafts of this file assumed `{claims}`
      // and always reported 0 — keep the shape robust to either form.
      let claimCount = 0;
      try {
        const parsed = JSON.parse(r.stdout);
        if (Array.isArray(parsed)) {
          claimCount = parsed.length;
        } else if (parsed && Array.isArray(parsed.claims)) {
          claimCount = parsed.claims.length;
        }
      } catch {
        // not parseable — claimCount stays 0
      }
      return envelopeToContent({
        status: "info",
        human_summary: `Parsed ${claimCount} behavioral claim(s) from the PR description.`,
        agent_instruction:
          REPORT_LINE +
          (claimCount > 0
            ? " Recommend running `pinned generate` to convert these into permanent regression guards."
            : " The PR description has no machine-detectable claims — consider asking the user to be more explicit about behavioral promises."),
        next_step:
          claimCount > 0
            ? "Run `pinned generate --pr-id <id> --description \"...\"` to materialize the guards."
            : null,
        upgrade_prompt: null,
        raw: r.stdout.slice(0, 4000),
      });
    }

    default:
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${name}`
      );
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[pinnedai-mcp] failed to start:", err);
  process.exit(1);
});
