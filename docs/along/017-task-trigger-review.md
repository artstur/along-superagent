# Private task-trigger repair review

A trusted maintenance request may ask a new Worker to inspect one existing task against the real user goal and its original accepted conversation evidence. It is not a user utterance, a due clock, a health observation, a task execution or an instruction to change the goal.

The private authenticated bridge accepts `POST /maintenance/task-trigger-reviews` with only `{task_id,evidence_event_id,reason}`. Server-bound identity must match the paired user/device; the task is open under an active owned goal, and the evidence is an accepted direct user message linked to that same goal. Its captured task revision/input version/evidence produce a stable durable review identity. A retry after this review's own applied edit reuses that review; it does not spawn another Worker.

Reuse the existing immutable dispatch outbox, pending recovery, WorkLink and same-Ticket retries. A separate `task_trigger_review` table and `along.task_trigger_review` / `task_trigger_review` mandate preserve the distinct origin. No health baseline is written. Cancel, archive, new input, foreign edits or re-pair invalidate unfinished work. Human-stopped tickets do not reopen.

The review context tool returns the current goal/context, owned task, exact accepted evidence and current conversation page. The finish tool checks actual persisted trigger plus the declared cadence/timezone/next occurrence, rather than accepting a plan or diagnostic report. Failed/blocked work retries normally; waiting is recorded distinctly and cannot report ready. ChangeSets remain the existing writer, constrained to this task's trigger/repeat/reminder plan. Existing time, content and status are immutable in this background scope; new genuine user changes continue through the current-chat path. If no time existed, the normal validated ChangeSet may choose one.

Only background audit state and legitimate task projection sync are written. No personal chat, notification, health baseline or execution count is manufactured. All tests use synthetic users, goals, SQLite and isolated Runtime fixtures; actual model/production repair is a separate release-owner acceptance.
