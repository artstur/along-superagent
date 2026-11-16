---
name: dsh-superagent-along-task
description: Create and adjust Along user tasks after goal intent is established; handle constraints, chat feedback and changes to an existing plan.
---

Read the goal and existing tasks before planning. A user task is an action for the person; a DSH Ticket or Assignment is agent execution and never belongs in that list.

For a new goal, submit a small useful next step together with `goal.create`. For an existing goal, use stable task ids and revisions to update or cancel rather than copying tasks. Carry temporary constraints in goal context with an expiry when known. Preserve explicit priorities and hard constraints. Ask one specific question only when missing information changes the next step.

Submit related operations as one validated `along_changes_commit`. Do not request adoption. Completion feedback is a fact; it is not permission to change the goal. A new user correction supersedes the older plan: read the latest conversation before any retry. `scheduled_at` is an ISO timestamp for an actual agreed arrangement; avoid inventing a precise time. A normal plan update is shown in the workspace without an extra system notification.

For a requested recommendation that is now ready in an active goal, deliver it with `along_chat_reply` and `notify: "recommendation_ready"`. For an actionable task execution result, use `notify: "task_result"`. Include `task_id` only when there is a corresponding verified task. Do not signal routine acknowledgements, unchanged plans or internal progress. For a host-bound due review read its actual task time and current conversation, then finish with `along_health_followup`. Only renew a daily schedule when the user explicitly delegated it and later messages still support it. Cite the original user event via `renew_daily_from_event`. A clock tick does not read a phone.

For the concrete task explicitly delegated in the current user chat, set `repeat: "daily"` on its task.create or task.update.fields together with the agreed schedule. Omit for one-off tasks. To withdraw daily renewal use `repeat: "once"` on the affected task. An already-bound daily mandate continues after ordinary keep.
