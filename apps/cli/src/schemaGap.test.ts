// Tests for 0.3.3 schema-detector gap fix — table-missing detection
// in detectSupabaseColumnExists. Cipherwake-dogfood reported:
//
//   "POST → 500 on missing relation. Static detectors saw the write
//    surface but skipped the hit because the table wasn't declared."
//
// The fix extends detectSupabaseColumnExists to also fire on
// WRITE-touched tables that don't appear in any schema source.
// Precision gates: writes only (insert/update/upsert/delete),
// skip Supabase built-ins, only fires when at least one schema
// source exists (no schema = no ground truth).

import { describe, it, expect } from "vitest";
import { detectSupabaseColumnExists } from "./scanDiff.js";

describe("schema-gap (0.3.3 table-missing detection)", () => {
  it("fires on INSERT into undeclared table", () => {
    const files = new Map<string, string>([
      ["supabase/migrations/0001_init.sql", "CREATE TABLE public.users (id uuid primary key, email text);"],
      ["app/api/feedback/route.ts", `
        export async function POST(req: Request) {
          await supabase.from("feedback").insert({ rating: 5, comment: "x" });
        }
      `],
    ]);
    const hits = detectSupabaseColumnExists(files);
    const feedback = hits.find((h) => h.table === "feedback");
    expect(feedback).toBeDefined();
    expect(feedback!.declaredColumns).toEqual([]);
    expect(feedback!.suggestedPin).toContain("NOT declared");
    expect(feedback!.suggestedPin).toContain("Runtime 500");
  });

  it("fires on DELETE against undeclared table", () => {
    const files = new Map<string, string>([
      ["supabase/migrations/0001_init.sql", "CREATE TABLE public.users (id uuid primary key);"],
      ["app/api/admin.ts", `await supabase.from("audit_log").delete().eq("user_id", id);`],
    ]);
    const hits = detectSupabaseColumnExists(files);
    expect(hits.some((h) => h.table === "audit_log")).toBe(true);
  });

  it("does NOT fire when the table IS declared (column-drift path handles it)", () => {
    const files = new Map<string, string>([
      ["supabase/migrations/0001_init.sql", `
        CREATE TABLE public.users (id uuid primary key);
        CREATE TABLE public.feedback (id uuid primary key, rating int, comment text);
      `],
      ["app/api/feedback/route.ts", `await supabase.from("feedback").insert({ rating: 5, comment: "x" });`],
    ]);
    expect(detectSupabaseColumnExists(files)).toHaveLength(0);
  });

  it("does NOT fire on SELECT-only against undeclared table (ambiguous — could be view/RPC)", () => {
    const files = new Map<string, string>([
      ["supabase/migrations/0001_init.sql", "CREATE TABLE public.users (id uuid primary key);"],
      ["app/api/data.ts", `const r = await supabase.from("some_view").select("a, b");`],
    ]);
    expect(detectSupabaseColumnExists(files)).toHaveLength(0);
  });

  it("does NOT fire on Supabase built-in tables (auth.users via .from('users'))", () => {
    const files = new Map<string, string>([
      ["supabase/migrations/0001_init.sql", "CREATE TABLE public.profiles (id uuid primary key);"],
      ["app/api/auth.ts", `await supabase.from("users").update({ last_seen: new Date() });`],
    ]);
    expect(detectSupabaseColumnExists(files)).toHaveLength(0);
  });

  it("does NOT fire when no schema sources exist (no ground truth)", () => {
    const files = new Map<string, string>([
      ["app/api/feedback/route.ts", `await supabase.from("feedback").insert({ rating: 5 });`],
    ]);
    expect(detectSupabaseColumnExists(files)).toHaveLength(0);
  });

  it("aggregates multiple writes to the same missing table into a single hit", () => {
    const files = new Map<string, string>([
      ["supabase/migrations/0001_init.sql", "CREATE TABLE public.users (id uuid primary key);"],
      ["app/api/a.ts", `await supabase.from("comments").insert({ body: x });`],
      ["app/api/b.ts", `await supabase.from("comments").update({ edited: true });`],
    ]);
    const hits = detectSupabaseColumnExists(files);
    const comments = hits.filter((h) => h.table === "comments");
    expect(comments).toHaveLength(1);
    expect(comments[0].consumerSites.length).toBe(2);
  });
});
