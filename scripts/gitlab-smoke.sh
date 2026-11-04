#!/bin/sh
# Smoke-test the GitLab CLI exactly as the agent uses it.
# Usage: GLAB=/path/to/agent-glab scripts/gitlab-smoke.sh <gitlab-host> <group/project> <issue-iid> [merge-request-iid]
# Example: GLAB=/srv/dsh/agent-glab scripts/gitlab-smoke.sh gitlab.com acme/widgets 12 7
# The issue and merge request must be disposable test objects: the script posts a note.
set -eu
host=${1:?usage: $0 <gitlab-host> <group/project> <issue-iid> [merge-request-iid]}
project=${2:?usage: $0 <gitlab-host> <group/project> <issue-iid> [merge-request-iid]}
issue=${3:?usage: $0 <gitlab-host> <group/project> <issue-iid> [merge-request-iid]}
mr=${4:-}
glab=${GLAB:-glab}
encoded=$(printf '%s' "$project" | sed 's|/|%2F|g')
api() { "$glab" api "$@"; }
field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" | head -1; }

echo "account:"
api user | field username | sed 's/^/  /'
echo "project:"
api "projects/$encoded" >/dev/null
echo "  readable"

echo "issue #$issue:"
before=$(api "projects/$encoded/issues/$issue" | field updated_at)
marker="dsh-gitlab-smoke-$(date +%s)"
api "projects/$encoded/issues/$issue/notes" --method POST --raw-field "body=$marker" >/dev/null
after=$(api "projects/$encoded/issues/$issue" | field updated_at)
printf '  updated_at %s -> %s\n' "$before" "$after"
if [ "$before" = "$after" ]; then
  echo "  WARNING: updated_at did not change after a note; project polling may miss notes" >&2
  exit 1
fi
api "projects/$encoded/issues/$issue/notes?sort=desc&order_by=created_at&per_page=20" | grep -q "$marker"
echo "  note read back"

echo "credential helper:"
if printf 'protocol=https\nhost=%s\n\n' "$host" | "$glab" auth git-credential >/dev/null; then
  echo "  ok"
else
  echo "  failed" >&2
  exit 1
fi

if [ -n "$mr" ]; then
  echo "merge request !$mr:"
  api "projects/$encoded/merge_requests/$mr" | field state | sed 's/^/  state: /'
  api "projects/$encoded/merge_requests/$mr/notes" >/dev/null
  echo "  notes readable"
fi
echo "smoke passed"