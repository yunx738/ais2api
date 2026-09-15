# Controlled cutover runbook — NOT approved or executed

## Observed production entry
- Service: ais2api-dual-coordinator.service
- ExecStart: /usr/bin/node /opt/ais2api/dual-runtime/code/start-coordinator.js
- WorkingDirectory: /opt/ais2api/dual-runtime/code
- Restart=no; systemd stop timeout=650s; application drain deadline=620s.
- Management, worker A and worker B are separate existing containers.
- ais-proxy.service and unrelated services are out of scope.

## Gates before requesting deployment approval
1. Worker protocol/tracker/ledger/HTTP assembly and closed-admission evidence checks passed offline. Real worker startup with browser, relay and assigned account remains unverified.
2. Confirm actual reverse-proxy admission-pause mechanism without logging credentials; no pause has been configured.
3. Review candidate worker specifications and management mount overlay against each current container. An overlay alone is not a full container specification.
4. Inventory pending requests, rotations, catalog tasks and settled retirements. Never infer completion solely from aggregate health or process exit.
5. Agree on a bounded maintenance window, explicit abort deadline and user-visible outage response. Do not promise a duration before browser readiness is known.

## Proposed cutover sequence (requires approval; not executable automation)
1. Pause new generation admissions at the confirmed ingress while preserving controlled management access. Reject queued submissions explicitly; never replay them automatically.
2. Drain and independently verify old work. A 620s exit, SIGKILL or an empty socket list is not completion evidence. Abort if any execution is unresolved.
3. After the old coordinator has stopped writing, retain a minimal timestamped checkpoint and service/container configuration needed for rollback; do not make bulk auth copies.
4. Preserve account ownership, cooldowns, quota counters and window starts. Validate the handover state with the candidate reader without rewriting the live file.
5. Replace A only; verify assignment, relay, authenticated protocol, worker epoch and browser readiness. If unsuccessful, stop the cutover; do not touch B.
6. Replace B only after A has passed its gate. Never stop/restart A and B simultaneously.
7. Point only the dual coordinator service at the candidate entry, preserving root/config/auth and stop timeout. Candidate paths must remain available; do not run both coordinators.
8. Apply the reviewed management container specification with candidate entry/routes/UI while preserving authentication and other required settings.
9. With external generation admission still paused, perform an explicitly approved real catalog sync per account and configure reviewed quota policies. Check model availability and management authentication.
10. Reopen generation admission only after all gates pass. User performs one real usage acceptance round; no load test or production fault injection.

## Rollback rules
- Before candidate work is admitted: revert reviewed service/container bindings sequentially only after verifying no candidate operations remain.
- After candidate work is admitted: pause admissions and reconcile candidate work first. Preserve the latest ownership, cooldowns, quota counters and windows.
- Never overwrite current state with a pre-cutover snapshot after new work; never discard executions, retirement intents or catalog tasks to make legacy code start.
- If backward state compatibility cannot be demonstrated, keep admissions paused and repair forward or design an explicit reviewed state conversion.
- Candidate worker/page loss with unresolved execution evidence is a manual reconciliation gate, not permission to release occupancy.

## Evidence and remaining scope
- Offline state/retirement recovery, browser/worker receipt behavior, halted coordinator startup/shutdown and Node18 management login/route assembly checks passed.
- Full active system startup, reverse-proxy pause, real catalog discovery and real generation acceptance remain unverified.
- No deployment commands in this document have been executed.

## Located ingress and candidate pause artifact
- Shared proxy container: 1Panel-openresty-LykW. Only the AIS site is in scope.
- Site source: /opt/1panel/apps/openresty/openresty/conf/conf.d/aisbuild.129357.xyz.conf
- /v1 and /v1beta proxy to loopback 8890; management proxies to loopback 8893.
- ingress-paused.conf and ingress-plan.json are generated and passed full proxy configuration syntax validation via a temporary file; NOT applied.
- Pause covers API model-list reads as well as generation. Management and ACME remain unchanged.
- Graceful reload alone cannot prove admission is stopped: verify old proxy workers/connections and direct localhost API consumers before handover.

## Management parameter audit
- Replacement plan now includes IPC, cgroup namespace, shared memory, runtime, masked/readonly paths and terminal flags. Labels and environment must be inherited in memory; the plan intentionally contains no credential values.
- No create/start/stop/rename request has been issued. Final payload review and explicit cutover approval are still required.
