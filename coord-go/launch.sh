#!/bin/sh
# Coordinator launcher. run-mode.json mode=headless -> Rust coordinator (fallback Go); browser modes (dual/single) -> Node.
# Force Go:   touch /opt/ais2api/coord-go/USE_GO
# Force Node: touch /opt/ais2api/coord-go/USE_NODE (or COORD_IMPL=node in the unit)
# Merged (/opt/ais2api/coord-rs/MERGED): management 8893 + login 8894 run in the Rust process; when Go or Node serves
# 8890, a Rust side process (--side) serves them instead.
# The no-browser service (ais2api-headless, 2048) only serves headless mode: it is started there and stopped in
# browser modes, so a mode switch (which restarts this unit) also switches the backend.
ROOT="${DUAL_ROOT:-/opt/ais2api/dual-runtime}"
RS="${COORD_RS:-/opt/ais2api/coord-rs/coordinator}"
GO=/opt/ais2api/coord-go/coordinator
NODE_ENTRY="$ROOT/refactor/start-coordinator.js"
# Side process (management 8893 + login 8894) next to a Go/Node coordinator; restarted if it exits.
# On stop systemd signals the whole unit (KillMode=control-group): the loop and the side process both end.
side() {
  [ -e /opt/ais2api/coord-rs/MERGED ] && [ -x "$RS" ] || return 0
  echo "[launcher] management + login -> Rust side process"
  ( trap 'kill -TERM $child 2>/dev/null; wait $child; exit 0' TERM INT
    while :; do "$RS" --side & child=$!; wait $child; echo "[launcher] side process exited ($?); restarting in 3 s"; sleep 3; done ) &
}
mode=$(sed -n 's/.*"mode":"\([a-z]*\)".*/\1/p' "$ROOT/run-mode.json" 2>/dev/null)
[ -z "$mode" ] && mode=headless
HL_UNIT="${HEADLESS_UNIT:-ais2api-headless}"
HL_ADDR="${HEADLESS_ADDR:-127.0.0.1:2048}"
if [ "$mode" = headless ]; then
  systemctl start --no-block "$HL_UNIT" || echo "[launcher] could not start $HL_UNIT"
  # wait (at most 20 s) until it accepts connections, so the first requests are not answered with 502
  n=0
  while [ "$n" -lt 40 ] && ! curl -s -o /dev/null -m 1 "http://$HL_ADDR/"; do n=$((n+1)); sleep 0.5; done
  if [ "$n" -lt 40 ]; then echo "[launcher] $HL_UNIT up"; else echo "[launcher] $HL_UNIT not answering on $HL_ADDR yet; continuing"; fi
else
  systemctl stop --no-block "$HL_UNIT" && echo "[launcher] run mode $mode: $HL_UNIT stopped (not used in browser modes)" || echo "[launcher] could not stop $HL_UNIT"
fi
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
