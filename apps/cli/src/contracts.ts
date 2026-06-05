// Cross-repo enum-drift contracts.
//
// The bug that motivates this: a worker in repo A writes `status: "completed"`,
// while a client in repo B polls `if (job.status === "done")`. The in-repo
// enum-drift detector misses it because the producer isn't in the same repo
// — no in-repo writes to "status", so the column is skipped entirely.
//
// The fix: shared contract files. Both repos drop a copy of
// `.pinned/contracts/<name>.json` declaring the agreed enum vocabulary:
//
//   {
//     "name": "job-status",
//     "column": "status",           // optional — column hint for binding
//     "values": ["pending", "processing", "completed", "failed"]
//   }
//
// The detector loads contracts at sweep time and:
//   - flags any CONSUMER comparison against a value not in the contract
//     (the socialideagen bug — comparing against "done" when contract says
//     only completed/failed are terminal),
//   - flags any PRODUCER write of a value not in the contract (worker
//     starts writing a new value before the consumer catches up).
//
// Architecturally identical to existing sweep-time reads — no daemon,
// no network. Per [[anything-annoying-must-be-opt-in]]: contracts are
// opt-in (no contract file = old in-repo-only behavior).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export type EnumContract = {
  // Stable identifier — the filename (without .json) is the canonical
  // contract name. The `name` field inside the JSON must match.
  name: string;
  // Optional column-name hint. When present, the detector binds the
  // contract to comparisons on that column; absent = matches any
  // column with the contract's name as the column.
  column?: string;
  // The agreed enum vocabulary. Order is not load-bearing.
  values: string[];
  // 0.3.1+ (Cipherwake-reported FP fix): file/glob scope. When set,
  // the contract only applies to files matching one of these
  // patterns. Avoids the column-name collision case — e.g. a
  // job-status contract with column "status" was previously matching
  // EVERY `status` column across the repo (idea status, comment
  // status, anything). With `appliesTo: ["lib/claudeDroplet.ts",
  // "lib/jobs/**"]` it only applies where it's meant to.
  //
  // Glob shape: simple prefix matching for now — "lib/jobs/**" means
  // "files under lib/jobs/". Exact-match also supported. No regex.
  // Absence = repo-wide (back-compat with 0.3.0 contracts).
  appliesTo?: string[];
  // The contract file path (repo-relative) — used in diagnostics so
  // users know which file to edit when a drift fires.
  sourcePath: string;
};

export type ContractDriftHit = {
  kind: "consumer-uses-undeclared" | "producer-emits-undeclared";
  contract: EnumContract;
  filePath: string;
  line: number;
  // The bad value the code uses/emits.
  value: string;
  // The column name observed in the code (may differ from contract.column
  // if the contract didn't pin a specific column).
  column: string;
  // Excerpt of the offending line for human diagnostics.
  excerpt: string;
};

const CONTRACT_DIR = ".pinned/contracts";

// Load all contracts from .pinned/contracts/*.json. Silently skips
// invalid files (logs to stderr via caller only when verbose), so a
// malformed contract doesn't break the entire sweep.
export function loadContracts(cwd: string): EnumContract[] {
  const dir = join(cwd, CONTRACT_DIR);
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const contracts: EnumContract[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.json$/i.test(e.name)) continue;
    const sourcePath = join(CONTRACT_DIR, e.name);
    const abs = join(dir, e.name);
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : null;
    const values = Array.isArray(obj.values)
      ? (obj.values as unknown[]).filter((v): v is string => typeof v === "string")
      : null;
    if (!name || !values || values.length === 0) continue;
    const column = typeof obj.column === "string" ? obj.column : undefined;
    const appliesTo = Array.isArray(obj.appliesTo)
      ? (obj.appliesTo as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined;
    contracts.push({ name, column, values, appliesTo, sourcePath });
  }
  return contracts;
}

// Producer-write regex — same shape as scanDiff's extractProducerWrites
// but inlined here to avoid a cross-module dependency between contracts
// and the existing detector. Matches:
//   { foo: "bar" }
//   foo: "bar",
//   .foo = "bar"
// while being conservative about identifier characters.
const PRODUCER_REGEX = /[{,;]\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*["'`]([^"'`]+?)["'`]/g;
const ASSIGN_REGEX  = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["'`]([^"'`]+?)["'`]/g;

// Consumer-read regex. Matches:
//   x.col === "val", x.col == "val"
//   case "val":
//   ["val", ...].includes(x.col)  ← rare; skip for now
const CONSUMER_REGEX = /\.([A-Za-z_][A-Za-z0-9_]*)\s*===?\s*["'`]([^"'`]+?)["'`]/g;

function isLikelyTestOrMigrationPath(p: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|migrations|seeds|seed|fixtures|scripts)\//.test(p)
    || /\.test\.|\.spec\./.test(p);
}

function isCodeFile(p: string): boolean {
  return /\.(?:tsx?|jsx?|mjs|cjs)$/.test(p);
}

// 0.3.1 helper: does this file match the contract's `appliesTo`
// scope? Empty/undefined `appliesTo` = repo-wide (back-compat).
// Glob: trailing `/**` matches subtree; trailing `*` matches prefix.
// Anything else is treated as an exact path match.
function contractMatchesFile(c: EnumContract, filePath: string): boolean {
  if (!c.appliesTo || c.appliesTo.length === 0) return true;
  const fp = filePath.toLowerCase();
  for (const pat of c.appliesTo) {
    const p = pat.toLowerCase();
    if (fp === p) return true;
    if (p.endsWith("/**") && fp.startsWith(p.slice(0, -3))) return true;
    if (p.endsWith("*") && fp.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

export function detectContractDrift(
  filesByPath: Map<string, string>,
  contracts: EnumContract[]
): ContractDriftHit[] {
  if (contracts.length === 0) return [];
  // Build a quick lookup: for each contract, which column(s) should
  // bind it? If `column` is set, only that. If not, the contract.name
  // is treated as the binding column (matches the convention where
  // file `job-status.json` covers `.status` comparisons; users can
  // override with explicit `column`).
  const out: ContractDriftHit[] = [];

  for (const [filePath, content] of filesByPath.entries()) {
    if (!isCodeFile(filePath)) continue;
    if (isLikelyTestOrMigrationPath(filePath)) continue;
    // 0.3.1: filter contracts to those applicable to this file.
    const applicableContracts = contracts.filter((c) => contractMatchesFile(c, filePath));
    if (applicableContracts.length === 0) continue;
    const lines = content.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];

      // Consumer reads: `.column === "value"` / `== "value"`.
      let cm: RegExpExecArray | null;
      CONSUMER_REGEX.lastIndex = 0;
      while ((cm = CONSUMER_REGEX.exec(line)) !== null) {
        const [, column, value] = cm;
        for (const c of applicableContracts) {
          const bindColumn = c.column ?? c.name;
          if (column !== bindColumn) continue;
          if (c.values.includes(value)) continue;
          out.push({
            kind: "consumer-uses-undeclared",
            contract: c,
            filePath,
            line: li + 1,
            value,
            column,
            excerpt: line.trim().slice(0, 160),
          });
        }
      }

      // Producer writes: object-literal `column: "value"` and `column = "value"`.
      for (const re of [PRODUCER_REGEX, ASSIGN_REGEX]) {
        let pm: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((pm = re.exec(line)) !== null) {
          const [, column, value] = pm;
          for (const c of applicableContracts) {
            const bindColumn = c.column ?? c.name;
            if (column !== bindColumn) continue;
            if (c.values.includes(value)) continue;
            out.push({
              kind: "producer-emits-undeclared",
              contract: c,
              filePath,
              line: li + 1,
              value,
              column,
              excerpt: line.trim().slice(0, 160),
            });
          }
        }
      }
    }
  }

  // Dedupe — same (kind, file, line, value, contract) can be emitted
  // twice when two regexes both match (rare but possible).
  const seen = new Set<string>();
  return out.filter((h) => {
    const key = `${h.kind}:${h.filePath}:${h.line}:${h.value}:${h.contract.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Helper for the CLI/sweep: a stable, human-readable description of
// each hit. Used in PR comments + statusline + sweep output.
export function describeContractHit(h: ContractDriftHit): string {
  const declared = h.contract.values.join(" | ");
  if (h.kind === "consumer-uses-undeclared") {
    return `enum-drift: ${h.filePath}:${h.line} compares ${h.column} === "${h.value}", but contract ${h.contract.name} (${h.contract.sourcePath}) only declares [${declared}]. Likely producer-in-different-repo bug or stale enum.`;
  }
  return `enum-drift: ${h.filePath}:${h.line} writes ${h.column}: "${h.value}", but contract ${h.contract.name} (${h.contract.sourcePath}) only declares [${declared}]. Producer is emitting a value the contract does not allow — consumers will not recognize it.`;
}
