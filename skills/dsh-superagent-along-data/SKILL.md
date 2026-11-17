---
name: dsh-superagent-along-data
description: Analyze goal-specific data needs, recommend only registered sources, wait on verified capability, and use restricted fresh source reads without exposing private data.
---

Read `along_data_sources_catalog` and the goal's real purpose. Recommend only relevant supported provider IDs through `along_data_sources_recommend`, using current goal revision/input_version in an authorized direct user conversation. An empty list withdraws recommendations. Do not recommend every source for every goal, invent provider URLs, or describe an unsupported upload/OAuth/API flow. Host/native validated connection state, not your explanation, establishes authorization and capabilities.

Recommendation, a settings link, credential entry, verified ready capability and a fresh usable data observation are distinct facts. Current source_ready/source_updated events contain metadata only and can unlock an owned dependency. Use only registered conditions; a later disconnect/revoke/generation invalidates old results. Do not claim a provider is ready from a chat assertion, opening settings, an old event or an unavailable tool. Health remains authorized summary access through `along_health_read`, not raw sample access.

A Host-dispatched private-data task first calls `along_task_context`; then request `along_source_read` with {provider:"okx",capability:"trading_account_summary",max_age_seconds:1800} (60..86400; choose freshness justified by the analysis). Identity, goal, task, revision, input version and occurrence are Host-bound, never selected by you. This requests verified cached data; it does not itself perform an account network refresh or promise all trading history exists. Read the returned shape and coverage before claiming it can answer strategy-performance questions.

Only state:ready exposes scoped data with observed_at/reference/generation/revision. Pending/stale/unavailable is a durable recoverable request: retain waiting state and end this attempt honestly for Host retry; do not repeatedly poll, invent zero, fabricate a tool receipt or finish calculation. Denied/invalidated means this request cannot authorize a read; follow current source/task/input context instead of reviving a former generation. New user input or revoked authorization can supersede work even after a previous valid read.

For calculations derive named quantities from actual returned fields, record units/coverage/observation time/source reference and distinguish supplied assumptions; the calculator proves arithmetic, not source truth or completeness. Missing required fields block that dependent result. Other independent steps or a public methodology explanation may still proceed. Never infer a realized return from account balance alone or take write/trading actions from a read-only goal.

Private summaries belong only in this bound private tool context and supported task result. Never append raw data to general events, chat, memories, logs, public searches or notifications. Search queries may use minimal public concepts such as instrument mechanics with no private balance, identifiers, health text, account history or credentials. API keys/signatures/secrets never enter model input; use the App's actual implemented connection flow if user action is necessary.

For pending/stale/unavailable private reads, do not call along_task_finish or use outcome ask: record orchestrator_report state:progress with the concrete waiting reason and end the turn for Host retry of this occurrence. There is no report state named waiting. A genuinely essential missing user answer can instead use the supported task_finish outcome ask to persist waiting(user_input); that is not an automatic success.


When using private values in `along_calculate`, retain this ready read's actual request_id as source_request_id and provide quantity_sources literal data paths for every private quantity. Values, units, observation window and coverage must match the actual data; a scalar alone is not proof of its meaning. Read the calculation skill for supported constants and current schema. Host may reject a stale read again at task finish; do not recover by removing source bindings.

For a known source dependency, persist trigger.kind:event with its registered source_ready/health_available condition, even while disconnected. Do not use an unconditioned waiting:capability_available because the calculator/research executor already exists; that wait concerns an actually missing executor, not source data. The Host evaluates already-ready conditions for new tasks.
