#!/bin/bash
cd /Users/lodripeter/workspace/peterlodri-sec/lantern
echo "== syntax"
for f in server/src/*.ts landing/app.js; do node --check "$f" || echo "FAIL $f"; done
echo "== tests"
node --test server/test/ 2>&1 | grep -E "^ℹ (tests|pass|fail)"
