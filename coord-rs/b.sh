#!/bin/bash
# Build (and optionally run) inside rust docker image. Usage: ./b.sh [run args...]
cd /root/coord-rs
docker run --rm -v /root/coord-rs:/src -v /root/.cargo-cache/registry:/usr/local/cargo/registry \
  -v /opt/ais2api:/opt/ais2api:ro -w /src rust:1-slim-bookworm \
  sh -c 'cargo build --release 2>&1 | grep -E "^(error|warning: unused)|^ *--> |^[0-9 ]*\||Finished|error\[" | head -150'
if [ "$1" = run ]; then shift; ./target/release/$(grep -m1 '^name' Cargo.toml | cut -d'"' -f2) "$@"; fi
