#!/usr/bin/env bash
# Run the browser suite N times and report which checks are flaky across runs.
# A suite that passes only sometimes is not verified, so this exists to prove stability.
cd /d/MK || exit 1
N=${1:-3}
for i in $(seq 1 "$N"); do
  node test/browser-check.mjs > "/tmp/flake-$i.log" 2>&1
  echo "--- run $i: $(grep -E '^[0-9]+ passed' "/tmp/flake-$i.log" | head -1)"
  awk '/^FAILED:/{f=1;next} f&&/^EXIT/{f=0} f' "/tmp/flake-$i.log" | head -6
  grep -E "collected .* item" "/tmp/flake-$i.log" | head -1
done
