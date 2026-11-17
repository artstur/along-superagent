# Deterministic calculation capability

## Goal and boundary

An Along task that needs arithmetic must obtain a deterministic result, not merely create a task card or place a model-computed number in prose. This module supplies bounded decimal arithmetic and a durable, host-bound receipt. It does not fetch data, read files, execute code, trade, or prove that input values are factual.

The parent orchestration change registers the tool, binds the scope, checks live authority and revisions inside the AlongStore transaction, and publishes its result. This isolated upstream change does not edit shared registration, schema version, migration, or UI files.

The integrated private-data wrapper is `calculation-evidence.ts`. Source-dependent calculations supply the actual `source_request_id` and `quantity_sources:[{quantity,path}]`; the Host checks a fresh authorized read for this occurrence, safe field paths, exact decimal values and field units, then rechecks before publication. The registered OKX summary's `tradingEquityUsd` is USD and its two counts are count; metadata readiness alone grants neither input values nor currency conversion. Every quantity has one explicit provenance class; there are no literal 0/1/100 exemptions. Non-source quantities use a registered named dimensionless constant or a supported current direct user parameter. Unsupported input coverage remains waiting, never a fabricated zero. Bindings persist privately in `task_calculation_source` (migration11), outside chat and sync.

## Input and output

`CalculationInputSchema` accepts named decimal quantities and an ordered list of arithmetic steps. Steps may reference only earlier quantities/steps. Supported operations are add, subtract, multiply, divide, min, max, ceil, floor, round and explicit unit conversion. No expression string, executable code, filesystem path or URL is accepted.

Values are finite decimal strings. BigInt rational arithmetic preserves exact fractions; the receipt includes exact numerator/denominator, a rounded display value, unit and the complete normalized trace. Rounding is half away from zero. Ceil/floor/round operate in the quantity's displayed unit. Unit conversion is dimensional: compatible time/length/mass units can convert, but currencies cannot silently convert and calendar months/years cannot silently convert to days. Day/week are elapsed 24-hour/7-day durations, not civil-calendar scheduling; use the host's timezone-aware schedule contract for reminders or dates across DST.

Input/step counts, decimal digits, precision, unit complexity, exponents and intermediate rational size are bounded. Division by zero, unknown references, duplicate names, incompatible units, NaN/Infinity and excessive work are rejected without a receipt.

## Host-owned persistence contract

`CalculationStore` accepts the shared `DatabaseSync`; `CALCULATION_SCHEMA` is included by the integration owner's versioned migration. `calculate(scope, input)` computes and persists the receipt. Its scope is never a model argument: user, goal, task, task revision/content, input version, ticket and execution key are supplied by the host.

The host must atomically check active ownership, current goal/input/task revisions, task state and source scope immediately before calling. Scope validation remains the host's job, not a claim made by arithmetic. The receipt id hashes bound identity, execution key and normalized input; exact retries reuse the receipt. A corrected input in the same execution is allowed and produces a different receipt. Product execution history groups receipts by the host execution key, so a retry or two calculations in one business execution are not counted as two task executions.

Receipts retain execution-time task content and revision. Changing a task later does not rewrite old math or convert a calculation into evidence that the person completed a physical activity. Calculating alone never marks a task done, proves a notification was delivered, or changes another task.

## Acceptance

- Exact decimal and ratio examples, including budget target minus savings divided by monthly surplus.
- Explicit conversion and dimension checking; no implicit FX or month/day approximation.
- Negative rounding, fractional precision, divide-by-zero, malformed quantities, bad references and bounded overflow.
- Restart-stable idempotency, corrected input in one execution, and scope-separated receipt identities.
- Integration tests separately verify host revision/authority rejection, task result publication, counted execution and real isolated model tool use.

All tests in this change use synthetic values and isolated SQLite. No production goal, pairing or notification is modified.


## Mixed private facts and explicit parameters (evidence v1)

`QUANTITY_SOURCES` maps at least one quantity to a real fresh authorized private read. The current registered OKX summary permits only top-level `tradingEquityUsd` (USD), `assetCount` and `positionCount` (nonnegative safe-integer count). Generic paths or a model-authored `data.unit` cannot establish arbitrary new fields or units. Source decimals are compared without rounding a near match into equality.

`QUANTITY_PARAMETERS` is an optional separate array. Every quantity must occur exactly once in either source bindings or parameter bindings:

- `{quantity,kind:"constant",name}` selects a closed registry, with exact value and unit `1`: `percent_base`=100, `months_per_year`=12, `days_per_week`=7, `hours_per_day`=24, `minutes_per_hour`=60, `seconds_per_minute`=60, `identity_one`=1, `zero`=0. These are named arithmetic constants, not calendar scheduling promises or unit conversions.
- `{quantity,kind:"user",event_id,quote}` cites the **latest accepted direct inbound user message linked to this goal**. Host-bound identity, active task/current input version and fresh read are still required. Quote must be an exact substring containing the matching Arabic decimal literal (thousands separators allowed) and a supported explicit unit. Currency/time/count and simple per-period forms are checked conservatively; unqualified dimensionless parameters require explicit `倍`/`无量纲`/`dimensionless` wording. Chinese spelled-out numerals, implicit units, arbitrary composite notation and old historical facts are not inferred. A later correction/withdrawal invalidates the old input; a fresh task cannot revive an older parameter event just by quoting its number.

This layer proves that a number/unit came from the indicated private field, named standard or explicit current user wording. It does not prove the user statement true, that a quoted target is semantically the right quantity, or that the model selected the right formula. A user parameter must be labeled as such, never described as an account observation. The minimum one private-field requirement prevents using a metadata-ready account as a pretext for a completely model-authored computation. Direct questions or calculations from user inputs alone belong to the separate conversation-preview capability, not this private-input wrapper.

`verify(scope,requestId,quantity_sources,quantities,quantity_parameters=[])` returns `VerifiedCalculationEvidence`:

```ts
{
  version: 1,
  read: {request_id,provider,capability,generation,revision,reference,observed_at},
  sources: [{quantity,path,value,unit}],
  parameters: [
    {quantity,kind:"constant",name,value,unit},
    {quantity,kind:"user",event_id,quote,value,unit}
  ]
}
```

`record(receiptId,requestId,evidence)` revalidates the receipt's actual scope/quantities, then stores this object in the existing private `bindings` JSON column. No global migration changes. `assertCurrent` repeats current source/read/field/parameter checks before publication. Legacy source-only arrays are accepted for revalidation only when every quantity has an explicit registered source; former literal exemptions are not grandfathered in. Evidence is never appended to general events, chat, sync or notification payloads by this module; consumers should expose only honest provenance labels, not broadcast private excerpts.

Exact repeated parameters/input in one occurrence reuse their arithmetic receipt and evidence row. Changed quantity values/names produce distinct receipt IDs through the existing calculator's normalized-input digest. Rebinding one receipt to a different source/parameter proof is rejected rather than overwriting its history. When two same-valued parameters represent different concepts, use their distinct meaningful quantity names. A same-generation/revision/reference cache refresh may restore freshness without rewriting the first observation time in the original private proof; current values and authority are always rechecked. A changed source stamp, task revision, input or authorization cannot validate an old result.

Dedicated regression uses synthetic goals and source responses: `(1000 USD user target - 125.2 USD actual private equity) / 12 month user horizon = 72.9 USD/month`, plus explicit standard constants, unsupported units/paths, cross-goal/private-scope refusal, nonfinite/precision limits, current user evidence, repeat/correction idempotence and stale/revoked/cancelled publication refusal. These are real SQLite/calculator/source-store operations, not a real financial account, model run or device notification. Actual tool registration and receipt-to-result publication are integration-owned; the parameter schema must be wired into the registered tool before a model can use this new contract.
