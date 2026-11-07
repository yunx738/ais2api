#!/bin/sh
# Coordinator launcher. run-mode.json mode=headless -> Rust coordinator (fallback Go); browser modes (dual/single) -> Node.
# Force Go:   touch /opt/ais2api/coord-go/USE_GO
# Force Node: touch /opt/ais2api/coord-go/USE_NODE (or COORD_IMPL=node in the unit)
# Merged (/opt/ais2api/coord-rs/MERGED): management 8893 + login 8894 run in the Rust process; when Go or Node serves
# 8890, a Rust side process (--side) serves them instead.
ROOT="${DUAL_ROOT:-/opt/ais2api/dual-runtime}"
RS=/opt/ais2api/coord-rs/coordinator
GO=/opt/ais2api/coord-go/coordinator
NODE_ENTRY="$ROOT/refactor/start-coordinator.js"
side() { [ -e /opt/ais2api/coord-rs/MERGED ] && [ -x "$RS" ] && { echo "[launcher] management + login -> Rust side process"; "$RS" --side & }; }
mode=$(sed -n 's/.*"mode":"\([a-z]*\)".*/\1/p' "$ROOT/run-mode.json" 2>/dev/null)
[ -z "$mode" ] && mode=headless
if [ "$mode" = headless ] && [ "$COORD_IMPL" != node ] && [ ! -e /opt/ais2api/coord-go/USE_NODE ]; then
  if [ "$COORD_IMPL" != go ] && [ ! -e /opt/ais2api/coord-go/USE_GO ] && [ -x "$RS" ]; then
    echo "[launcher] run mode $mode -> Rust coordinator"
    exec "$RS" -addr 127.0.0.1:8890
  fi
  if [ -x "$GO" ]; then
    echo "[launcher] run mode $mode -> Go coordinator"
    export GOMEMLIMIT="${GOMEMLIMIT:-120MiB}"
    side
    exec "$GO" -addr 127.0.0.1:8890
  fi
fi
echo "[launcher] run mode $mode -> Node coordinator"
side
exec /usr/bin/node "$NODE_ENTRY"
