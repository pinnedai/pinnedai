# Fixture 16 — socialideagen image-gen Tier 1 smoke (launch validation target)

The real-bug fixture for Tier 1 smoke pins per the build plan. Three variations,
each maps onto a specific historical bug from the socialideagen dogfood
session — bugs that EVERY existing detector missed because they were
greenfield + first-time bugs with no regression baseline.

The validation criterion (per `[[pinned-proof-page-launch-deliverable]]`):
each variation must produce a smoke pin that goes **RED** at `parent/` (the
buggy commit) and **GREEN** at `fixed/` (the fix commit). If all three pass,
the Tier 1 smoke feature is proven against a real bug, not a demo.

## Variation 1 — broken-status-string-mismatch

**The bug:** Client polls `if (job.status === "done")`. Worker writes
`status: "completed"`. Every poll returns null/empty — silent failure for days.

**The detection:** `reaches-terminal-state` assertion with
`terminalStates: ["completed", "failed"]` polls the status field until
terminal. At `parent/`, status is "done" forever → RED with the message
`"expected terminal state in [completed, failed] within 200000ms via status;
last observed: 'done'"`. At `fixed/`, status reaches "completed" → GREEN.

## Variation 2 — broken-daemon-hang

**The bug:** Worker hangs on `claude -p` call; rows stuck in `status: "processing"`
forever. Client never gets a response.

**The detection:** Same `reaches-terminal-state` assertion with a generous
bound. At `parent/`, status stays "processing" forever → RED with
`last observed: 'processing'`. At `fixed/`, worker completes within bound → GREEN.

## Variation 3 — broken-empty-input-not-rejected

**The bug:** Client submits `{ prompt: "" }`. Server silently runs the
generation pipeline on the empty input, returns empty SVG. No validation.

**The detection:** `rejects` assertion with `withInput: { prompt: "" }`
and `expect: { status: 400, bodyContains: "validation" }`. At `parent/`,
server returns 200 with empty body → RED. At `fixed/`, server returns
400 with "validation: prompt required" → GREEN.

## Running the validation

Each variation includes a `stub.mjs` that spawns the broken (parent) or
fixed server on localhost. The validator script:

1. Starts `stub.mjs` from `parent/`
2. Runs the smoke pin → expect RED with the variation's expected error message
3. Stops the stub
4. Starts `stub.mjs` from `fixed/`
5. Runs the smoke pin → expect GREEN
6. If both expectations hold for all 3 variations, **the Tier 1 smoke feature
   is launch-validated.**

Per the build plan: *"Prove reproduce-red by reverting the literal to 'done'. That's the launch proof."*
