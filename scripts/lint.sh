#!/usr/bin/env sh
# Syntax-check every tracked JavaScript file. No dependencies.
set -e
status=0
for f in $(git ls-files '*.js'); do
  node --check "$f" || status=1
done
exit $status
