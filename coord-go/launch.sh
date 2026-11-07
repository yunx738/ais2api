#!/bin/sh
# Coordinator launcher. run-mode.json mode=headless -> Go coordinator; browser modes (dual/single) -> Node.
# Force the Node version: create /opt/ais2api/coord-go/USE_NODE (or set COORD_IMPL=node in the unit).
ROOT="${DUAL_ROOT:-/opt/ais2api/dual-runtime}"
GO=/opt/ais2api/coord-go/coordinator
NODE_ENTRY="$ROOT/refactor/start-coordinator.js"
mode=$(sed -n 's/.*"mode":"\([a-z]*\)".*/\1/p' "$ROOT/run-mode.json" 2>/dev/null)
[ -z "$mode" ] && mode=headless
if [ "$mode" = headless ] && [ "$COORD_IMPL" != node ] && [ ! -e /opt/ais2api/coord-go/USE_NODE ] && [ -x "$GO" ]; then
  echo "[launcher] run mode $mode -> Go coordinator"
  export GOMEMLIMIT="${GOMEMLIMIT:-120MiB}"
  exec "$GO" -addr 127.0.0.1:8890
fi
echo "[launcher] run mode $mode -> Node coordinator"
exec /usr/bin/node "$NODE_ENTRY"