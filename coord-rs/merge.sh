#!/bin/sh
# Merge: management (8893) + login service (8894) run inside the Rust coordinator. Old services are stopped, not removed.
set -u
touch /opt/ais2api/coord-rs/MERGED
systemctl disable --now ais2api-login >/dev/null 2>&1
docker update --restart=no ais2api-dual-management >/dev/null && docker stop -t 10 ais2api-dual-management >/dev/null
systemctl restart ais2api-dual-coordinator
echo merged
