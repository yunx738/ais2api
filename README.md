# ais2api

Dual-worker AI Studio proxy with OpenAI-compatible responses and an authenticated management console.

## Current production architecture
- `dual-runtime/refactor/`: coordinator, protocol-v2 workers, model catalog, independent quota ledger, request history and dashboard.
- `dual-runtime/code/`: shared browser/server code and legacy support modules. `unified-server.runtime.js` contains the deployed response adapter.
- Account/model quotas are independent: Flash 100 requests and Pro 10 requests per configured window. Anti-truncation aliases use their canonical model quota.
- Token prices are reference valuations only; they never affect request admission, quota windows or scheduling.
- Persistent request records do not store prompts, response text, credentials or raw errors.
- Native usage metadata is retained through OpenAI stream/non-stream conversion. Missing counts remain unknown.
- A received stream terminator is distinguished from an unconfirmed HTTP transport close. Worker settlement still requires execution-ledger evidence.

## Private runtime data
Account credentials, environment files, coordinator configuration, quota/execution state, request history, model policies and price configuration are local deployment data and must not be committed. Model policies and prices require explicit configuration on a new installation; they are not reconstructed from repository history.

## Coordinator resilience and console
Slot health checks, rotation and recovery progress independently. Rejected requests can safely move to another account after execution settlement; per-model cooldowns do not stop healthy accounts. The management console includes a compact mobile layout, searchable account table, quota details and expandable request diagnostics.
See [behavior, verification and rollout notes](dual-runtime/refactor/RESILIENCE.md). Run `npm test` for the offline coordinator regressions; `npm run test:ui` runs the fixture-based Playwright checks after installing its Chromium browser.

## Verification and limitations
The usage adapter passed 102 offline tests on Node 18.20.8 and Node 22. Completion-state handling subsequently passed 93 regression tests and UI rendering checks on both versions.
These tests do not replace live end-to-end acceptance. Missing cache/reasoning counts, incomplete transport and anti-truncation continuation totals can leave cost unknown.
Scalar price configuration does not automatically handle long-context tiers, mixed media, storage or tool charges.

## Anti-truncation
Prefix a configured canonical model with `anti-truncation/`. The proxy uses a synthetic `emit_answer` tool and bounded continuation attempts. Do not treat single-segment usage as the complete continuation total.

## Deployment
A deployment requires an explicit admission pause, drainage of in-flight executions, current-state backups, code identity checks and health verification before reopening.
Never overwrite the current quota/execution ledger with an old snapshot to recover a service.
