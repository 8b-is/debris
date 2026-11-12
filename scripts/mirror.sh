#!/usr/bin/env bash
# Mirror this repository to both forges.
#
# Reachability is checked before anything is pushed: a mirror that half-runs
# leaves the forges disagreeing, which is worse than not trying.
#
#   scripts/mirror.sh              push main to both
#   DEBRIS_BRANCH=x scripts/mirror.sh
#
# Both forges are equal. Neither is authoritative.
set -euo pipefail

GH="${DEBRIS_GH:-https://github.com/8b-is/debris.git}"
CB="${DEBRIS_CB:-git@codeberg-peterlodri-sec:8b-is/debris.git}"
BRANCH="${DEBRIS_BRANCH:-main}"

say() { printf '  %s\n' "$*"; }

cd "$(git rev-parse --show-toplevel)"

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "refusing to mirror a dirty tree; commit first" >&2
    exit 1
fi

echo "debris mirror · branch $BRANCH"
say "github   $GH"
say "codeberg $CB"

fail=0
for pair in "github|$GH" "codeberg|$CB"; do
    name="${pair%%|*}"
    url="${pair#*|}"
    if git ls-remote --exit-code "$url" >/dev/null 2>&1; then
        say "$name: reachable"
    else
        say "$name: UNREACHABLE"
        fail=1
    fi
done

if [ "$fail" -ne 0 ]; then
    cat >&2 <<'EOF'

Not pushing: at least one forge is unreachable.

  github    https://github.com/8b-is/debris
  codeberg  https://codeberg.org/8b-is/debris
            create with:
            curl -X POST https://codeberg.org/api/v1/orgs/8b-is/repos \
              -H "Authorization: token $CODEBERG_TOKEN" \
              -H 'Content-Type: application/json' \
              -d '{"name":"debris","private":false,"default_branch":"main"}'
EOF
    exit 1
fi

echo
echo "pushing..."
git push "$GH" "$BRANCH"
git push "$CB" "$BRANCH"

echo
echo "verify (each line must print the same commit):"
for pair in "github|$GH" "codeberg|$CB"; do
    name="${pair%%|*}"
    url="${pair#*|}"
    printf '  %-9s ' "$name"
    git ls-remote "$url" "refs/heads/$BRANCH" | awk '{print $1}'
done
printf '  %-9s ' "local"
git rev-parse HEAD