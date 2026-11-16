# Worker schema recovery

Classification: agent. Dependency: merged live research PR #7, main b45cd01ff1fb9c65c28f3601844572db926545af.

## Goal and acceptance

A human request on an existing goal/task can finish a sourced recommendation and, only when explicitly authorized, update the same task to a weekly reminder. Other goals, tasks and reminder times remain intact. A malformed model tool call must produce actionable repair information without any business write, string-to-number coercion, new authority, or new research budget.

## Observed failure and design

The deployed Worker submitted string task revisions, unsupported reminder source values, missing explanation, and malformed nested recommendation fields. The registered tools use Zod JSON Schema; `Sessions.registerTool` currently throws Zod parse errors before Along's business-invalid guidance can run. Verify the actual runtime model-facing schema and loaded skills against these definitions before drawing a model-adapter conclusion.

Keep strict validation and existing notification/evidence behavior. Add narrowly scoped Along schema-recovery responses with precise issue paths/types and complete structural repair guidance, improve existing field descriptions and skill examples, preserve the future-time, timezone, exact-evidence and opt-out guards while correcting reproduced validation/inheritance inconsistencies, and leave Router/Engine and private credentials untouched. Ordinary recommendation delivery needs no reminder rewrite. A weekly change must cite the real authorized cadence and use the original task/revision and chosen civil time; reminder prose alone does not create recurrence.

## Verification

Reproduce the observed malformed argument shapes, assert no execute/business write, and prove a corrected complete call can execute. Check exported nested JSON Schema types and required fields. Test weekly operation against explicit synthetic user evidence while retaining the original task/time and unrelated tasks. Run `pnpm check` (typecheck, tests and build), independent review, then maintain one follow-up PR. Formal runtime/iPhone integration remains the release owner's responsibility.

## Verified root causes and scope

The deployed request/header retained nested integer revisions, required enum source, string recommendation/option titles, and required options. Both research and hiking skills had been loaded. This rules out missing nested schemas or absent skills in that observed run. Strict Zod parsing threw before business-invalid guidance; repeated malformed model calls therefore lacked a complete local repair response.

Two additional synthetic failures reproduced the actual business refusals before fixes: a cadence-only update omitted scheduled_at even though the existing task retained its future clock (validation read only the omitted field, application inherited the task clock); and an explicit imperative “补上每周三…” with matching exact action/quote was rejected because the mandate parser only recognized reminder/arrangement verbs. The fix inherits time only for scheduled plans when the field is undefined, preserving explicit null, future/timezone and opt-out behavior. The grammar addition requires the quoted imperative at a command boundary, matching weekly day/action and original evidence; reported examples, narratives, negative/hypothetical and one-off requests remain rejected. No time or authorization check is bypassed.

## Proving the final Worker loaded this version

Normal runtime restart loads the fixed package's skill bodies once in skill-files. Sessions.decorate creates a new binding even for a restored Worker; its per-request systemPrompt callback reads current prompt config and inserts the current along-task body. The existing runtime needs no hot-update platform or deleted session. An assignment/retry can reuse worker-<ticket>, so assignment creation alone is not proof of a fresh skill body.

After release, send a normal authorized business feedback event on the same goal/task (no technical prompt in personal chat). Inspect only bounded new request/header metadata: its system must contain the new task body including “Strict JSON and recovery” and the complete synthetic task.update example, and its actual tool schemas must contain the new integer/source/title descriptions. Compare the normalized skill body / parameter schema hashes with the immutable published package, excluding private message data. If the model calls skill for research again, compare that new result's content with the package body; old persisted skill results do not prove current loading. Record event/request time, fixed source SHA and hashes privately. If these do not match, do not claim the final Worker used the new contract. Verify the resulting same task really has weekly and the original civil clock, unrelated tasks are unchanged, and its same-goal sourced conditional card is visible. A once plan or package SHA alone is insufficient acceptance.
