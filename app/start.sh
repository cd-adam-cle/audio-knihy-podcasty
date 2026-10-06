#!/bin/zsh
# Spustí Audioknihy jen pro tento Mac (http://localhost:4321)
cd "$(dirname "$0")"
(sleep 1 && open "http://localhost:4321") &
exec node server.mjs
