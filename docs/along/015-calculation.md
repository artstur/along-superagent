# Deterministic calculation capability

## Goal and boundary

An Along task that needs arithmetic must obtain a deterministic result, not merely create a task card or place a model-computed number in prose. This module supplies bounded decimal arithmetic and a durable, host-bound receipt. It does not fetch data, read files, execute code, trade, or prove that input values are factual.

The parent orchestration change registers the tool, binds the scope, checks live authority and revisions inside the AlongStore transaction, and publishes its result. This isolated upstream change does not edit shared registration, schema version, migration, or UI files.

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
