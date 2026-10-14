# FORGE

**Self-verifying AI partner onboarding compiler for hospitality integrations.**

Forge takes sample JSON payloads from a new partner (a PMS, channel manager, etc.) and produces a typed `PartnerAdapter` that maps the partner's format to and from Lattice's `CanonicalBooking` model. An LLM proposes the mapping. Deterministic code checks it. The generated adapter makes **no LLM calls at runtime**.

```
samples ──► QuirkDetector ──► LLM ──► MappingSpec (Zod) ──► AdapterCompiler ──► 6-stage verifier
                                ▲                                                    │
                                └──────────── structured diagnostics (≤ 3 attempts) ◄┘
                                                                                     │
                                                         READY_FOR_REVIEW / NEEDS_HUMAN
                                                                                     │
                                                       Review gates ──► export to Lattice
```

---

## How it works

1. **Profile.** [`QuirkDetector`](libs/inference/src/quirk-detector.ts) walks every training sample and classifies each JSON path, for example `INTEGER_CENTS`, `EPOCH_SECONDS`, `YMD_OBJECT` or `ENUM_CANDIDATE`. Paths that match sensitive patterns (`pin|password|secret|token|card|cvv|ssn`) are flagged and their values withheld from the profile.
2. **Propose.** [`PromptBuilder`](libs/repair-loop/src/prompt-builder.ts) sends the profiles and the redacted samples to the LLM. Partner data is wrapped in `<untrusted_partner_data>`. The model must return a [`MappingSpec`](libs/mapping-spec/src/schema.ts): JSON that names, for each field, a source path and a declarative transform. It does not return code.
3. **Validate and score.** The JSON is parsed with Zod. The model's own `confidence` values are discarded and recomputed by [`ConfidenceScorer`](libs/inference/src/confidence-scorer.ts), which checks how often each transform succeeds across the samples.
4. **Compile.** [`AdapterCompiler`](libs/codegen/src/adapter-compiler.ts) emits a Prettier-formatted `*.adapter.ts`, `*.schema.ts` and `*.adapter.spec.ts`. The spec is embedded as a constant and run through the audited transform library [`@lattice/mapping-spec`](libs/mapping-spec/src/transforms.ts).
5. **Verify.** [`VerificationPipeline`](libs/verify/src/pipeline.ts) runs the six stages below. It stops at the first failure.
6. **Repair.** If a stage fails, the [`OnboardingOrchestrator`](libs/repair-loop/src/orchestrator.ts) sends the structured diagnostics back to the LLM, up to **3 attempts** in total. When held-out stages fail, the expected values are masked so ground truth never reaches the prompt.
7. **Review and export.** Once a human approves the run, it is exported subject to the confidence, escape-hatch and verification gates.

### Verification stages

| # | Stage | Implementation | What it catches |
|---|---|---|---|
| 1 | `TYPECHECK` | [stage1-typecheck.ts](libs/verify/src/stage1-typecheck.ts) | Strict in-memory `tsc` against stubbed `@lattice/*` contracts; class must `implements PartnerAdapter` |
| 2 | `AST_SCAN` | [stage2-ast-scan.ts](libs/verify/src/stage2-ast-scan.ts) | Imports outside the allowlist; banned identifiers (`fetch`, `process`, `eval`, `Function`, `require`, timers, …) |
| 3 | `GOLDEN` | [functional-verifiers.ts](libs/verify/src/functional-verifiers.ts) | Field-by-field mismatch against human-verified expected output on training samples |
| 4 | `HELD_OUT` | same | Same check on samples the LLM never saw (generalization) |
| 5 | `PROPERTY` | same | 200 `fast-check` runs of `toCanonical(fromCanonical(x)) === x`, plus survival of unmapped fields in `unmappedMetadata` |
| 6 | `WEBHOOK` | same | Valid test vector must pass, a wrong secret must **fail**, and `extractEventId` must match |

Stages 3–6 run the adapter through [`SandboxRunner`](libs/sandbox/src/sandbox-runner.ts). See the [threat model](docs/threat-model.md) for what the sandbox does and does not guarantee.

### Review gates

| Gate | CLI `export` | API `POST /runs/:id/approve` |
|---|---|---|
| Every field `confidence >= 0.85` | ✅ (bypass with `--force`) | ✅ |
| `custom` escape hatch acknowledged | ❌ | ✅ (`acknowledgeEscapeHatches: true`) |
| All 6 verification stages pass | ❌ | ✅ |

---

## Repository layout

```
apps/
  cli/        forge CLI (onboard | verify | export)
  api/        NestJS RunsController: get run, override field, simulate, approve
  studio/     Review Studio UI (Next.js App Router page, currently static mock data)
libs/         all importable as @lattice/<name>
  canonical/      CanonicalBooking, CanonicalEnvelope, computeCanonicalHash
  adapters/       PartnerAdapter interface + capabilities / PushContext
  mapping-spec/   Zod MappingSpec schema + deterministic transform runtime
  inference/      QuirkDetector, ConfidenceScorer
  llm/            LlmProvider interface + OpenAI-compatible provider + cost table
  codegen/        AdapterCompiler (MappingSpec → TypeScript bundle)
  sandbox/        SandboxRunner (node:vm execution of generated adapters)
  verify/         6-stage VerificationPipeline
  repair-loop/    OnboardingOrchestrator, PromptBuilder
eval/
  suites/         AccuracyEvaluator: field accuracy vs. a reference spec, markdown report
  mutations/      MutationTestingSuite: 8 injected faults, each expected at a specific stage
fixtures/
  cloudbeds/      Reference MappingSpec for the Cloudbeds mock
prisma/           Postgres schema: OnboardingRun, Sample, SpecVersion, Attempt, EvalResult
docs/
  adr/            Architecture Decision Records
  threat-model.md
```

---

## Getting started

**Requirements:** Node ≥ 20, pnpm ≥ 9, PostgreSQL. Postgres is only needed for the API.

```powershell
pnpm install
Copy-Item .env.example .env        # then edit DATABASE_URL
pnpm db:generate
pnpm db:migrate                    # API only
```

### Environment variables

| Variable | Used by | Default |
|---|---|---|
| `DATABASE_URL` | Prisma / API | — |
| `OPENAI_API_KEY` | `OpenAiCompatibleProvider` | `''` |
| `OPENAI_BASE_URL` | `OpenAiCompatibleProvider` | `https://api.openai.com/v1` |
| `FORGE_LLM_MODEL` | `OpenAiCompatibleProvider` | `gpt-4o` |

Any OpenAI-compatible endpoint works if it supports `response_format: json_object`.

### CLI

```powershell
# Full LLM onboarding run. Writes to ./generated/<provider>/
pnpm forge onboard --provider cloudbeds --fixtures path/to/fixtures.json [--docs docs.md] [--vector vector.json]

# Compile + verify an existing spec (no LLM). Exit code 1 on failure.
pnpm forge verify --spec generated/cloudbeds/cloudbeds.mapping.json --fixtures fixtures.json --vector vector.json

# Export into a Lattice checkout at <target>/libs/adapters/src/generated/<provider>/
pnpm forge export --spec generated/cloudbeds/cloudbeds.mapping.json --target ../lattice [--force]
```

The fixtures file is a JSON array of [`GoldenFixture`](libs/verify/src/types.ts) objects. Entries with `isHeldOut: true` are kept away from the LLM and used only in stage 4.

### Tests

```powershell
pnpm test
```

Unit and property tests live next to the code (`*.spec.ts`): transforms, compiler, pipeline, orchestrator and the mutation suite. Jest resolves `@lattice/*` to `libs/*/src` via [jest.config.js](jest.config.js).

---

## Current status and known gaps

Forge is a working core pipeline wrapped in partially-built apps. Be aware of the following before relying on it:

- **Apps are not runnable packages yet.** `apps/api` has a controller but no Nest module or bootstrap. `apps/studio` has no Next.js/React setup. Its page renders hardcoded data and does not call the API. No app has its own `package.json`.
- **`forge eval` is listed in the CLI usage text but not implemented.** It falls through to the usage message and exits with code 1.
- **`custom` transforms cannot execute.** The schema accepts them and the scorer caps them at 0.50, but `applyTransform` throws for `kind: 'custom'`, so any spec that uses one fails at `GOLDEN`. See [ADR 0001](docs/adr/0001-declarative-mapping-spec-over-raw-code-generation.md).
- **`PATCH /runs/:id/spec/fields/:field` does not re-verify.** Its docstring says it re-runs the 6-stage verifier, but it only saves a new `SpecVersion` and recompiles. Verification happens later, at `approve`.
- **Generated artifacts are minimal.** `listChangedSince` returns an empty page. `*.schema.ts` is a passthrough `z.object({})`. `*.adapter.spec.ts` only asserts the provider name.
- **Transform caveats.** `isoDate.timezone` is ignored. A body-sourced webhook timestamp is treated as epoch seconds whenever it is numeric, regardless of `format`.
- **`Attempt` has no `costUsd` column**, although the orchestrator tracks per-attempt cost.
- **Security gaps** around the sandbox and redaction are tracked in the [threat model](docs/threat-model.md#known-gaps).

## Further reading

- [ADR 0001 — Declarative MappingSpec over raw LLM code generation](docs/adr/0001-declarative-mapping-spec-over-raw-code-generation.md)
- [Security & threat model](docs/threat-model.md)