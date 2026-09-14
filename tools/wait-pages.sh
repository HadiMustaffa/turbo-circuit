#!/usr/bin/env bash
# Wait for the GitHub Pages build to finish, then report the status.
# A Pages deploy that says "pushed" but never finishes building looks identical from the git
# side, so the wait is part of the deploy rather than something to eyeball later.
GH="/c/Program Files/GitHub CLI/gh.exe"
for i in $(seq 1 40); do
  st=$("$GH" api repos/HadiMustaffa/turbo-circuit/pages --jq '.status' 2>/dev/null)
  echo "  [$((i*6))s] status: ${st:-unknown}"
  if [ "$st" = "built" ]; then echo "PAGES_BUILT"; exit 0; fi
  if [ "$st" = "errored" ]; then echo "PAGES_ERRORED"; exit 1; fi
  sleep 6
done
echo "PAGES_TIMEOUT"
exit 1
