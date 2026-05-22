// FEATURE: Safety Pass — deterministic static scan (env-vars,
//   NEXT_PUBLIC secret-shape, CORS wildcards, destructive SQL, lint
//   escape hatches).
// SIGNAL: each rule fires when a triggering pattern is present, AND
//   does NOT fire when the pattern is absent. The pos/neg pair per
//   rule is the falsifiability check.

import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSafetyPass } from "../../apps/cli/src/safetyPass.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pinned-safety-audit-"));
}

describe("FEATURE-AUDIT: Safety Pass — env-var documentation rule", () => {
  it("POSITIVE CONTROL: fires when process.env.X is used but X is missing from .env.example", () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, ".env.example"), "ALLOWED_VAR=\n");
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src/handler.ts"),
        "export const k = process.env.UNDOCUMENTED_KEY;"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find(
        (f) =>
          f.rule === "env-var-not-documented" &&
          f.message.includes("UNDOCUMENTED_KEY")
      );
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe("warn");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: env var IS in .env.example → no finding", () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, ".env.example"), "STRIPE_KEY=\n");
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src/handler.ts"),
        "export const k = process.env.STRIPE_KEY;"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find(
        (f) => f.rule === "env-var-not-documented"
      );
      expect(hit).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: no .env.example file → check skipped (no false positives)", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src/handler.ts"),
        "export const k = process.env.ANYTHING;"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find(
        (f) => f.rule === "env-var-not-documented"
      );
      expect(hit).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: Safety Pass — NEXT_PUBLIC secret-shape rule", () => {
  it("POSITIVE CONTROL: NEXT_PUBLIC_STRIPE_SECRET fires the secret-shape warning", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src/leak.ts"),
        "export const k = process.env.NEXT_PUBLIC_STRIPE_SECRET;"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "next-public-secret-shape");
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe("warn");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: NEXT_PUBLIC_PUBLISHABLE_KEY (intentionally public) does NOT fire", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src/ok.ts"),
        "export const k = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "next-public-secret-shape");
      expect(hit).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: NEXT_PUBLIC_APP_URL (no secret keyword) does NOT fire", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src/ok.ts"),
        "export const k = process.env.NEXT_PUBLIC_APP_URL;"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "next-public-secret-shape");
      expect(hit).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: Safety Pass — CORS wildcard rule", () => {
  it("POSITIVE CONTROL: Access-Control-Allow-Origin: '*' fires", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src/cors.ts"),
        `const headers = { "Access-Control-Allow-Origin": "*" };`
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "cors-wildcard");
      expect(hit).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: specific origin doesn't fire", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src/cors.ts"),
        `const headers = { "Access-Control-Allow-Origin": "https://example.com" };`
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "cors-wildcard");
      expect(hit).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: Safety Pass — destructive SQL rule", () => {
  it("POSITIVE CONTROL: DROP TABLE in a .sql file fires", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "migrations"));
      writeFileSync(
        join(root, "migrations/001.sql"),
        "DROP TABLE old_users;\n"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "destructive-sql");
      expect(hit).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: TRUNCATE fires", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "migrations"));
      writeFileSync(
        join(root, "migrations/002.sql"),
        "TRUNCATE TABLE sessions;\n"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "destructive-sql");
      expect(hit).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: CREATE TABLE / ALTER TABLE doesn't fire", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "migrations"));
      writeFileSync(
        join(root, "migrations/003.sql"),
        "CREATE TABLE new_users (id INT);\nALTER TABLE users ADD COLUMN x INT;\n"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "destructive-sql");
      expect(hit).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: DELETE WITH a WHERE clause doesn't fire (scoped delete is normal)", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "migrations"));
      writeFileSync(
        join(root, "migrations/004.sql"),
        "DELETE FROM users WHERE id = 5;\n"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "destructive-sql");
      expect(hit).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: Safety Pass — lint escape-hatch rule", () => {
  it("POSITIVE CONTROL: @ts-ignore fires (info severity)", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src/x.ts"),
        "// @ts-ignore\nconst x: number = '5' as any;"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "lint-escape-hatch");
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe("info");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: clean source doesn't fire", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src/x.ts"),
        "const x: number = 5;\nexport default x;"
      );
      const findings = runSafetyPass(root);
      const hit = findings.find((f) => f.rule === "lint-escape-hatch");
      expect(hit).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: Safety Pass — symlink + ignored-dir defense", () => {
  it("NEGATIVE CONTROL: node_modules/ contents are NOT scanned", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "node_modules/badpkg"), { recursive: true });
      writeFileSync(
        join(root, "node_modules/badpkg/leak.ts"),
        "export const k = process.env.NEXT_PUBLIC_STRIPE_SECRET;"
      );
      const findings = runSafetyPass(root);
      // The badpkg leak above would normally fire next-public-secret-shape,
      // but node_modules is ignored.
      const hit = findings.find((f) =>
        f.file.includes("node_modules")
      );
      expect(hit).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
