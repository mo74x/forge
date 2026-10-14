# ADR 0001: Declarative MappingSpec Over Raw LLM Code Generation

- **Status:** Accepted
- **Implemented in:** [`libs/mapping-spec`](../../libs/mapping-spec/src), [`libs/codegen`](../../libs/codegen/src)

## Context
Generating full TypeScript adapter classes directly from an LLM introduces high variance: models invent inconsistent helper functions, mishandle floating-point currency math, and make subtle edits across repair iterations that are difficult for humans to diff.

## Decision
We constrain the LLM's output to a declarative `MappingSpec` JSON schema validated by Zod. A deterministic template compiler (`AdapterCompiler`) translates the `MappingSpec` into TypeScript code referencing an audited runtime transform library (`@lattice/mapping-spec`).

### How the compiler realizes this
`AdapterCompiler` does not generate per-field TypeScript. The generated adapter is a fixed class template that:

- embeds the validated spec as a `MAPPING_SPEC` constant (via `JSON.stringify`);
- implements `toCanonical` / `fromCanonical` as a loop over `MAPPING_SPEC.fields` / `MAPPING_SPEC.reverse`, calling `getByPath`, `applyTransform` and `setByPath` from `@lattice/mapping-spec`;
- emits webhook verification code that is specialized by `webhook.algorithm` (`hmac-sha256`, `hmac-sha1-body`, `none`).

All transform behavior therefore lives in one audited library. The available transforms are `identity`, `isoDate`, `ymdObjectToIso`, `isoToYmdObject`, `centsToDecimal`, `decimalToCents`, `decimalStringToNumber`, `numberToDecimalString`, `uppercase`, `enumMap`, `concat`, `splitIndex` and `custom`.

## Consequences
- **Deterministic Codegen:** The same `MappingSpec` produces the exact same TypeScript code byte-for-byte. This assumes a pinned Prettier version, since output is formatted with `prettier.format`.
- **Human Override Ergonomics:** In the Review Studio, engineers can change a field's transform from a dropdown without editing raw ASTs.
  - *Current state:* the backend exists: `PATCH /runs/:id/spec/fields/:canonicalField` validates the field, sets confidence to 1.0 and saves a `HUMAN` `SpecVersion`. The Studio page is still a static mock with no dropdown or API calls.
- **Controlled Escape Hatch:** Custom expressions (`kind: 'custom'`) are permitted only when declarative transforms cannot express a partner quirk, and automatically block export until reviewed by a human.
  - *Current state:* gating is in place. `ConfidenceScorer` caps `custom` at 0.50, below the 0.85 export threshold. `POST /runs/:id/approve` also requires `acknowledgeEscapeHatches`. **Execution is not**: `applyTransform` throws for `custom`, and the compiler never emits the `code` string. Any spec containing a `custom` field fails at stage 3 (`GOLDEN`). Running custom code safely depends on fixing the sandbox gaps in the [threat model](../threat-model.md#known-gaps) (G2, G3).
- **Smaller attack surface, not zero:** The LLM cannot write arbitrary logic. Spec string values interpolated into templates are escaped with `JSON.stringify` to prevent breakout vulnerabilities (see threat model G1).