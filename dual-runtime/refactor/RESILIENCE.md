# Coordinator resilience and compact console

The active source is `dual-runtime/refactor/`. This change does not edit the browser response adapter, anti-truncation implementation or fake streaming implementation.

## Scheduling behavior

- Health polling, catalog reconciliation and lifecycle operations are isolated by slot. An unreachable A cannot hold a global polling or rotation lock over B.
- A 429 defers the rejecting account's canonical model. Other models and accounts remain eligible. `Retry-After` seconds and HTTP dates are honored with a bounded cooldown; explicit daily/balance exhaustion gets a longer fallback than an ordinary rate limit.
- Rotation considers the models actually waiting in the queue. A depleted requested model can trigger rotation even when another model still has local quota. Occupied, cooling and locally exhausted spare accounts are skipped.
- Small HTTP 401/403/429 rejections can be retried on another account only before client output, after authenticated execution completion. The logical request keeps its original queue deadline, attempts at most three accounts, and never reuses an execution ID.
- Partial responses, uncertain transport failures and timeouts are not replayed. Completion and retirement records stay durable until the worker supplies the required evidence. Timeout is not completion.
- The default queue admits at most ten waiting requests for up to 120 seconds. Shutdown and a halted dispatcher reject queued work immediately. A retry has the same waiting deadline as its initial attempt.
- Confirmed completion, retirement and catalog reads have bounded, independent control waits. Catalog reads are deduplicated; a late expired read cannot replace the current cache.
- A known configured model can wait through startup or catalog replacement without bypassing model validation. Actual dispatch still requires a fresh eligible catalog.
- Worker control-key failures are identified as local gateway failures; they do not freeze an upstream account for a day or trigger account retries.
- Rotation reservation and recovery intent are one checkpoint. Pinned container identity and deterministic credential staging allow stop, rename, credential move, create and start steps to resume after a lost response or process restart. Ambiguous destructive operations remain isolated to the affected slot for operator review.
- Idle exited workers may restart under the same account with bounded backoff. Unresolved executions, retirement receipts, active catalog tasks, foreign identities and shutdown prohibit automatic restarts. Older pending rotations without a marker can resume only when the original account's canonical container is positively identified.
- A catalog intent saved immediately before a lost POST resumes the same idempotent job ID in the same worker epoch; missing records never count as completion.

Local request quotas are still local policy, not a claim about the provider's remaining balance. A raw error inside an HTTP 200 response is not an HTTP rejection eligible for automatic account replay.

## Management and UI

- The console uses compact cards, searchable/filterable/paged accounts, account quota details, dense request records and expandable diagnostics. Mobile navigation and touch targets are retained.
- Degraded health, pending completion, model cooldown and blocked rotation remain visible instead of reporting every unhalted coordinator as fully healthy.
- Invalid rotation JSON cannot become an accidental rotate-all action. No accepted rotations returns HTTP 409; an accepted operation returns 202 and is tracked until completion.
- The public management proxy validates rotation input before normalization, returns explicit API 401 on session expiry and bounds control calls with an absolute deadline. A successful mutation followed by a failed refresh stays unconfirmed in the UI; failure notices are not overwritten with success.
- Corrupt or inaccessible request history disables analytics instead of preventing coordinator startup. Existing files are preserved, and unavailable analytics return 503. Stalled log writes have a deadline and pause further recording so they cannot indefinitely hold generation slots; restart after repairing the history problem to restore recording.
- Existing mode controls, model policy controls, accounting semantics and unknown usage values remain intact.

## Verification

Run from the repository root:

```sh
npm test
npm run test:ui
```

The UI check uses the existing Playwright dependency and its installed Chromium. Alternatively set `AIS_BROWSER_EXECUTABLE` to a local Chromium path; `AIS_UI_SCREENSHOTS` selects the screenshot output directory (defaults to a temporary directory).

Tests use local fixtures and mock control endpoints; no live account or generation request is needed. The regression cases cover hung-slot isolation, 429 failover and cooldown, uncertain completion, cancellation, retry limits, catalog timeouts, corrupt management requests, rotation recovery and checkpoint persistence. UI verification uses synthetic accounts and request history at 360–1440 px, including filtering races, pagination, quota dialogs, expandable diagnostics, offline recovery and dark theme.

The second availability audit passes 169 offline tests (34 added), including real checkpoint and credential-directory operations with simulated Docker responses at crash points. Browser checks also compare the UI against actual `ModelQuotaLedger` and persisted `RequestHistory` outputs. These do not test a live Docker daemon, provider or VPS environment.

## Applying the change

Deploy the full changed `dual-runtime/refactor/` source and UI together so the monitor, scheduler, rotation and new helper modules stay in sync. `start-coordinator.js` remains the entry point. Preserve existing configuration, account credentials, model policies, pricing, history and the current quota/execution checkpoint.

Use the existing admission pause and drain process before replacing the coordinator. Do not run two coordinators against one checkpoint, delete unresolved execution records or roll quota state back. After restarting, verify both slot identities, fresh catalogs, queue progress and a normal user request. If a slot still has unconfirmed browser work, inspect that slot's evidence; the other healthy slot can continue serving.

These source changes and offline checks do not constitute a production deployment or live provider acceptance.

## Conservative retired-resource cleanup

Successful rotations now write a separate, private retirement receipt under `retired-resources/` **after** the new account ownership is checkpointed. It records the exact predecessor ID, account, reservation token, retirement time and credential inode/hash. A failed receipt write does not fail the rotation or halt generation; that unregistered backup remains untouched.

The coordinator checks hourly, when a slot is idle and no request is queued. The default policy retains every backup for at least **7 days** and always keeps the **two newest registered retirements per slot**. At most 10 candidates per slot are considered each pass, with a cursor so protected backups do not starve other candidates. Read-only Docker inventory happens outside the slot lease; a bounded container removal owns only that slot's lease. Cleanup runs on only one slot at a time, leaving the other available for admission. Waiting requests, shutdown, active executions, pending completion records, catalog operations, rotation or recovery stop cleanup.

Every candidate must pass all of these checks:

- A valid, committed retirement receipt matches the exact retired name, full container ID and project/slot/account labels. The container is stopped, has PID 0 and is neither paused nor restarting. Removal uses the exact ID with plain `docker rm`; **no force, volume deletion or prune** is used.
- The retired directory and its sole `auth-{account}.json` have the recorded identities and hash. The original account file still exists, has valid credential structure and is **byte-for-byte identical** to the backup. Different or unique login credentials are retained, even after the retention period.
- No other container, including a stopped one, mounts the directory, a parent or a child path. Symlinks, path aliases, unexpected files and changed identities prohibit cleanup.
- A complete subsequent Docker inventory confirms removal before the duplicate credential file is unlinked and the empty directory is removed. A timeout or lost command response is not absence. The receipt and retention conditions are revalidated before each deletion. Credential unlink uses a verified directory FD via Linux `/proc/self/fd` so a parent-path replacement cannot redirect it to the primary file. Interrupted cleanup resumes from the receipt and repeats the checks; it never recursively removes credential directories.

Primary `/opt/ais2api/auth/` credentials, current `slots/*/auth`, staging `auth-next-*`, configuration, model policies, prices, quota/execution checkpoints, history, images, networks and volumes are outside the cleanup targets. **Old resources without a retirement receipt are preserved**, including resources created before this feature or during a crash before receipt persistence. Unique or uncertain backups may therefore still accumulate; this policy does not promise a hard disk-space cap.

Optional `coordinator.json` configuration (the values below are the defaults):

```json
{
  "retiredCleanup": {
    "enabled": true,
    "retentionDays": 7,
    "keepPerSlot": 2,
    "intervalMinutes": 60,
    "maxPerSweep": 10
  }
}
```

Set `enabled` to `false` to disable deletion while continuing to record future retirements. `retentionDays` accepts 7–3650, `keepPerSlot` 2–100, `intervalMinutes` 5–1440 and `maxPerSweep` 1–10. Invalid cleanup settings disable cleanup and surface an error without stopping generation. Deploy both `retired-resource-cleanup.js` and `retired-resource-store.js` with the coordinator changes. Keep the new receipt directory when upgrading; restoring a receipt alone is never enough to authorize deletion of a different file or container.

The management status response exposes the effective policy and per-slot last scan, protected/removed counts and errors in `retiredCleanup`. The overview shows a compact retention/error notice. Cleanup and journal errors stay separate from the critical dispatch checkpoint.

Cleanup regression tests use real credential copies and journals with simulated Docker inventories, including unique credentials, foreign mounts, shutdown, concurrent admission/rotation, revoked receipts, parent-path replacement at unlink, lost remove replies and interrupted journal removal. They assert that primary/current credentials, configuration, checkpoint and history sentinels remain unchanged. The full suite now passes **244 tests** (75 added for cleanup), and the real-browser check covers the retention/error notice. No production cleanup has been executed.
