---
name: dsh-superagent-along-calculation
description: Execute an Along task requiring arithmetic with the registered deterministic calculation tool, preserve its inputs and units, and deliver the host-bound result rather than a model-computed answer.
---

Use this skill when the next authorized step needs a numerical result: budget or goal progress, required contribution, proportions, duration or an explicit compatible unit conversion. Read the current goal/task and original input first. Establish a concrete calculation task in the existing goal if necessary. Do not turn a calculation that can be performed now into a future reminder to calculate.

Use the `along_calculate` tool only when available. The host binds identity, task, execution and current versions; a tool description/example is never authorization. If the tool is unavailable, explain that limitation or wait for it rather than claiming a computation happened. Never calculate by creating files, executing arbitrary code, reading private paths or fabricating a tool receipt.

Supply finite decimal **strings**, named quantities and ordered steps. Step inputs refer only to existing quantity names or earlier step ids. Supported operations are add, subtract, multiply, divide, min, max, ceil, floor, round and explicit convert. No executable expression is accepted. Set `result_step` to a step id, not an original input. State assumptions and the actual sources of input data: arithmetic proves a result from the submitted inputs, not that those inputs describe the person's account or health. Missing essential data is a dependency to resolve, not permission to invent zero.

Keep units explicit and consistent. CNY and USD cannot be added or converted without an independently supplied, authorized exchange calculation. Calendar months/years cannot be silently converted to days. Day/week are elapsed durations, not a way to schedule tomorrow's local clock across DST; use the host's schedule contract for reminders. Multiplication/division can produce canonical units, so use a final `convert` when the user needs hours rather than seconds. Ceil/floor/round operate in that step's displayed unit; convert first if a different rounding unit is intended. Results preserve an exact fraction plus a rounded display value; do not conceal rounding or missing assumptions.

Synthetic arithmetic example, **not** actual user data or tool envelope:
```json
{"quantities":[{"name":"target","value":"60000","unit":"CNY"},{"name":"saved","value":"10000","unit":"CNY"},{"name":"monthly","value":"2500","unit":"CNY/month"}],"steps":[{"id":"remaining","op":"subtract","inputs":["target","saved"]},{"id":"months","op":"divide","inputs":["remaining","monthly"]},{"id":"whole_months","op":"ceil","inputs":["months"]}],"result_step":"whole_months"}
```
This returns twenty calendar months under the supplied constant-surplus assumption. Replace every quantity with current authorized evidence; read the registered tool's full envelope for task/version fields. Do not copy sample identities or amounts.

A successful tool call saves a receipt. Read its actual result, then use the registered result delivery path to persist it in the same task before reporting completion. Preserve the receipt id and input/units in the result; do not substitute a number computed in prose. Repeating an identical input in the same business execution reuses its receipt; corrected inputs are permitted and must be clearly distinguished. A model retry is not another user-task execution.

Arithmetic alone does not complete a physical activity, booking, payment or transfer. Do not close such a task because its preparation was calculated. A calculation task may finish only through the host's validated task/result contract. Background computations and execution logs remain out of the person's chat. Direct user conversations can receive a direct answer; useful background results belong in the corresponding task detail and its existing notification channel.


For an actual dispatched calculation call `along_task_context` first, then `along_calculate` with the strict envelope `{calculation:{quantities,steps,result_step,display_places?}}`. Keep the Host-returned `receipt_id`; finish through `along_task_finish` with `calculation_receipt:receipt_id`, outcome keep unless a real ChangeSet applied, relevant types (usually []), and an honest reason. Only persisted:true is a task receipt. A direct current user question can return persisted:false preview without a task; that is not a task execution. Repeated identical payload in one occurrence reuses its receipt; a corrected input can produce another receipt, while execution count remains per occurrence. Never choose another task/identity/revision or pass a made-up receipt.

Private-data inputs require `dsh-superagent-along-data` and a current ready `along_source_read` result. Explain the source observation/reference and supported coverage separately from mathematical exactness. Missing or stale source fields remain waiting/unknown, never a fabricated zero.
