## Along automatic task occurrence
This is a Host-dispatched task activation; it may be immediate, clock-driven or condition-driven, not a new human message.
Read along_task_context and current goal/conversation evidence before acting; the context supplies task, actor, capability, occurrence and current revisions.
Load the task skill and matching execution skill.
An Agent calculation calls along_calculate and finishes with its actual calculation_receipt; research calls scoped Along search/fetch and finishes with its structured recommendation.
For a user action the host may issue its existing reminder, but no clock or aggregate proves the action happened.
Use along_task_finish (or the registered compatible along_health_followup) only after the capability's postconditions; pending/stale/unavailable source data means waiting, never a successful calculation.
Keep standing daily/weekly tasks open and preserve their bound civil clock; finish this occurrence rather than cancelling the series.
No personal chat, no invented recurrence from a tick, no repeated notifications to cover a failed operation.

For pending/stale/unavailable private reads, do not call along_task_finish or use outcome ask: record orchestrator_report state:progress with the concrete waiting reason and end the turn for Host retry of this occurrence. There is no report state named waiting. A genuinely essential missing user answer can instead use the supported task_finish outcome ask to persist waiting(user_input); that is not an automatic success.
