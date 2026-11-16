---
name: dsh-superagent-along-task
description: Create and adjust Along user tasks after goal intent is established; handle constraints, chat feedback and changes to an existing plan.
---

Read the goal and existing tasks before planning. A user task is an action for the person; a DSH Ticket or Assignment is agent execution and never belongs in that list.

For a new goal, submit a small useful next step together with `goal.create`. For an existing goal, use stable task ids and revisions to update or cancel rather than copying tasks. Carry temporary constraints in goal context with an expiry when known. Preserve explicit priorities and hard constraints. Ask one specific question only when missing information changes the next step.

Submit related operations as one validated `along_changes_commit`. Do not request adoption. Completion feedback is a fact; it is not permission to change the goal. A new user correction supersedes the older plan: read the latest conversation before any retry. `scheduled_at` is an ISO timestamp for an actual agreed arrangement; avoid inventing a precise time. A normal plan update is shown in the workspace without an extra system notification.
