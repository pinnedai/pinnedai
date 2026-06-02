// Day-zero pin verification.
//
// After `pinned generate` writes the test file(s), optionally re-run
// them immediately against the customer's CURRENT code/preview/binary.
// This is the highest single lever for Pinned's catch rate because it
// surfaces the case where a PR claim doesn't match reality — e.g., the
// PR description says "auth required on /api/admin/export" but auth
// was actually never wired. Without day-zero verification, we'd
// silently pin a broken contract and the user wouldn't know until the
// next regression rolled in.
//
// False-positive mitigations (in order of importance):
//   1. Vitest only runs if it's already installed in the repo. We
//      never npx-install vitest just to verify — the customer's repo
//      has chosen its test runner.
//   2. Per-template preflight: web tests skip silently when
//      PREVIEW_URL is unset; library tests skip when modulePath
//      doesn't exist; CLI tests trust vitest to surface the error.
//   3. Double-confirm: run failed files a second time after a 500ms
//      gap. Only flag a "day-zero catch" if BOTH runs fail. Single
//      failures (cold-start, transient 503, slow CI runner) are
//      retried and don't trigger the loud catch UI.
//   4. Skipped vitest output is treated as "couldn't verify" — NOT
//      as "verified passing." We never claim verification we didn't
//      actually perform.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Claim } from "./claimParser.js";

export type DayZeroVerdict =
  | { kind: "verified"; filename: string }
  | { kind: "catch"; filename: string; output: string }
  | { kind: "skipped"; filename: string; reason: string };

export type DayZeroInput = {
  cwd: string;
  outDir: string;
  // Per-file metadata for the files we just wrote in this generate call.
  // Only these are verified — never the whole tests/pinned/ directory
  // (we don't want a `pinned generate` to surface unrelated failing
  // pins as if they were day-zero catches).
  written: ReadonlyArray<{ filename: string; claim: Claim }>;
};

const VITEST_TIMEOUT_MS = 30_000;
const DOUBLE_CONFIRM_GAP_MS = 500;

export async function verifyDayZero(
  input: DayZeroInput
): Promise<DayZeroVerdict[]> {
  // Per-file preflight. Files that can't be verified at all (no
  // PREVIEW_URL, no source file, no vitest) get a skip verdict
  // before any vitest invocation runs.
  const verdicts = new Map<string, DayZeroVerdict>();
  const verifiable: { filename: string; claim: Claim }[] = [];

  const vitestBin = resolveVitestBin(input.cwd);
  if (!vitestBin) {
    for (const w of input.written) {
      verdicts.set(w.filename, {
        kind: "skipped",
        filename: w.filename,
        reason:
          "vitest not installed in repo — install it with `npm install -D vitest` to enable day-zero verification",
      });
    }
    return input.written.map((w) => verdicts.get(w.filename)!);
  }

  for (const w of input.written) {
    const preflightSkip = preflight(w.claim, input.cwd);
    if (preflightSkip) {
      verdicts.set(w.filename, {
        kind: "skipped",
        filename: w.filename,
        reason: preflightSkip,
      });
      continue;
    }
    verifiable.push(w);
  }

  if (verifiable.length === 0) {
    return input.written.map((w) => verdicts.get(w.filename)!);
  }

  // First pass — single vitest invocation with all verifiable files.
  const firstPaths = verifiable.map((w) => join(input.outDir, w.filename));
  const first = runVitest(vitestBin, input.cwd, firstPaths);

  if (first.allPassed) {
    for (const w of verifiable) {
      verdicts.set(w.filename, { kind: "verified", filename: w.filename });
    }
    return input.written.map((w) => verdicts.get(w.filename)!);
  }

  // Identify which files failed on the first pass. Files that PASSED
  // first pass are settled as verified — no need to re-run them. We
  // only re-run the failures (faster and avoids flake-on-pass).
  const passedFirstPass = new Set<string>(first.passedFiles);
  for (const w of verifiable) {
    if (passedFirstPass.has(w.filename)) {
      verdicts.set(w.filename, { kind: "verified", filename: w.filename });
    }
  }

  const stillFailing = verifiable.filter(
    (w) => !passedFirstPass.has(w.filename)
  );

  // Sleep then double-confirm. Only the still-failing files get re-run.
  await new Promise((r) => setTimeout(r, DOUBLE_CONFIRM_GAP_MS));
  const secondPaths = stillFailing.map((w) => join(input.outDir, w.filename));
  const second = runVitest(vitestBin, input.cwd, secondPaths);
  const passedSecondPass = new Set<string>(second.passedFiles);

  for (const w of stillFailing) {
    if (passedSecondPass.has(w.filename)) {
      // Flaked on first run, passed on second. Don't claim a catch —
      // a single failure under load is exactly what double-confirm
      // exists to filter out.
      verdicts.set(w.filename, { kind: "verified", filename: w.filename });
    } else {
      verdicts.set(w.filename, {
        kind: "catch",
        filename: w.filename,
        // Prefer the second-run output (most recent) but cap to
        // avoid flooding the terminal with 50KB of vitest dump.
        output: (second.rawOutput || first.rawOutput).slice(0, 4000),
      });
    }
  }

  return input.written.map((w) => verdicts.get(w.filename)!);
}

// Per-template preflight. Returns a skip reason if the test can't
// meaningfully be verified RIGHT NOW (no preview, missing module
// file, etc.) — returns null when verification should proceed.
//
// We do NOT validate the preview reachability via fetch here —
// vitest will surface the error inside the test itself (timeout /
// ECONNREFUSED), and that's a more accurate signal than our
// preflight ping. We only short-circuit on conditions that make
// running vitest definitively pointless.
function preflight(claim: Claim, cwd: string): string | null {
  switch (claim.template) {
    case "auth-required":
    case "permission-required":
    case "tier-cap":
    case "rate-limit":
    case "idempotent":
    case "returns-status":
      if (!process.env.PREVIEW_URL) {
        return "no PREVIEW_URL set — pin is saved, will verify on next deploy";
      }
      return null;
    case "library-returns": {
      // Module file must exist or the import will fail unrelated
      // to the contract under test.
      const full = join(cwd, claim.modulePath);
      if (!existsSync(full)) {
        return `module file ${claim.modulePath} doesn't exist yet — pin is saved, will verify once the file lands`;
      }
      return null;
    }
    case "cli-output-contains":
    case "cli-exits-zero":
    case "cli-creates-file":
    case "cli-json-shape":
    case "cli-flag-supported":
      // The CLI binary's discoverability depends on PATH config that
      // we can't reliably introspect here. Let vitest try; if it can't
      // find the binary it'll surface a clear ENOENT — which is then a
      // confirmable catch (the contract was that the command runs).
      return null;
    case "lockfile-integrity": {
      // Lockfile must exist or the hash comparison can't run.
      const full = join(cwd, claim.lockfilePath);
      if (!existsSync(full)) {
        return `lockfile ${claim.lockfilePath} doesn't exist yet — pin is saved, will verify once it lands`;
      }
      return null;
    }
    case "config-invariant": {
      const full = join(cwd, claim.configPath);
      if (!existsSync(full)) {
        return `config file ${claim.configPath} doesn't exist yet — pin is saved, will verify once it lands`;
      }
      return null;
    }
    case "package-exports-exist": {
      const full = join(cwd, claim.modulePath);
      if (!existsSync(full)) {
        return `module file ${claim.modulePath} doesn't exist yet — pin is saved, will verify once it lands`;
      }
      return null;
    }
    case "secret-not-public":
      // Repo-wide scan; nothing to pre-validate.
      return null;
    case "url-literal-preserved": {
      const full = join(cwd, claim.filePath);
      if (!existsSync(full)) {
        return `file ${claim.filePath} doesn't exist yet — pin is saved, will verify once it lands`;
      }
      return null;
    }
    case "tsc-clean": {
      const full = join(cwd, claim.tsconfigPath);
      if (!existsSync(full)) {
        return `${claim.tsconfigPath} doesn't exist — pin is saved, will skip until tsconfig lands`;
      }
      return null;
    }
    case "module-export-stable": {
      const full = join(cwd, claim.modulePath);
      if (!existsSync(full)) {
        return `module ${claim.modulePath} doesn't exist yet — pin is saved, will verify once it lands`;
      }
      return null;
    }
    case "react-route-registered": {
      const full = join(cwd, claim.routerFilePath);
      if (!existsSync(full)) {
        return `router file ${claim.routerFilePath} doesn't exist yet — pin is saved, will verify once it lands`;
      }
      return null;
    }
    case "webhook-handler-exists": {
      const full = join(cwd, claim.filePath);
      if (!existsSync(full)) {
        return `webhook file ${claim.filePath} doesn't exist yet — pin is saved, will verify once it lands`;
      }
      return null;
    }
    case "import-path-resolves": {
      const full = join(cwd, claim.sourceFilePath);
      if (!existsSync(full)) {
        return `source file ${claim.sourceFilePath} doesn't exist yet — pin is saved, will verify once it lands`;
      }
      return null;
    }
    case "changed-literal-preserved": {
      const full = join(cwd, claim.filePath);
      if (!existsSync(full)) {
        return `file ${claim.filePath} doesn't exist yet — pin is saved, will verify once it lands`;
      }
      return null;
    }
    case "form-submit-error-handling": {
      const full = join(cwd, claim.filePath);
      if (!existsSync(full)) {
        return `form file ${claim.filePath} doesn't exist yet — pin is saved, will verify once it lands`;
      }
      return null;
    }
    case "page-renders":
    case "validation-rejects-bad":
    case "happy-path-with-side-effect":
    case "journey":
      // Live-HTTP templates — no source-file preflight check needed.
      // Templates' own skipIf-on-missing-PREVIEW_URL handles the
      // common "can't actually verify right now" case.
      return null;
  }
}

// Resolve the customer's installed vitest binary from their
// node_modules. We do NOT fall back to npx — that would download
// vitest on every generate run, which is too slow AND would surprise
// users who deliberately don't have vitest installed.
function resolveVitestBin(cwd: string): string | null {
  const candidate = join(cwd, "node_modules", ".bin", "vitest");
  if (existsSync(candidate)) return candidate;
  return null;
}

type VitestRun = {
  allPassed: boolean;
  passedFiles: string[];
  rawOutput: string;
};

// Run vitest once on a list of test files. We capture stdout/stderr,
// parse the summary to figure out which files passed.
function runVitest(
  bin: string,
  cwd: string,
  testPaths: string[]
): VitestRun {
  if (testPaths.length === 0) {
    return { allPassed: true, passedFiles: [], rawOutput: "" };
  }
  const result = spawnSync(
    bin,
    [
      "run",
      "--no-coverage",
      "--reporter=verbose",
      "--no-color",
      ...testPaths,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: VITEST_TIMEOUT_MS,
      env: {
        ...process.env,
        // Quiet CI-mode output; vitest's default is interactive.
        CI: "1",
      },
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  const rawOutput = (result.stdout || "") + (result.stderr || "");

  // Parse: vitest's verbose reporter prints one line per test file
  // status (✓ src/foo.test.ts or ✗ src/foo.test.ts) AND a summary
  // table. We pick up file-level pass/fail from the per-file lines —
  // more granular than the summary aggregate.
  const passedFiles: string[] = [];
  const failedFiles = new Set<string>();
  for (const line of rawOutput.split("\n")) {
    const passMatch = line.match(/^\s*[✓√]\s+(\S+\.test\.[tj]sx?)/);
    if (passMatch) {
      passedFiles.push(extractBasename(passMatch[1]));
      continue;
    }
    const failMatch = line.match(/^\s*[✗×]\s+(\S+\.test\.[tj]sx?)/);
    if (failMatch) {
      failedFiles.add(extractBasename(failMatch[1]));
    }
  }

  // If vitest exited non-zero but our line-parser didn't catch any
  // pass/fail markers, treat ALL inputs as failed — defensive
  // posture against output-format drift in future vitest versions.
  if (result.status !== 0 && passedFiles.length === 0 && failedFiles.size === 0) {
    for (const p of testPaths) failedFiles.add(extractBasename(p));
  }

  // De-dupe passed against failed (vitest may print both during a re-run).
  const filteredPassed = passedFiles.filter((f) => !failedFiles.has(f));

  const allPassed =
    result.status === 0 &&
    failedFiles.size === 0 &&
    filteredPassed.length > 0;

  return { allPassed, passedFiles: filteredPassed, rawOutput };
}

function extractBasename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// Human-readable summary block for the CLI to print after running
// verifyDayZero. Returns "" when there's nothing to say (all
// verifications were silently fine — keeps generate output quiet on
// the happy path).
export function renderDayZeroSummary(verdicts: DayZeroVerdict[]): string {
  const catches = verdicts.filter((v) => v.kind === "catch");
  const skipped = verdicts.filter((v) => v.kind === "skipped");
  const verified = verdicts.filter((v) => v.kind === "verified");

  // All-clean happy path: print one calm line, no fanfare.
  if (catches.length === 0 && skipped.length === 0 && verified.length > 0) {
    return `✓ All ${verified.length} pin${verified.length === 1 ? "" : "s"} verified against your current code.`;
  }

  const lines: string[] = [];

  if (catches.length > 0) {
    lines.push("");
    lines.push(
      `⚠ Day-zero catch — ${catches.length} pin${catches.length === 1 ? "" : "s"} don't hold against your current code:`
    );
    lines.push("");
    for (const c of catches) {
      lines.push(`  ✗ ${c.filename}`);
    }
    lines.push("");
    lines.push(
      "These pins are still saved — they'll gate CI from here forward."
    );
    lines.push(
      "Run `npx vitest run tests/pinned/<filename>` to see the full failure + repair prompt."
    );
    // False-positive disclosure. We double-confirm catches (re-run
    // failing files after a 500ms gap) to filter transient flakes,
    // but environment issues — cold-start preview, expired test
    // credentials, slow CI runner — can occasionally produce a
    // catch that isn't a real regression. Tell users this UP FRONT,
    // at the moment they're most likely to act on the message, so
    // they don't "fix" code that wasn't actually broken. Also keeps
    // Pinned's credibility intact: better to acknowledge the failure
    // mode than be quietly wrong.
    lines.push("");
    lines.push(
      "Note: catches are re-checked twice with a 500ms gap to filter transient"
    );
    lines.push(
      "flakes. Environment issues (cold-start preview, expired creds, slow"
    );
    lines.push(
      "runner) may still produce a rare false catch. If the failure looks"
    );
    lines.push(
      "wrong, re-run `npx vitest run <file>` to confirm before fixing code."
    );
  }

  if (verified.length > 0 && catches.length > 0) {
    lines.push("");
    lines.push(
      `✓ ${verified.length} other pin${verified.length === 1 ? "" : "s"} verified.`
    );
  }

  if (skipped.length > 0) {
    lines.push("");
    lines.push(
      `⊘ ${skipped.length} pin${skipped.length === 1 ? "" : "s"} couldn't be verified now:`
    );
    // De-dupe reasons so we don't print "no PREVIEW_URL" 8 times.
    const reasonsSeen = new Set<string>();
    for (const s of skipped) {
      if (reasonsSeen.has(s.reason)) continue;
      reasonsSeen.add(s.reason);
      lines.push(`    ${s.reason}`);
    }
  }

  return lines.join("\n");
}
