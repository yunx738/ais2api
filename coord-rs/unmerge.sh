#!/bin/sh
# Rollback: Node management container + Node login service again; coordinator keeps 8890 only.
set -u
rm -f /opt/ais2api/coord-rs/MERGED
systemctl restart ais2api-dual-coordinator
docker update --restart=unless-stopped ais2api-dual-management >/dev/null && docker start ais2api-dual-management >/dev/null
systemctl enable --now ais2api-login >/dev/null 2>&1
echo unmerged
