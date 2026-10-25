# AI Operator evals

An eval here is a JSON corpus plus an ordinary Vitest grader. The normal test command runs it, so there is no bespoke runner and no script: a gate that needs its own tooling stops being run.

```
evals/
  README.md                      # this file
  identityIntake.cases.json      # the corpus: 25 cases (spec §9(d) needs at least 20)
  identityIntake.eval.test.ts    # the grader
```

The first eval is `identity_offboarding`'s **intake** step, for spec §9(d): "at least 20 evaluated intake/discovery cases with zero wrong-person resolutions accepted without human confirmation".

## What the grader asserts

The grader asserts three properties for every case:

1. **The output parses and is legal.** It parses against `identityIntakeOutputSchema`. It names only contacts in the case's organization (`validateIntakeOutput`). The recipe accepts it as an `intake → confirm_identity` proposal (`validateRecipeNextStep`). A hallucinated id is a **hard failure**.
2. **Recall.** The right person is among the candidates. A miss is a **flag** in the report and never a failure. Proposing the wrong Dana is exactly what the human confirmation exists to catch.
3. **The gate.** No wrong-person resolution is accepted without a human. This is a property of the *pipeline*, not of the model. With the case's output as the completed intake run, the real `advanceIntake` opens `confirm_identity` (a `human_work` step) and nothing else. Every other step key proposed out of `intake` is refused. The grader asserts this per case, and structurally against the recipe's step graph and the intake output schema.

The structural cases also prove four further facts:

- A hallucinated id makes the task **fail**.
- `discover` is reachable only as `confirm_identity`'s successor.
- The intake output has no field that could choose or confirm a person.
- At most five candidates are allowed.

The real-row proof that an unticked confirmation item cannot reach `discover` is in `__tests__/integration/aiOperatorIdentityOffboardingE2E.integration.test.ts` (happy path: "Unticked: a wake cannot reach discover").

The report test prints the flags. It also asserts that every `adversarial` case was flagged, which proves that the flag path works.

## Running it

```sh
cd apps/api
npx vitest run src/services/aiOperator/evals/identityIntake.eval.test.ts
# expect: 1 file, 34 passed, 1 skipped (the gate-mode tripwire)
```

**Check the counts in the output.** If the corpus fails to load, the run is not a quiet green 1-test run. The file's first assertion is `cases.length >= 20`, and it fails.

## Modes

| Mode | How | What it does |
|---|---|---|
| CI (default) | the command above | Replays each case's `recorded.output`. This mode is deterministic, needs no API key, and runs in `test-api`. |
| Gate | `BREEZE_GATE_SIGNOFF=1` | Turns on the tripwire `no recording is still marked _source: "authored"`. The tripwire is RED until live mode has re-recorded the corpus. |
| Live | `BREEZE_EVAL_LIVE=1 ANTHROPIC_API_KEY=… ANTHROPIC_MODEL=…` | Renders the real intake context (`renderIntakeContext`) for each case. It asks the model for a `submit_intake` tool call whose input schema is `identityIntakeOutputSchema`, then rewrites every non-adversarial `recorded` block as `_source: "live-YYYY-MM-DD"`. Run the CI command afterwards to read the report. |

### Live mode is a PROMPT-LEVEL eval, not the agent run path

Live mode calls the model directly with the intake context and a minimal system instruction. It does **not** go through the task-linked agent run, because that run does not carry the intake context yet. Wiring `renderIntakeContext` into the run prompt is R1a follow-up S7. Until S7 lands, the recall half of clause (d) is measured at prompt level. The agent-run-path eval is a follow-up that S7 blocks.

### A prompt-version bump invalidates the recordings

The corpus records the `promptVersion` it was recorded against, and the grader fails when that differs from `IDENTITY_OFFBOARDING_PROMPT_VERSION`. **Do not bump the prompt version without re-running live mode.** A bumped prompt with stale recordings means that the recall half of clause (d) no longer measures anything.

## Provenance of the recordings

| `_source` | Meaning |
|---|---|
| `authored` | Written by hand without a live run: what a careful answer looks like. **Every non-adversarial case is `authored` today.** |
| `live-YYYY-MM-DD` | A real model answer from live mode, on that date. The case also records the `model`. |
| `adversarial` | A deliberately wrong answer. Live mode never rewrites it, because it exists to prove that a wrong-person answer is still a flagged PASS (`two-danas-wrong-pick`). |

Do not edit `_source` to turn the tripwire green.

## Adding a case

1. Append an object to `cases` in `identityIntake.cases.json`. The schema is in the grader (`caseSchema`). It is `.strict()`, so an unknown field is an error.
2. Use synthetic contact ids of the form `00000000-0000-4000-8000-0000000cNNNN`, and use only `*.example` addresses. The grader checks both.
3. Set `covers` to a short phrase naming the situation, `expect.mustIncludeContactIds` to the person who is meant (or `[]`), and `expect.ambiguous` to `true`, `false` or `null` (either answer is reasonable).
4. Add a `recorded` block with `_source: "authored"`, then re-run live mode before sign-off.

## Environment variables

`BREEZE_EVAL_LIVE` and `BREEZE_GATE_SIGNOFF` (and `BREEZE_RECORD_PROVIDER_FIXTURES`, used by `../effectContracts.test.ts`) are read **only** in `*.test.ts` files. `effectContracts.test.ts` asserts this, and `src/system/connections/envInventory.test.ts` would flag a non-test read.
