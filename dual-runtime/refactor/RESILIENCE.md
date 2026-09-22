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
- Rotation readiness failures can be reconciled against the exact persisted account, reservation and replacement container identity. Ambiguous destructive operations remain isolated to the affected slot for operator review.

Local request quotas are still local policy, not a claim about the provider's remaining balance. A raw error inside an HTTP 200 response is not an HTTP rejection eligible for automatic account replay.

## Management and UI

- The console uses compact cards, searchable/filterable/paged accounts, account quota details, dense request records and expandable diagnostics. Mobile navigation and touch targets are retained.
- Degraded health, pending completion, model cooldown and blocked rotation remain visible instead of reporting every unhalted coordinator as fully healthy.
- Invalid rotation JSON cannot become an accidental rotate-all action. No accepted rotations returns HTTP 409; an accepted operation returns 202 and is tracked until completion.
- Existing mode controls, model policy controls, accounting semantics and unknown usage values remain intact.

## Verification

Run from the repository root:

```sh
npm test
npm run test:ui
```

The UI check uses the existing Playwright dependency and its installed Chromium. Alternatively set `AIS_BROWSER_EXECUTABLE` to a local Chromium path; `AIS_UI_SCREENSHOTS` selects the screenshot output directory (defaults to a temporary directory).

Tests use local fixtures and mock control endpoints; no live account or generation request is needed. The regression cases cover hung-slot isolation, 429 failover and cooldown, uncertain completion, cancellation, retry limits, catalog timeouts, corrupt management requests, rotation recovery and checkpoint persistence. UI verification uses synthetic accounts and request history at 360–1440 px, including filtering races, pagination, quota dialogs, expandable diagnostics, offline recovery and dark theme.

## Applying the change

Deploy the full changed `dual-runtime/refactor/` source and UI together so the monitor, scheduler, rotation and new helper modules stay in sync. `start-coordinator.js` remains the entry point. Preserve existing configuration, account credentials, model policies, pricing, history and the current quota/execution checkpoint.

Use the existing admission pause and drain process before replacing the coordinator. Do not run two coordinators against one checkpoint, delete unresolved execution records or roll quota state back. After restarting, verify both slot identities, fresh catalogs, queue progress and a normal user request. If a slot still has unconfirmed browser work, inspect that slot's evidence; the other healthy slot can continue serving.

These source changes and offline checks do not constitute a production deployment or live provider acceptance.
