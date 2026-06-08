// Cipherwake 0.6.0 ask #1 — incremental detection on hooks.
//
// Real bug: a session's pre-commit auto-protect printed "✓ No new
// behaviors to protect" on EVERY commit while the user added public
// routes, a BYOK server action handling API keys, and status-gated
// content. Inert. Sweep (full-tree scan) found everything at the
// end of the session, but the pre-commit / PostToolUse loop missed
// it all in real time.
//
// Root cause: classifyDiff() in autoProtect.ts was missing the
// HIGH-value detectors that sweep already had — server-action-write,
// paid-api-call, edge-function-write, cron-handler, stripe-event-
// handled, visibility-invariant. They produce hits at sweep time but
// not at hook time.
//
// Fix (in this session): wire those detectors into classifyDiff so
// the pre-commit / PostToolUse hook proposes them on the diff as
// risky surfaces are added.

import { describe, it, expect } from "vitest";
import { classifyDiff } from "./autoProtect.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setupRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "incremental-detect-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("[ask #1] classifyDiff proposes HIGH-value pins on the diff (hook-time, not just sweep-time)", () => {
  it("server-action-write — proposes pin when a 'use server' export performs a db write", () => {
    const { root, cleanup } = setupRepo({
      "app/actions/saveKey.ts": `
"use server";
import { db } from "@/lib/db";
export async function saveByokKey(formData: FormData) {
  const provider = formData.get("provider");
  const key = formData.get("key");
  await db.from("user_keys").insert({ provider, key });
  return { ok: true };
}
      `,
    });
    try {
      const result = classifyDiff({
        repoRoot: root,
        changedFiles: [{ path: "app/actions/saveKey.ts", status: "added" }],
        prBodyClaims: [],
        existingPins: [],
      });
      const all = [...result.safe, ...result.ask];
      const hasServerAction = all.some((c) => c.claim.template === "server-action-write");
      expect(hasServerAction, "expected a server-action-write candidate on diff").toBe(true);
    } finally { cleanup(); }
  });

  it("paid-api-call — proposes pin when an OpenAI/Anthropic call lands in the diff", () => {
    const { root, cleanup } = setupRepo({
      "lib/llm.ts": `
import OpenAI from "openai";
const openai = new OpenAI();
export async function summarize(text: string) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: text }],
  });
  return res.choices[0].message.content;
}
      `,
    });
    try {
      const result = classifyDiff({
        repoRoot: root,
        changedFiles: [{ path: "lib/llm.ts", status: "added" }],
        prBodyClaims: [],
        existingPins: [],
      });
      const all = [...result.safe, ...result.ask];
      const hasPaid = all.some((c) => c.claim.template === "paid-api-call");
      expect(hasPaid, "expected a paid-api-call candidate on diff").toBe(true);
    } finally { cleanup(); }
  });

  it("visibility-invariant — proposes pin when a public route + status-discriminant collection both exist", () => {
    const { root, cleanup } = setupRepo({
      "lib/ideas.ts": `
export const IDEAS = [
  { slug: "a", status: "live" },
  { slug: "b", status: "draft" },
  { slug: "c", status: "archived" },
];
      `,
      "app/preview/[slug]/page.tsx": `
import { IDEAS } from "@/lib/ideas";
export default function Page() { return IDEAS; }
      `,
    });
    try {
      const result = classifyDiff({
        repoRoot: root,
        changedFiles: [
          { path: "lib/ideas.ts", status: "added" },
          { path: "app/preview/[slug]/page.tsx", status: "added" },
        ],
        prBodyClaims: [],
        existingPins: [],
      });
      const all = [...result.safe, ...result.ask];
      const hasVisibility = all.some((c) => c.claim.template === "visibility-invariant");
      expect(hasVisibility, "expected a visibility-invariant candidate on diff").toBe(true);
    } finally { cleanup(); }
  });

  it("does NOT silently produce zero candidates on a session full of risky surfaces (the Cipherwake bug)", () => {
    const { root, cleanup } = setupRepo({
      "app/actions/saveKey.ts": `
"use server";
import { db } from "@/lib/db";
export async function saveByokKey(fd: FormData) {
  await db.from("user_keys").insert({ key: fd.get("k") });
  return { ok: true };
}
      `,
      "lib/llm.ts": `
import OpenAI from "openai";
const openai = new OpenAI();
export async function callLlm(text: string) {
  return openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: text }],
  });
}
      `,
      "lib/ideas.ts": `
export const IDEAS = [
  { slug: "a", status: "live" },
  { slug: "b", status: "draft" },
  { slug: "c", status: "archived" },
];
      `,
      "app/preview/[slug]/page.tsx": `
import { IDEAS } from "@/lib/ideas";
export default function Page() { return IDEAS; }
      `,
    });
    try {
      const result = classifyDiff({
        repoRoot: root,
        changedFiles: [
          { path: "app/actions/saveKey.ts", status: "added" },
          { path: "lib/llm.ts", status: "added" },
          { path: "lib/ideas.ts", status: "added" },
          { path: "app/preview/[slug]/page.tsx", status: "added" },
        ],
        prBodyClaims: [],
        existingPins: [],
      });
      const all = [...result.safe, ...result.ask];
      // Before this fix: zero candidates. After: at least 3
      // (server-action-write + paid-api-call + visibility-invariant).
      expect(all.length, "session full of risky surfaces should NOT produce zero candidates").toBeGreaterThanOrEqual(3);
    } finally { cleanup(); }
  });
});
