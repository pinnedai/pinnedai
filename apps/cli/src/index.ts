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
  CliJsonShapeClaim,
  CliFlagSupportedClaim,
  LibraryReturnsClaim,
  ConfigInvariantClaim,
  LockfileIntegrityClaim,
  PackageExportsClaim,
  SecretNotPublicClaim,
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
export { generateCliJsonShapeTest } from "./templates/cliJsonShape.js";
export { generateCliFlagSupportedTest } from "./templates/cliFlagSupported.js";
export { generateLibraryReturnsTest } from "./templates/libraryReturns.js";
export { generateLockfileIntegrityTest } from "./templates/lockfileIntegrity.js";
export { generateConfigInvariantTest } from "./templates/configInvariant.js";
export { generatePackageExportsExistTest } from "./templates/packageExportsExist.js";
export { generateSecretNotPublicTest } from "./templates/secretNotPublic.js";
export { generateUrlLiteralPreservedTest } from "./templates/urlLiteralPreserved.js";
export { generateTscCleanTest } from "./templates/tscClean.js";
export { generateModuleExportStableTest } from "./templates/moduleExportStable.js";
export { generateReactRouteRegisteredTest } from "./templates/reactRouteRegistered.js";
export { generateWebhookHandlerExistsTest } from "./templates/webhookHandlerExists.js";
export { generateImportPathResolvesTest } from "./templates/importPathResolves.js";
export { generateChangedLiteralPreservedTest } from "./templates/changedLiteralPreserved.js";
export { generateFormSubmitErrorHandlingTest } from "./templates/formSubmitErrorHandling.js";
export { generatePageRendersTest } from "./templates/pageRenders.js";
export { generateValidationRejectsBadTest } from "./templates/validationRejectsBad.js";
export { generateHappyPathWithSideEffectTest } from "./templates/happyPathWithSideEffect.js";
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
import { generateCliJsonShapeTest } from "./templates/cliJsonShape.js";
import { generateCliFlagSupportedTest } from "./templates/cliFlagSupported.js";
import { generateLibraryReturnsTest } from "./templates/libraryReturns.js";
import { generateLockfileIntegrityTest } from "./templates/lockfileIntegrity.js";
import { generateConfigInvariantTest } from "./templates/configInvariant.js";
import { generatePackageExportsExistTest } from "./templates/packageExportsExist.js";
import { generateSecretNotPublicTest } from "./templates/secretNotPublic.js";
import { generateUrlLiteralPreservedTest } from "./templates/urlLiteralPreserved.js";
import { generateTscCleanTest } from "./templates/tscClean.js";
import { generateModuleExportStableTest } from "./templates/moduleExportStable.js";
import { generateReactRouteRegisteredTest } from "./templates/reactRouteRegistered.js";
import { generateWebhookHandlerExistsTest } from "./templates/webhookHandlerExists.js";
import { generateImportPathResolvesTest } from "./templates/importPathResolves.js";
import { generateChangedLiteralPreservedTest } from "./templates/changedLiteralPreserved.js";
import { generateFormSubmitErrorHandlingTest } from "./templates/formSubmitErrorHandling.js";
import { generatePageRendersTest } from "./templates/pageRenders.js";
import { generateValidationRejectsBadTest } from "./templates/validationRejectsBad.js";
import { generateHappyPathWithSideEffectTest } from "./templates/happyPathWithSideEffect.js";
import { generateJourneyTest } from "./templates/journey.js";

// Convenience dispatcher — given any Claim, pick the right generator.
// Keeps callers (CLI, landing demo, hosted Worker) DRY.
//
// When opts.pinnedVersion is set, injects a `// generated-by:
// pinnedai@<version>` header into the emitted content so future
// `pinned regenerate` runs can detect stale pins (pins whose template
// emit predates a template-bug fix). See
// [[library-upgrades-must-include-pin-regenerate]] memory.
function stampGeneratedBy(result: GeneratedTest, version: string | undefined): GeneratedTest {
  if (!version) return result;
  const stamp = `// generated-by: pinnedai@${version}\n`;
  // Inject right after the leading banner header so it stays near the
  // top of the file regardless of which template emitted it. We look
  // for the first blank line after the "═" banner block; if not found,
  // prepend at the very top.
  const lines = result.content.split("\n");
  let insertAt = 0;
  let inBanner = false;
  for (let i = 0; i < lines.length && i < 30; i++) {
    if (lines[i].includes("═══")) {
      inBanner = true;
      continue;
    }
    if (inBanner && lines[i].trim() === "") {
      insertAt = i;
      break;
    }
  }
  const updated = [
    ...lines.slice(0, insertAt),
    stamp.trimEnd(),
    ...lines.slice(insertAt),
  ].join("\n");
  return { ...result, content: updated };
}

export function generateTest(claim: Claim, opts: GenerateOpts): GeneratedTest {
  const result = dispatchToTemplate(claim, opts);
  return stampGeneratedBy(result, opts.pinnedVersion);
}

function dispatchToTemplate(claim: Claim, opts: GenerateOpts): GeneratedTest {
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
    case "cli-json-shape":
      return generateCliJsonShapeTest(claim, opts);
    case "cli-flag-supported":
      return generateCliFlagSupportedTest(claim, opts);
    case "library-returns":
      return generateLibraryReturnsTest(claim, opts);
    case "lockfile-integrity":
      return generateLockfileIntegrityTest(claim, opts);
    case "config-invariant":
      return generateConfigInvariantTest(claim, opts);
    case "package-exports-exist":
      return generatePackageExportsExistTest(claim, opts);
    case "secret-not-public":
      return generateSecretNotPublicTest(claim, opts);
    case "url-literal-preserved":
      return generateUrlLiteralPreservedTest(claim, opts);
    case "tsc-clean":
      return generateTscCleanTest(claim, opts);
    case "module-export-stable":
      return generateModuleExportStableTest(claim, opts);
    case "react-route-registered":
      return generateReactRouteRegisteredTest(claim, opts);
    case "webhook-handler-exists":
      return generateWebhookHandlerExistsTest(claim, opts);
    case "import-path-resolves":
      return generateImportPathResolvesTest(claim, opts);
    case "changed-literal-preserved":
      return generateChangedLiteralPreservedTest(claim, opts);
    case "form-submit-error-handling":
      return generateFormSubmitErrorHandlingTest(claim, opts);
    case "page-renders":
      return generatePageRendersTest(claim, opts);
    case "validation-rejects-bad":
      return generateValidationRejectsBadTest(claim, opts);
    case "happy-path-with-side-effect":
      return generateHappyPathWithSideEffectTest(claim, opts);
    case "journey":
      return generateJourneyTest(claim, opts);
  }
  // Exhaustiveness guard — if a new Claim variant is added without a
  // case here, TS will fail to compile this assignment with a clear
  // "Type X is not assignable to type 'never'" error. Catches the
  // class of bug where a new template silently returns undefined.
  const _exhaustive: never = claim;
  return _exhaustive;
}
