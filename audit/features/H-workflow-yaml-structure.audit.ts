// FEATURE: GitHub Action workflow YAML structural properties
//   (H.1 — H.7, plus C.9, C.10 carry-over)
// SIGNAL: the emitted `.github/workflows/pinned.yml` has specific
//   load-bearing structural elements (triggers, perms, concurrency,
//   author_association gate, pinned[bot] identity, gh pr comment use,
//   PINNEDAI_AUTOCOMMIT env var conditional, @pinned add: trigger).
// FALSIFIABILITY: any of these silently dropping would break the
//   advertised behavior — caught by structural assertions.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

let YML = "";
let CWD = "";

beforeAll(async () => {
  CWD = makeTempRepo();
  await runCli(["init"], { cwd: CWD, cleanup: false });
  YML = readFileSync(join(CWD, ".github/workflows/pinned.yml"), "utf8");
});

afterAll(() => {
  rmSync(CWD, { recursive: true, force: true });
});

function afterAll(fn: () => void) {
  // Vitest's afterAll — re-exported via vitest namespace
  // (we don't want a second import line). Defensive proxy.
  import("vitest").then((v) => v.afterAll(fn));
}

describe("FEATURE-AUDIT: H1 — workflow triggers on PR open/sync/edit", () => {
  it("POSITIVE CONTROL: YAML contains pull_request types: [opened, synchronize, edited]", () => {
    expect(YML).toContain("pull_request:");
    expect(YML).toContain("types: [opened, synchronize, edited]");
  });

  it("NEGATIVE CONTROL: NOT triggering on push to main (we want per-PR scope)", () => {
    // Look for an explicit push-to-main trigger that would over-fire.
    expect(YML).not.toMatch(/^\s*push:\s*\n\s*branches:\s*\[main\]/m);
  });
});

describe("FEATURE-AUDIT: H2 — @pinned add: trigger is gated to trusted commenters", () => {
  it("POSITIVE CONTROL: YAML has author_association check", () => {
    expect(YML).toContain("author_association");
    expect(YML).toContain("OWNER");
    expect(YML).toContain("MEMBER");
    expect(YML).toContain("COLLABORATOR");
  });

  it("POSITIVE CONTROL: trigger event is issue_comment with 'created'", () => {
    expect(YML).toContain("issue_comment:");
    expect(YML).toContain("types: [created]");
  });

  it("FALSIFIABILITY: the trigger explicitly requires `@pinned add:` text in the comment body", () => {
    expect(YML).toContain("@pinned add:");
  });
});

describe("FEATURE-AUDIT: H3 — auto-commit uses pinned[bot] identity", () => {
  it("POSITIVE CONTROL: git config sets user.name 'pinned[bot]'", () => {
    expect(YML).toContain('user.name "pinned[bot]"');
    expect(YML).toContain('user.email "bot@pinnedai.dev"');
  });
});

describe("FEATURE-AUDIT: H4 — auto-commit gated by PINNEDAI_AUTOCOMMIT repo var", () => {
  it("POSITIVE CONTROL: YAML conditions the auto-commit job on vars.PINNEDAI_AUTOCOMMIT != 'false'", () => {
    expect(YML).toContain("vars.PINNEDAI_AUTOCOMMIT");
    expect(YML).toContain("!= 'false'");
  });
});

describe("FEATURE-AUDIT: H5 — PR comment posted via gh pr comment", () => {
  it("POSITIVE CONTROL: YAML uses `gh pr comment` with $PR_NUM", () => {
    expect(YML).toContain('gh pr comment "$PR_NUM"');
  });
});

describe("FEATURE-AUDIT: H6 — concurrency block prevents PR-open + @pinned add races", () => {
  it("POSITIVE CONTROL: YAML has concurrency: group keyed on PR / issue number", () => {
    expect(YML).toContain("concurrency:");
    expect(YML).toMatch(/group:.*pull_request\.number.*issue\.number/);
  });
});

describe("FEATURE-AUDIT: H1c (C.9 + C.10) — workflow includes auth-required permissions", () => {
  it("POSITIVE CONTROL: YAML declares id-token + contents + pull-requests permissions", () => {
    expect(YML).toContain("id-token: write");
    expect(YML).toContain("contents: write");
    expect(YML).toContain("pull-requests: write");
  });
});
