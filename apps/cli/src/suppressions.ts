// Per-repo FP suppression store.
//
// Per [[anything-annoying-must-be-opt-in]] AND the build-plan's
// explicit callout: "FP fatigue kills adoption faster than misses —
// treat this as required, not optional." When a user dismisses a
// detector hit, persist it so it never re-fires.
//
// Stable suppression key = SHA-256(detector + filePath + normalized
// signature). "Normalized signature" means: for hits that have a
// `signature` field (auth-required, rate-limit etc.) we hash the
// signature directly; for hits with `(file, line, value)` shape
// (enum-drift, contract drift, mass-mutation) we hash the
// (file, value) — NOT the line — so a benign refactor that shifts
// line numbers doesn't blow up the suppression.
//
// Browser-safety: this module reads/writes .pinned/suppressions.json,
// so it's Node-only. Detector code is browser-safe; the gate that
// consults the store lives in the CLI/sweep path.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

export type Suppression = {
  // Stable hash — `${detector}:${sha256(detector + filePath + normalized)}`
  // Prefix on the detector name keeps the keyspace browseable in the
  // file (`pinned list --include-suppressed | grep enum-drift`).
  id: string;
  detector: string;
  filePath: string;
  // Free-form normalized fingerprint of WHAT specifically was
  // suppressed — value, signature, column, etc. Goes into the hash
  // and is also stored verbatim so users can audit the file.
  fingerprint: string;
  reason: string;
  dismissedAt: string; // ISO8601
  dismissedBy?: string;
};

export type SuppressionStore = {
  version: 1;
  suppressions: Suppression[];
};

const STORE_PATH = ".pinned/suppressions.json";

export function suppressionPath(cwd: string): string {
  return join(cwd, STORE_PATH);
}

export function readStore(cwd: string): SuppressionStore {
  const p = suppressionPath(cwd);
  if (!existsSync(p)) {
    return { version: 1, suppressions: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return { version: 1, suppressions: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted store — fail closed (don't silently lose suppressions
    // by overwriting). The user has to fix it; that's the right
    // behavior because suppressions are user intent.
    throw new Error(
      `Corrupt .pinned/suppressions.json at ${p}. Fix the file or delete it to reset.`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    return { version: 1, suppressions: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const suppressions = Array.isArray(obj.suppressions)
    ? (obj.suppressions as unknown[]).filter(
        (s): s is Suppression =>
          !!s &&
          typeof s === "object" &&
          typeof (s as Suppression).id === "string" &&
          typeof (s as Suppression).detector === "string"
      )
    : [];
  return { version: 1, suppressions };
}

export function writeStore(cwd: string, store: SuppressionStore): void {
  const p = suppressionPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n");
}

// Build a stable suppression ID from the detector + file + fingerprint.
// Same inputs MUST produce the same ID — that's the whole point.
export function makeSuppressionId(
  detector: string,
  filePath: string,
  fingerprint: string
): string {
  const h = createHash("sha256");
  h.update(detector + "|" + filePath + "|" + fingerprint);
  return `${detector}:${h.digest("hex").slice(0, 16)}`;
}

// Check whether a hit is suppressed. The caller passes the detector
// name + filePath + fingerprint; we hash and look up.
export function isSuppressed(
  store: SuppressionStore,
  detector: string,
  filePath: string,
  fingerprint: string
): boolean {
  const id = makeSuppressionId(detector, filePath, fingerprint);
  return store.suppressions.some((s) => s.id === id);
}

// Add a new suppression. Idempotent — adding the same id twice is a
// no-op (returns the existing entry).
export function addSuppression(
  store: SuppressionStore,
  args: {
    detector: string;
    filePath: string;
    fingerprint: string;
    reason: string;
    dismissedBy?: string;
  }
): { store: SuppressionStore; added: boolean; entry: Suppression } {
  const id = makeSuppressionId(args.detector, args.filePath, args.fingerprint);
  const existing = store.suppressions.find((s) => s.id === id);
  if (existing) {
    return { store, added: false, entry: existing };
  }
  const entry: Suppression = {
    id,
    detector: args.detector,
    filePath: args.filePath,
    fingerprint: args.fingerprint,
    reason: args.reason,
    dismissedAt: new Date().toISOString(),
    dismissedBy: args.dismissedBy,
  };
  return {
    store: { version: 1, suppressions: [...store.suppressions, entry] },
    added: true,
    entry,
  };
}

// Remove a suppression. Used by `pinned suppress remove <id>`.
export function removeSuppression(
  store: SuppressionStore,
  id: string
): { store: SuppressionStore; removed: boolean } {
  const next = store.suppressions.filter((s) => s.id !== id);
  return {
    store: { version: 1, suppressions: next },
    removed: next.length !== store.suppressions.length,
  };
}

// Helper: convert a detector hit object into the fingerprint string we
// hash. Different detector shapes need different fingerprint inputs,
// so this is the central place to keep the mapping consistent. Adding
// a new detector that needs suppression support adds one case here.
export function fingerprintFor(detector: string, hit: Record<string, unknown>): string {
  // Use only stable, refactor-robust fields. NEVER use `line` (shifts
  // on benign edits) or `excerpt` (whitespace-sensitive).
  switch (detector) {
    case "enum-drift":
      return `column=${hit.column ?? ""};missing=${
        Array.isArray(hit.missingFromProducer)
          ? (hit.missingFromProducer as string[]).slice().sort().join(",")
          : ""
      }`;
    case "contract-drift":
      // Used by the new cross-repo contract detector.
      return `kind=${hit.kind ?? ""};column=${hit.column ?? ""};value=${hit.value ?? ""}`;
    case "env-required":
      return `keys=${
        Array.isArray(hit.requiredKeys)
          ? (hit.requiredKeys as string[]).slice().sort().join(",")
          : ""
      }`;
    case "supabase-column":
      return `table=${hit.table ?? ""};cols=${
        Array.isArray(hit.referencedColumns)
          ? (hit.referencedColumns as string[]).slice().sort().join(",")
          : ""
      }`;
    case "expected-header":
      return `header=${hit.expectedHeader ?? ""};provider=${hit.provider ?? ""}`;
    case "nullable-result":
      return `source=${hit.source ?? ""}`;
    case "response-shape":
      return `route=${hit.route ?? ""};keys=${
        Array.isArray(hit.consumerReads)
          ? (hit.consumerReads as string[]).slice().sort().join(",")
          : ""
      }`;
    case "mass-mutation":
      return `op=${hit.operation ?? ""};table=${hit.table ?? ""}`;
    default:
      // Generic fallback — produces a usable fingerprint for any
      // detector not enumerated above. Loses some refactor-robustness
      // but better than no support.
      return JSON.stringify(hit);
  }
}
