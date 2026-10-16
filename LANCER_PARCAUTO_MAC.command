#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  open "index.html"
  exit 0
fi
(sleep 1 && open "http://localhost:3000") &
node server.js
