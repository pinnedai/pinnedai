// Library entry — re-exports the pure (browser-safe) pieces of
// pinnedai so they can be consumed from the landing page demo or any
// non-CLI integration. The Node-only modules (cli.ts, fs writes) are
// deliberately not exported here.
export {
  parseClaims,
  claimSlug,
  claimKey,
  unionClaims,
  describeClaimHuman,
  describeClaimForUser,
} from "./claimParser.js";
export type { ClaimDisplay } from "./claimParser.js";
export type {
  Claim,
  RateLimitClaim,
  AuthRequiredClaim,
  PermissionRequiredClaim,
  TierCapClaim,
  IdempotentClaim,
  ReturnsStatusClaim,
  CliOutputContainsClaim,
  CliExitsZeroClaim,
  CliCreatesFileClaim,
  CliFlagSupportedClaim,
  LibraryReturnsClaim,
} from "./claimParser.js";
export { generateRateLimitTest } from "./templates/rateLimit.js";
export { generateAuthRequiredTest } from "./templates/authRequired.js";
export { generatePermissionRequiredTest } from "./templates/permissionRequired.js";
export { generateTierCapTest } from "./templates/tierCap.js";
export { generateIdempotentTest } from "./templates/idempotent.js";
export { generateReturnsStatusTest } from "./templates/returnsStatus.js";
export { generateCliOutputContainsTest } from "./templates/cliOutputContains.js";
export { generateCliExitsZeroTest } from "./templates/cliExitsZero.js";
export { generateCliCreatesFileTest } from "./templates/cliCreatesFile.js";
export { generateCliFlagSupportedTest } from "./templates/cliFlagSupported.js";
export { generateLibraryReturnsTest } from "./templates/libraryReturns.js";
export type { GeneratedTest, GenerateOpts } from "./templates/rateLimit.js";

import type { Claim } from "./claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./templates/rateLimit.js";
import { generateRateLimitTest } from "./templates/rateLimit.js";
import { generateAuthRequiredTest } from "./templates/authRequired.js";
import { generatePermissionRequiredTest } from "./templates/permissionRequired.js";
import { generateTierCapTest } from "./templates/tierCap.js";
import { generateIdempotentTest } from "./templates/idempotent.js";
import { generateReturnsStatusTest } from "./templates/returnsStatus.js";
import { generateCliOutputContainsTest } from "./templates/cliOutputContains.js";
import { generateCliExitsZeroTest } from "./templates/cliExitsZero.js";
import { generateCliCreatesFileTest } from "./templates/cliCreatesFile.js";
import { generateCliFlagSupportedTest } from "./templates/cliFlagSupported.js";
import { generateLibraryReturnsTest } from "./templates/libraryReturns.js";

// Convenience dispatcher — given any Claim, pick the right generator.
// Keeps callers (CLI, landing demo, hosted Worker) DRY.
export function generateTest(claim: Claim, opts: GenerateOpts): GeneratedTest {
  switch (claim.template) {
    case "rate-limit":
      return generateRateLimitTest(claim, opts);
    case "auth-required":
      return generateAuthRequiredTest(claim, opts);
    case "permission-required":
      return generatePermissionRequiredTest(claim, opts);
    case "tier-cap":
      return generateTierCapTest(claim, opts);
    case "idempotent":
      return generateIdempotentTest(claim, opts);
    case "returns-status":
      return generateReturnsStatusTest(claim, opts);
    case "cli-output-contains":
      return generateCliOutputContainsTest(claim, opts);
    case "cli-exits-zero":
      return generateCliExitsZeroTest(claim, opts);
    case "cli-creates-file":
      return generateCliCreatesFileTest(claim, opts);
    case "cli-flag-supported":
      return generateCliFlagSupportedTest(claim, opts);
    case "library-returns":
      return generateLibraryReturnsTest(claim, opts);
  }
  // Exhaustiveness guard — if a new Claim variant is added without a
  // case here, TS will fail to compile this assignment with a clear
  // "Type X is not assignable to type 'never'" error. Catches the
  // class of bug where a new template silently returns undefined.
  const _exhaustive: never = claim;
  return _exhaustive;
}
