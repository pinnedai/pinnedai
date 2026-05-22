#!/usr/bin/env node
// Configurable CLI binary for cli-* template audits.
//
// Behavior is controlled via env vars so the same binary can serve as
// both the positive control (healthy CLI) and the negative control
// (broken CLI) for every cli-* template.
//
// Env vars (read-once at startup):
//   PINNED_AUDIT_STDOUT       — text to print to stdout (default: "")
//   PINNED_AUDIT_STDERR       — text to print to stderr (default: "")
//   PINNED_AUDIT_EXIT         — exit code to return (default: 0)
//   PINNED_AUDIT_CREATE_FILE  — if set, create this file in cwd before exit
//   PINNED_AUDIT_HELP_TEXT    — if --help is in argv, print this and exit 0
//                                (overrides PINNED_AUDIT_STDOUT)
//
// Healthy / broken behavior for each template:
//   cli-output-contains   — healthy: STDOUT=expected_substring; broken: STDOUT="something else"
//   cli-exits-zero        — healthy: EXIT=0; broken: EXIT=1
//   cli-creates-file      — healthy: CREATE_FILE=expected; broken: CREATE_FILE unset
//   cli-flag-supported    — healthy: HELP_TEXT contains --flag; broken: HELP_TEXT empty

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--help") && process.env.PINNED_AUDIT_HELP_TEXT !== undefined) {
  process.stdout.write(process.env.PINNED_AUDIT_HELP_TEXT);
  process.exit(0);
}

if (process.env.PINNED_AUDIT_STDOUT) {
  process.stdout.write(process.env.PINNED_AUDIT_STDOUT);
}
if (process.env.PINNED_AUDIT_STDERR) {
  process.stderr.write(process.env.PINNED_AUDIT_STDERR);
}

if (process.env.PINNED_AUDIT_CREATE_FILE) {
  // Defense in depth: refuse absolute paths so the audit can't
  // accidentally write outside its tempdir.
  const target = process.env.PINNED_AUDIT_CREATE_FILE;
  if (target.startsWith("/") || target.includes("..")) {
    process.stderr.write(
      `[cli-fixture] refusing unsafe PINNED_AUDIT_CREATE_FILE: ${target}\n`
    );
    process.exit(2);
  }
  writeFileSync(resolve(process.cwd(), target), "audit-fixture-output\n");
}

const exit = Number(process.env.PINNED_AUDIT_EXIT ?? "0");
process.exit(Number.isInteger(exit) ? exit : 0);
