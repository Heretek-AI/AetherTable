#!/usr/bin/env bash
set -e

echo "Starting Authoritative Headless Rust Engine Server on port 8080..."
cargo run -p vtt-server --release
