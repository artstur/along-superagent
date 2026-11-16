# Explicit weekly task completion

Classification: agent. Dependency: PR #8, current main 32f21afad182f7084d2a38ecdfb3e9fa0b8e5d16.

## Goal and acceptance

When a new human event explicitly asks to add a weekly cadence to its original bound task, Worker ready means that same task actually has the requested persistent cadence and civil clock. The sourced conditional recommendation may be delivered before or after the task update. Ordinary research, existing due reviews, negative/one-off requests and unrelated tasks do not gain a requirement to change reminders.

## Observed boundary

The fixed runtime's actual new request included the updated task skill and strict nested parameter contract. Its lead Worker read the target's once plan, did not call ChangeSet, truthfully disclosed that weekly was unresolved, yet reported ready. New sleep jobs were created during this event; the observed job output was not stale output from an older event. The delegated worker also made no registered ChangeSet call: its diagnostic script used a temporary older package. This is not evidence that the new live validator rejected a valid update.

## Minimal design

Use an Along-only completion assertion at the existing report hook, alongside existing health review assertions. For ready only, inspect the current host-bound human event, owned bound goal/task, exact imperative add-weekly command with a concrete weekday and HH:mm, and its action shared with the task. Reuse supportsRecurrence for the exact quoted command, action, weekday and negative/hypothetical/one-off protections. This check grants no write authority and does not choose a time.

The request action is bound to existing revision history before the current host message’s own edits, rather than mutable current task wording; this avoids a content/status change hiding the expectation. For a recognized request, inspect the real scheduled weekly plan, recurrence mandate, weekday, timezone, clock and future next occurrence. Refuse ready with concrete expected/actual fields if unfinished, leaving every business row unchanged. Progress, failed, blocked and dropped reports remain available. Recommendation delivery remains independent; a partial card cannot by itself satisfy the separate explicit task-update request. No Engine/Router changes, scheduler, automatic commits, new goals or technical messages in personal chat.

## Verification

First reproduce the real read-once → partial reply → ready failure through registered tools. Then cover the valid original task update before/after recommendation, duplicate reports/restart, unchanged unrelated tasks, current-event identity/scope, existing valid weekly plan, wrong clock/day/zone/past time, and negative/one-off/narrative commands. Run pnpm check and independent fixed-snapshot review. Release owner verifies a normal same-goal/task feedback on the final fixed source; require actual request/header contract evidence and persistent weekly/civil-time plus the sourced card, not package SHA or Worker ready alone.

WorkLink has no dispatch-time task snapshot. The existing task_revision history supplies content and scheduled_at from before this message’s own edits. Only when the original message explicitly says to keep the next instant unchanged, and that historical instant was still future at receipt, completion additionally requires exactly that instant. A past historical occurrence cannot prove the next clock after scheduler renewal and is not used as an invented snapshot. No migration is added; final release acceptance also compares the actual original next instant. The parser intentionally covers the observed explicit add-weekly HH:mm command and same-zone action; it does not generalize arbitrary weekly narratives or guess cross-zone wording.

A partial card generated while this explicit update is incomplete receives a host-owned historical sentence in canonical summary/nextStep and canonical message text: the weekly arrangement was not yet implemented when that result was generated, and the current task arrangement is authoritative. After a later update the old card remains a truthful historical record. Update-first cards and ordinary recommendations receive no such note. This preserves visibility without restoring untrusted weather prose or adding UI fields.

Notification boundary: a recommendation-first message retains the task revision at its publication. A later task update makes that earlier recommendation_ready notice stale under the existing Host rules; this patch does not reissue it or claim it is currently deliverable. Both operation orders remain legal and the sourced card persists, while the skill recommends necessary task updates before notification. Final release acceptance must use actual current revision matching, not treat the old notice as a pass.

Independent review additionally reproduced an open task whose content and new mandate.action were shortened together, removing part of the requested action while retaining weekly metadata. Completion now checks the original expected quote/action against the current task content as well as validating the persisted mandate, so this does not satisfy ready. A registered ChangeSet regression reproduces that rejected completion.
