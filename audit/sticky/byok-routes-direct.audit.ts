// FEATURE: BYOK (Bring-Your-Own-Key) routes PR-body extraction
//   through the customer's Anthropic/OpenAI key instead of pinnedai's
//   hosted Worker — for compliance / cost-control.
// SIGNAL: when PINNEDAI_BYOK is set to "anthropic" or "openai" AND
//   the matching PINNEDAI_<PROVIDER>_KEY is present, activeByokProvider()
//   returns the provider name and the direct-call code path is taken.
//   When PINNEDAI_BYOK is unset OR malformed OR the key env var is
//   missing, activeByokProvider returns null and BYOK is inert.
// FALSIFIABILITY: catches a regression where BYOK gets auto-activated
//   without the explicit PINNEDAI_BYOK opt-in (which would silently
//   route PR descriptions through the customer's key without consent)
//   OR where a legitimate opt-in gets silently ignored.

import { describe, it, expect, beforeEach } from "vitest";
import { activeByokProvider } from "../../apps/cli/src/llmDirect.js";

describe("FEATURE-AUDIT: BYOK opt-in is explicit (no auto-discovery)", () => {
  beforeEach(() => {
    // Reset env between tests so prior values don't bleed
    delete process.env.PINNEDAI_BYOK;
    delete process.env.PINNEDAI_ANTHROPIC_KEY;
    delete process.env.PINNEDAI_OPENAI_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("POSITIVE CONTROL: PINNEDAI_BYOK='anthropic' → activeByokProvider returns 'anthropic'", () => {
    process.env.PINNEDAI_BYOK = "anthropic";
    expect(activeByokProvider()).toBe("anthropic");
  });

  it("POSITIVE CONTROL: PINNEDAI_BYOK='openai' (case-insensitive) → returns 'openai'", () => {
    process.env.PINNEDAI_BYOK = "OpenAI";
    expect(activeByokProvider()).toBe("openai");
  });

  it("NEGATIVE CONTROL: PINNEDAI_BYOK unset → returns null (no BYOK)", () => {
    expect(activeByokProvider()).toBeNull();
  });

  it("NEGATIVE CONTROL: PINNEDAI_BYOK='off' / 'true' / 'yes' / typo → returns null (only 'anthropic' or 'openai' accepted)", () => {
    for (const bad of ["off", "true", "yes", "1", "anth", "OPENAII", ""]) {
      process.env.PINNEDAI_BYOK = bad;
      expect(activeByokProvider()).toBeNull();
    }
  });

  it("FALSIFIABILITY: bare ANTHROPIC_API_KEY does NOT trigger BYOK without PINNEDAI_BYOK opt-in", () => {
    // This is the critical anti-surprise behavior: customers with an
    // existing Anthropic key in their CI for unrelated reasons must NOT
    // have pinnedai silently route PR descriptions through it.
    process.env.ANTHROPIC_API_KEY = "sk-ant-...";
    process.env.OPENAI_API_KEY = "sk-...";
    expect(activeByokProvider()).toBeNull();
  });

  it("FALSIFIABILITY: PINNEDAI_ANTHROPIC_KEY alone (without PINNEDAI_BYOK) does NOT trigger BYOK", () => {
    // Even the prefixed key alone shouldn't trigger BYOK — both the
    // opt-in flag AND the key must be set.
    process.env.PINNEDAI_ANTHROPIC_KEY = "sk-ant-...";
    expect(activeByokProvider()).toBeNull();
  });
});
