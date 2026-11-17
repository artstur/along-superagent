# Source facts and private on-demand reads

## Purpose

The Mac Host verifies a source's real read-only permission and saves its credential privately before publishing a capability fact. The Agent records only that fact. An account summary is never embedded in a source event, ordinary event bus, chat or synchronization snapshot.

This upstream module does not register routes/tools or change the global schema version. The orchestration integration supplies the existing private bridge authentication and bound identity, adds `SOURCE_STATE_SCHEMA` in a versioned migration, and invokes these methods on AlongStore's shared SQLite handle.

## Interfaces

- `acceptEvent(identity, body)` validates a strict source fact and records its payload hash transactionally. Event identity is user-scoped; the body cannot select a user/device.
- `queryCurrent(userId, goalId, provider)` reads metadata only from that owned goal.
- `createRead(scope, input)` creates/reuses a private read for a current task, input and host execution key. It requires a ready, allowed source with the requested capability.
- `pendingReads(userId, limit)` returns only that user's due requests as a bounded Host work list. It never returns account data and never performs a network refresh.
- `acceptReadResult(identity, body)` accepts Host cache results for those requests.
- `getRead(scope, requestId)` exposes private data only for a fresh, current and authorized result bound to the same task/input/execution.

Three tables separate source-event audit hashes/metadata, the current monotonic source fact, and private read requests/results. No method appends a chat message, sync entry or public event. All mutations use savepoints, including inside a caller's existing transaction.

## Version and authorization rules

Source generation/revision pairs are monotonic. A late old-generation ready event cannot revive a disconnected or revoked grant. Disconnected/revoked closes its generation; reconnecting requires a new generation. Ready requires an active owned goal and an allowed provider, by the default `goal_data_sources` recommendation or the integration's trusted assertion callback. Disconnect/revoke can clear prior authorization even after the recommendation/goal was withdrawn.

Ready is a verified current reading capability, not a claim that a dataset is fresh. A source fact is not aged out according to its event timestamp. Private reads compare the cached observation timestamp with their own bounded `max_age_seconds`.

A request captures its original source generation/revision. It can follow newer revisions in the same generation: the Host first flushes the source fact, then returns the exact current revision/reference. The result retains actual revision/reference for calculation provenance. A generation change, new task/input revision, cancellation, goal archive or provider withdrawal makes old data unreadable.

An old request may still receive a **denied** response echoing its original generation/version after revocation or reconnect; this terminates that request without altering the new source fact. An old-generation **ready** response is always rejected.

## Read state and freshness

Pending, stale and unavailable are recoverable. Host polling is backed off; duplicate stale/unavailable replies do not keep changing internal state. A legitimate user refresh may make an unchanged cached summary fresh without changing its source fact revision. A later fresh result may therefore restore the same request to ready. The poller reads verified cache only; it does not cause refresh loops.

Fresh ready, denied and invalidated requests are not repeatedly dispatched. An aged ready result becomes stale, and a same-generation source revision change makes its previous data stale. Ready data cannot be overwritten by a delayed failure. Data is removed from terminally invalidated/denied reads. Results are bounded JSON objects, never credentials or executable values.

## Acceptance

Synthetic SQLite tests cover event hash replay/conflict, dropped/late source revisions, terminal revocation/reconnect, per-user/goal/task boundaries, current input checks, private-data isolation, recoverable cache freshness, duplicate negative results, retry backoff, old-generation denial and rejection of late/foreign ready data. Shared route authentication and real Host vault/network behavior are tested by their integration owners.
