// Generator for Tier 1 functional smoke pins.
//
// The wedge per [[agent-loop-activation-wedge]] + Cipherwake-Claude's
// 0.3.0 spec: regression detectors protect things that already work;
// smoke pins catch the dominant AI failure mode where the agent ships
// a feature that LOOKS done but never actually works.
//
// 0.3.0 expansion (task #151): supports 4 entrypoint kinds and 7
// assertion kinds (was: 1 entrypoint + 5 assertions).
//
//   Entrypoint kinds: http-route | fn | cli | job
//   Assertion kinds:  status-ok | returns-nonempty | returns-shape |
//                     responds-within | reaches-terminal-state |
//                     rejects | errors-on
//
// The generated test:
//   1. Skips with WARN if `safeToExecute === false` (opt-in per pin).
//   2. Skips with WARN if cadence-gate is closed (on-demand by default).
//   3. Skips with WARN if env unresolvable (baseUrl missing for http,
//      module missing for fn, etc.).
//   4. Runs each assertion against the entrypoint's output. RED on
//      first failure with expected-vs-actual.
//   5. Double-confirm: retries once on any failure (per the spec's
//      flakiness handling).
//
// Anti-snapshot guard: assertions are spec-derived invariants, NOT
// snapshots of whatever the AI's implementation returned. See the
// `SmokeAssertion` type comment in claimParser.ts for the full rule.
//
// Browser-safety contract: BROWSER-SAFE (no Node imports). The
// template emits a string that customer Vitest runs in Node; we don't
// import anything Node-only here so the landing-page demo can keep
// importing this module.

import type { SmokeFunctionalClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

function lit(x: unknown): string {
  return JSON.stringify(x);
}

export function generateSmokeFunctionalTest(
  claim: SmokeFunctionalClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const ep = claim.entrypoint;
  const safeLit = claim.safeToExecute ? "true" : "false";
  const cadenceLit = lit(claim.cadence);
  const assertionsLit =
    "[\n    " + claim.assertions.map((a) => JSON.stringify(a)).join(",\n    ") + ",\n  ]";

  // Per-entrypoint config snippet — emitted as a JSON-literal at the
  // top of the test so the runtime helpers can read it without
  // discriminating on the union at template-emit time.
  const entrypointLit = JSON.stringify(ep);

  const header = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Smoke / golden-path pin (Tier 1)
// Entrypoint:  ${ep.kind === "http-route" ? `${ep.method} ${claim.route}` : `${ep.kind} ${claim.route}`}
// Cadence:     ${claim.cadence}
//
// To retire: pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════
//
// What this pin asserts: smoke-test the ${ep.kind} entrypoint actually
// responds correctly. Catches the "AI shipped a feature that LOOKS
// done but silently never works" failure mode (silent-empty-return,
// hung worker, status-string mismatch, missing validation, missing
// failure-path error handling).
//
// WARN-on-missing-env: skips with diagnostic if the entrypoint can't
// be resolved (no base URL, no module, etc). RED-on-real-failure:
// fails fast on assertion violation with expected-vs-actual.`;

  const body = `
import { describe, it, expect } from "vitest";

const ENTRYPOINT: any = ${entrypointLit};
const ROUTE = ${lit(claim.route)};
const SAFE_TO_EXECUTE = ${safeLit};
const CADENCE = ${cadenceLit};
const ASSERTIONS: any[] = ${assertionsLit};

type Assertion =
  | { kind: "returns-nonempty" }
  | { kind: "status-ok" }
  | { kind: "returns-shape"; mustContain: string }
  | { kind: "responds-within"; ms: number }
  | { kind: "reaches-terminal-state"; statusPath: string; terminalStates: string[]; boundMs: number; pollIntervalMs?: number }
  | { kind: "rejects"; withInput: any; expect: { status?: number | number[]; bodyContains?: string; errorShape?: "json-error" | "text-error" } }
  | { kind: "errors-on"; fault: "upstream-empty" | "upstream-hang" | "upstream-5xx" | "upstream-malformed-json"; expect: { throws?: boolean; status?: number | number[]; bodyContains?: string; withinMs: number } };

// Result shape the assertion runners consume. We normalize every
// entrypoint kind into this shape so assertions don't have to know
// which kind of entrypoint produced the result.
type RunResult = {
  ok: boolean;                 // entrypoint completed without throwing
  threw?: Error;
  bodyText: string;            // stringified output (stdout for cli, JSON for http/fn)
  bodyJson?: any;              // parsed body if JSON-shaped
  status?: number;             // http status, cli exit code
  elapsedMs: number;
};

function env(name: string): string | undefined {
  return (globalThis as any).process?.env?.[name];
}

// 0.4.0 (Cipherwake Gap 3b): zero-config base URL resolution.
// Same chain as apps/cli/src/baseUrl.ts but inlined for the runtime —
// vitest can't reach back into the pinnedai package, so we duplicate.
// Chain: explicit env > CI auto-detect (Vercel/Netlify/CF/Render) >
// claim default > null (caller emits loud skip).
function __pinnedNormUrl(s: string | undefined): string | null {
  if (!s) return null;
  const t = /^https?:\\/\\//i.test(s) ? s : "https://" + s;
  return t.replace(/\\/+$/, "");
}
function resolveBaseUrl(): string | null {
  return __pinnedNormUrl(env("PINNED_SMOKE_BASE_URL"))
      || __pinnedNormUrl(env("PINNED_BASE_URL"))
      || __pinnedNormUrl(env("PREVIEW_URL"))
      || __pinnedNormUrl(env("PINNED_CI_BASE_URL"))
      || __pinnedNormUrl(env("VERCEL_BRANCH_URL"))
      || __pinnedNormUrl(env("VERCEL_URL"))
      || __pinnedNormUrl(env("VERCEL_PROJECT_PRODUCTION_URL"))
      || __pinnedNormUrl(env("DEPLOY_PRIME_URL"))
      || (env("NETLIFY") === "true" ? __pinnedNormUrl(env("URL")) : null)
      || __pinnedNormUrl(env("CF_PAGES_URL"))
      || __pinnedNormUrl(env("RENDER_EXTERNAL_URL"))
      || __pinnedNormUrl(ENTRYPOINT.defaultBaseUrl)
      || null;
}
function __pinnedLoudSkipMsg(): string {
  return "pinned: no base URL (not on a known CI provider, no local server). Run \\\`pinned dev\\\` or set PINNED_BASE_URL.";
}

function shouldSkipCadence(): { skip: boolean; reason: string } {
  if (CADENCE === "on-demand") {
    if (env("SMOKE_RUN") === "1" || env("PINNED_SMOKE") === "1") {
      return { skip: false, reason: "" };
    }
    return { skip: true, reason: "Cadence is on-demand. Set SMOKE_RUN=1 (or PINNED_SMOKE=1) to run." };
  }
  if (CADENCE === "ci-only" && env("CI") !== "true" && env("CI") !== "1") {
    return { skip: true, reason: "Cadence is ci-only. CI env not set." };
  }
  return { skip: false, reason: "" };
}

function dig(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

async function runHttpRoute(overrideBody?: any, faultBaseUrl?: string): Promise<RunResult> {
  const baseUrl = faultBaseUrl ?? resolveBaseUrl();
  if (!baseUrl) return { ok: false, bodyText: "", elapsedMs: 0, threw: new Error("base URL unresolvable") };
  const startedAt = Date.now();
  const init: RequestInit = {
    method: ENTRYPOINT.method,
    headers: { ...(ENTRYPOINT.headers ?? {}) },
  };
  // 0.4.0 (Gap 2): attach auth cookie if the claim declares one.
  // Value comes from env at run time — never stored in the pin file.
  if (ENTRYPOINT.auth && ENTRYPOINT.auth.cookie && ENTRYPOINT.auth.valueFromEnv) {
    const cookieVal = env(ENTRYPOINT.auth.valueFromEnv);
    if (cookieVal) {
      const existingCookie = (init.headers as Record<string, string>)["cookie"] ?? "";
      const newCookie = ENTRYPOINT.auth.cookie + "=" + cookieVal;
      (init.headers as Record<string, string>)["cookie"] = existingCookie ? existingCookie + "; " + newCookie : newCookie;
    } else {
      // Missing env var → return a special marker. Caller treats as
      // WARN-skip (the auth pin can't authenticate, but that's not RED).
      return { ok: false, bodyText: "", elapsedMs: 0, threw: new Error(\`WARN: auth cookie env \${ENTRYPOINT.auth.valueFromEnv} not set; skipping authed render\`) };
    }
  }
  const body = overrideBody !== undefined ? (typeof overrideBody === "string" ? overrideBody : JSON.stringify(overrideBody)) : ENTRYPOINT.body;
  if (body !== undefined && ENTRYPOINT.method !== "GET") {
    init.body = body;
    if (!(init.headers as Record<string, string>)["content-type"]) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
  }
  try {
    const r = await fetch(baseUrl.replace(/\\/$/, "") + ROUTE, init);
    const text = await r.text();
    let json: any = undefined;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: r.ok, bodyText: text, bodyJson: json, status: r.status, elapsedMs: Date.now() - startedAt };
  } catch (e) {
    return { ok: false, bodyText: "", elapsedMs: Date.now() - startedAt, threw: e as Error };
  }
}

async function runFn(overrideArgs?: any[]): Promise<RunResult> {
  const startedAt = Date.now();
  try {
    // Resolve module relative to the customer's repo root. Customers
    // run vitest from the repo root so a relative path works.
    const mod: any = await import(/* @vite-ignore */ ENTRYPOINT.modulePath);
    const fn = ENTRYPOINT.exportName === "default" ? (mod.default ?? mod) : mod[ENTRYPOINT.exportName];
    if (typeof fn !== "function") {
      return { ok: false, bodyText: "", elapsedMs: Date.now() - startedAt, threw: new Error(\`Export "\${ENTRYPOINT.exportName}" is not a function in \${ENTRYPOINT.modulePath}\`) };
    }
    const args = overrideArgs ?? ENTRYPOINT.args ?? [];
    const result = await fn(...args);
    const bodyText = typeof result === "string" ? result : JSON.stringify(result);
    const bodyJson = typeof result === "object" ? result : undefined;
    return { ok: true, bodyText, bodyJson, elapsedMs: Date.now() - startedAt };
  } catch (e) {
    return { ok: false, bodyText: "", elapsedMs: Date.now() - startedAt, threw: e as Error };
  }
}

async function runCli(overrideStdin?: string): Promise<RunResult> {
  const startedAt = Date.now();
  // Dynamic import keeps the template browser-safe at TYPE time but
  // requires Node at runtime. Vitest always runs in Node so this is
  // safe; the customer's landing-page bundler never includes this.
  const { spawn } = await import("node:child_process");
  return new Promise<RunResult>((resolve) => {
    const child = spawn(ENTRYPOINT.command, ENTRYPOINT.args ?? [], {
      cwd: ENTRYPOINT.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => {
      resolve({ ok: false, bodyText: stdout + stderr, elapsedMs: Date.now() - startedAt, threw: e });
    });
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      resolve({
        ok: exitCode === 0,
        bodyText: stdout,
        status: exitCode,
        elapsedMs: Date.now() - startedAt,
      });
    });
    const stdinIn = overrideStdin ?? ENTRYPOINT.stdin;
    if (stdinIn) child.stdin.write(stdinIn);
    child.stdin.end();
  });
}

async function runJob(): Promise<RunResult> {
  const startedAt = Date.now();
  // Submit the job
  const submitKind = ENTRYPOINT.submit.kind;
  let submitResult: RunResult;
  if (submitKind === "http") {
    const baseUrl = resolveBaseUrl();
    if (!baseUrl) return { ok: false, bodyText: "", elapsedMs: 0, threw: new Error("job submit: base URL unresolvable") };
    submitResult = await runHttpRoute(ENTRYPOINT.submit.input);
  } else if (submitKind === "fn") {
    submitResult = await runFn([ENTRYPOINT.submit.input]);
  } else {
    return { ok: false, bodyText: "", elapsedMs: Date.now() - startedAt, threw: new Error(\`Unknown job submit kind: \${submitKind}\`) };
  }
  if (!submitResult.ok) return submitResult;

  // Poll
  const pollSource: string = ENTRYPOINT.poll.source;
  const interval = ENTRYPOINT.poll.pollIntervalMs ?? 2000;
  const bound = ENTRYPOINT.poll.boundMs;
  const polledStart = Date.now();
  let lastResult = submitResult;
  while (Date.now() - polledStart < bound) {
    const status = dig(lastResult.bodyJson, ENTRYPOINT.poll.statusPath);
    if (typeof status === "string" && ENTRYPOINT.poll.terminalStates.includes(status)) {
      return { ...lastResult, elapsedMs: Date.now() - startedAt };
    }
    await new Promise((r) => setTimeout(r, interval));
    // Poll source. "http:<path>" or "fn:<module>#<export>"
    if (pollSource.startsWith("http:")) {
      const pollPath = pollSource.slice(5);
      const baseUrl = resolveBaseUrl();
      if (!baseUrl) break;
      try {
        const r = await fetch(baseUrl.replace(/\\/$/, "") + pollPath);
        const text = await r.text();
        let json: any; try { json = JSON.parse(text); } catch {}
        lastResult = { ok: r.ok, bodyText: text, bodyJson: json, status: r.status, elapsedMs: Date.now() - startedAt };
      } catch { /* keep polling within bound */ }
    } else if (pollSource.startsWith("fn:")) {
      try {
        const [modPath, exportName] = pollSource.slice(3).split("#");
        const mod: any = await import(/* @vite-ignore */ modPath);
        const fn = mod[exportName] ?? mod.default;
        const result = await fn();
        const bodyText = typeof result === "string" ? result : JSON.stringify(result);
        lastResult = { ok: true, bodyText, bodyJson: typeof result === "object" ? result : undefined, elapsedMs: Date.now() - startedAt };
      } catch { /* keep polling */ }
    }
  }
  return { ...lastResult, elapsedMs: Date.now() - startedAt };
}

async function runUiButton(): Promise<RunResult> {
  const startedAt = Date.now();
  // BETA Tier 2 (0.3.1) — dynamic import keeps Playwright OPTIONAL.
  // If "@playwright/test" isn't installed, the test surfaces a clear
  // WARN-skip via the threw path (caller treats as warning, not RED).
  // Customer runs \`pinned add-browser\` to install Playwright.
  let pw: any;
  try {
    pw = await import(/* @vite-ignore */ "@playwright/test");
  } catch {
    return {
      ok: false,
      bodyText: "",
      elapsedMs: Date.now() - startedAt,
      threw: new Error("WARN: @playwright/test not installed. Run \`pinned add-browser\` to enable Tier 2 UI smoke pins (BETA)."),
    };
  }
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) return { ok: false, bodyText: "", elapsedMs: Date.now() - startedAt, threw: new Error("base URL unresolvable") };
  const browser = await pw.chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(baseUrl.replace(/\\/$/, "") + ENTRYPOINT.page);
    if (ENTRYPOINT.action === "click") {
      await page.click(ENTRYPOINT.selector);
    } else if (ENTRYPOINT.action === "type" && ENTRYPOINT.value) {
      await page.fill(ENTRYPOINT.selector, ENTRYPOINT.value);
    } else if (ENTRYPOINT.action === "select" && ENTRYPOINT.value) {
      await page.selectOption(ENTRYPOINT.selector, ENTRYPOINT.value);
    }
    if (ENTRYPOINT.waitFor) {
      // Wait up to 30s for the post-interaction selector to appear.
      // If it doesn't, the UI handoff is broken — the bug Tier 2 catches.
      try {
        await page.waitForSelector(ENTRYPOINT.waitFor, { timeout: 30_000 });
      } catch {
        const dom = await page.content();
        return { ok: false, bodyText: dom, elapsedMs: Date.now() - startedAt, threw: new Error(\`waitFor selector "\${ENTRYPOINT.waitFor}" did not appear within 30s — frontend↔backend handoff likely broken\`) };
      }
    }
    const dom = await page.content();
    return { ok: true, bodyText: dom, elapsedMs: Date.now() - startedAt };
  } finally {
    await browser.close();
  }
}

async function runEntrypoint(): Promise<RunResult> {
  switch (ENTRYPOINT.kind) {
    case "http-route": return runHttpRoute();
    case "fn": return runFn();
    case "cli": return runCli();
    case "job": return runJob();
    case "ui-button": return runUiButton();
    default: return { ok: false, bodyText: "", elapsedMs: 0, threw: new Error(\`Unknown entrypoint kind: \${ENTRYPOINT.kind}\`) };
  }
}

async function evaluateOnce(): Promise<{ ok: true } | { ok: false; failed: Assertion; message: string }> {
  const result = await runEntrypoint();
  if (result.threw) {
    return { ok: false, failed: { kind: "status-ok" } as Assertion, message: \`Entrypoint threw: \${result.threw.message}\` };
  }
  for (const a of ASSERTIONS as Assertion[]) {
    if (a.kind === "status-ok") {
      if (result.status !== undefined && (result.status >= 400 || result.status < 0)) {
        return { ok: false, failed: a, message: \`expected 2xx, got \${result.status}\` };
      }
      if (!result.ok) return { ok: false, failed: a, message: \`expected ok=true, got ok=false\` };
    } else if (a.kind === "returns-nonempty") {
      if (result.bodyText === "" || result.bodyText === "null" || result.bodyText === "undefined") {
        return { ok: false, failed: a, message: \`expected non-empty response, got "\${result.bodyText}"\` };
      }
    } else if (a.kind === "returns-shape") {
      if (!result.bodyText.includes(a.mustContain)) {
        return { ok: false, failed: a, message: \`expected response to contain "\${a.mustContain}", body was: \${result.bodyText.slice(0, 200)}\` };
      }
    } else if (a.kind === "responds-within") {
      if (result.elapsedMs > a.ms) {
        return { ok: false, failed: a, message: \`expected response within \${a.ms}ms, got \${result.elapsedMs}ms\` };
      }
    } else if (a.kind === "reaches-terminal-state") {
      // For http-route entrypoint use the existing one-shot logic;
      // for job entrypoint, runJob already polled — just check the
      // final status value.
      const status = dig(result.bodyJson, a.statusPath);
      if (typeof status !== "string" || !a.terminalStates.includes(status)) {
        // If we have an http-route entrypoint, run the poll loop here.
        if (ENTRYPOINT.kind === "http-route") {
          const pollInterval = a.pollIntervalMs ?? 2000;
          const polledStart = Date.now();
          let cur = result.bodyJson;
          let lastStatus: unknown = status;
          while (Date.now() - polledStart < a.boundMs) {
            if (typeof lastStatus === "string" && a.terminalStates.includes(lastStatus)) break;
            await new Promise((r) => setTimeout(r, pollInterval));
            try {
              const pollResp = await runHttpRoute();
              cur = pollResp.bodyJson;
              lastStatus = dig(cur, a.statusPath);
            } catch { /* keep polling */ }
          }
          if (typeof lastStatus !== "string" || !a.terminalStates.includes(lastStatus)) {
            return { ok: false, failed: a, message: \`expected terminal state in [\${a.terminalStates.join(", ")}] within \${a.boundMs}ms via \${a.statusPath}; last observed: \${JSON.stringify(lastStatus)}\` };
          }
        } else {
          return { ok: false, failed: a, message: \`expected terminal state in [\${a.terminalStates.join(", ")}] via \${a.statusPath}; last observed: \${JSON.stringify(status)}\` };
        }
      }
    } else if (a.kind === "rejects") {
      // Guard path: re-issue the entrypoint with withInput; assert it
      // was rejected. Only meaningful for http-route + fn; for cli +
      // job we use a simpler shape.
      let rejectResult: RunResult;
      if (ENTRYPOINT.kind === "http-route") {
        rejectResult = await runHttpRoute(a.withInput);
      } else if (ENTRYPOINT.kind === "fn") {
        const argsOverride = Array.isArray(a.withInput) ? a.withInput : [a.withInput];
        rejectResult = await runFn(argsOverride);
      } else if (ENTRYPOINT.kind === "cli") {
        rejectResult = await runCli(typeof a.withInput === "string" ? a.withInput : JSON.stringify(a.withInput));
      } else {
        return { ok: false, failed: a, message: \`rejects assertion not supported for entrypoint kind "\${ENTRYPOINT.kind}"\` };
      }
      // Validate the rejection matches expect.
      if (a.expect.status !== undefined) {
        const expectedStatuses = Array.isArray(a.expect.status) ? a.expect.status : [a.expect.status];
        if (rejectResult.status === undefined || !expectedStatuses.includes(rejectResult.status)) {
          return { ok: false, failed: a, message: \`rejects: expected status in [\${expectedStatuses.join(",")}], got \${rejectResult.status}\` };
        }
      }
      if (a.expect.bodyContains !== undefined) {
        if (!rejectResult.bodyText.includes(a.expect.bodyContains)) {
          return { ok: false, failed: a, message: \`rejects: expected body to contain "\${a.expect.bodyContains}", got: \${rejectResult.bodyText.slice(0, 200)}\` };
        }
      }
      if (a.expect.errorShape === "json-error") {
        if (!rejectResult.bodyJson || typeof rejectResult.bodyJson !== "object" || !("error" in rejectResult.bodyJson || "message" in rejectResult.bodyJson)) {
          return { ok: false, failed: a, message: \`rejects: expected JSON error shape ({ error|message }), got: \${rejectResult.bodyText.slice(0, 200)}\` };
        }
      }
      // If NO status / bodyContains / errorShape specified, fall back
      // to "must NOT have ok=true" — at least assert it didn't succeed.
      if (a.expect.status === undefined && a.expect.bodyContains === undefined && a.expect.errorShape === undefined) {
        if (rejectResult.ok) {
          return { ok: false, failed: a, message: \`rejects: expected entrypoint to reject "\${JSON.stringify(a.withInput).slice(0, 80)}", but it succeeded\` };
        }
      }
    } else if (a.kind === "errors-on") {
      // Failure path: depending on the fault kind, drive the right fault.
      // We require the customer to set PINNED_SMOKE_FAULT_URL for
      // upstream-* faults that need a stub server. If missing, WARN-skip
      // — keeps fault assertions opt-in per the build plan's "FP
      // discipline" and "opt-in execution" rules.
      const faultUrl = env("PINNED_SMOKE_FAULT_URL");
      if (!faultUrl && ENTRYPOINT.kind === "http-route") {
        // Skip with WARN (treated as inline pass for cadence; logged via
        // failed assertion only at top level if requested).
        continue;
      }
      const faultStart = Date.now();
      let faultResult: RunResult;
      try {
        if (ENTRYPOINT.kind === "http-route") {
          faultResult = await Promise.race([
            runHttpRoute(undefined, faultUrl),
            new Promise<RunResult>((resolve) => setTimeout(() => resolve({ ok: false, bodyText: "", elapsedMs: a.expect.withinMs + 1, threw: new Error("withinMs exceeded — entrypoint hung") }), a.expect.withinMs)),
          ]);
        } else if (ENTRYPOINT.kind === "fn") {
          faultResult = await Promise.race([
            runFn(),
            new Promise<RunResult>((resolve) => setTimeout(() => resolve({ ok: false, bodyText: "", elapsedMs: a.expect.withinMs + 1, threw: new Error("withinMs exceeded — entrypoint hung") }), a.expect.withinMs)),
          ]);
        } else {
          continue;
        }
      } catch (e) {
        faultResult = { ok: false, bodyText: "", elapsedMs: Date.now() - faultStart, threw: e as Error };
      }
      // Validate the failure surfaced cleanly.
      if (a.expect.withinMs && faultResult.elapsedMs > a.expect.withinMs) {
        return { ok: false, failed: a, message: \`errors-on: feature did not surface error or success within \${a.expect.withinMs}ms (silent hang). Elapsed: \${faultResult.elapsedMs}ms\` };
      }
      if (a.expect.throws && !faultResult.threw) {
        return { ok: false, failed: a, message: \`errors-on: expected entrypoint to throw, but it returned: \${faultResult.bodyText.slice(0, 200)}\` };
      }
      if (a.expect.status !== undefined) {
        const expectedStatuses = Array.isArray(a.expect.status) ? a.expect.status : [a.expect.status];
        if (faultResult.status === undefined || !expectedStatuses.includes(faultResult.status)) {
          return { ok: false, failed: a, message: \`errors-on: expected status in [\${expectedStatuses.join(",")}], got \${faultResult.status}\` };
        }
      }
      if (a.expect.bodyContains !== undefined) {
        if (!faultResult.bodyText.includes(a.expect.bodyContains)) {
          return { ok: false, failed: a, message: \`errors-on: expected body to contain "\${a.expect.bodyContains}", got: \${faultResult.bodyText.slice(0, 200)}\` };
        }
      }
    }
  }
  return { ok: true };
}

describe(\`smoke (\${ENTRYPOINT.kind} \${ROUTE})\`, () => {
  const cadenceGate = shouldSkipCadence();
  const safeGate = SAFE_TO_EXECUTE;

  if (!safeGate) {
    it.skip("safeToExecute is false — flip the claim to true after reviewing side-effects", () => {});
    return;
  }
  if (cadenceGate.skip) {
    it.skip(\`cadence skip: \${cadenceGate.reason}\`, () => {});
    return;
  }
  // For http-route, also gate on baseUrl resolvability. For fn/cli/job
  // the entrypoint config already declares everything needed.
  if (ENTRYPOINT.kind === "http-route" && !resolveBaseUrl()) {
    // Cipherwake Gap 3b — loud skip (not silent). The message reads
    // like a single actionable line in any test report.
    if (typeof console !== "undefined") console.warn(__pinnedLoudSkipMsg());
    it.skip(__pinnedLoudSkipMsg(), () => {});
    return;
  }

  it("smoke-test the entrypoint produces a real outcome", async () => {
    let res = await evaluateOnce();
    if (!res.ok) {
      // 0.3.1 Tier 2: WARN-skip if the only blocker is Playwright not
      // being installed. The message comes from runUiButton's
      // catch-import branch — never a real test failure.
      if (res.message && (res.message.startsWith("Entrypoint threw: WARN:") || res.message.includes("@playwright/test not installed"))) {
        return; // treated as skip; opt-in via \`pinned add-browser\`
      }
      // Double-confirm
      await new Promise((r) => setTimeout(r, 500));
      const retry = await evaluateOnce();
      if (retry.ok) {
        // Transient — silently pass; flake-tracking happens at the
        // sweep level (task #157 once that lands).
        return;
      }
      res = retry;
    }
    if (!res.ok) {
      if (res.message && (res.message.startsWith("Entrypoint threw: WARN:") || res.message.includes("@playwright/test not installed"))) {
        return; // WARN-skip
      }
      throw new Error(
        \`Smoke pin FAILED for \${ENTRYPOINT.kind} \${ROUTE}: \${res.message} (failed assertion: \${JSON.stringify(res.failed)})\`
      );
    }
    expect(res.ok).toBe(true);
  }, 240_000);
});
`;

  const content = header + body;

  return { filename, content, claimId };
}
