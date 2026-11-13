#!/usr/bin/env bash
# Git-backed checkpoints; the normal index and default branch are never modified.
set -euo pipefail
branch=translation-batch-state
parent_file="${RUNNER_TEMP:?}/translation-batch-parent"
case "${1:-}" in
  restore)
    if git ls-remote --exit-code --heads origin "refs/heads/$branch" > "$RUNNER_TEMP/batch-ref"; then
      git fetch --no-tags origin "refs/heads/$branch"
      parent=$(git rev-parse FETCH_HEAD)
      printf '%s\n' "$parent" > "$parent_file"
      git restore --source="$parent" --worktree -- i18n/batches/
    else
      status=$?
      if [ "$status" -ne 2 ]; then exit "$status"; fi
      printf '\n' > "$parent_file"
    fi
    ;;
  save)
    parent=$(cat "$parent_file")
    index_file="$RUNNER_TEMP/translation-batch-index"
    rm -f "$index_file"
    GIT_INDEX_FILE="$index_file" git read-tree --empty
    GIT_INDEX_FILE="$index_file" git add -- i18n/batches/README.md
    shopt -s nullglob
    files=(i18n/batches/*.json)
    if [ "${#files[@]}" -gt 0 ]; then
      GIT_INDEX_FILE="$index_file" git add --force -- "${files[@]}"
    fi
    tree=$(GIT_INDEX_FILE="$index_file" git write-tree)
    if [ -n "$parent" ] && [ "$tree" = "$(git show -s --format=%T "$parent")" ]; then
      echo 'Batch state unchanged.'
      exit 0
    fi
    args=()
    if [ -n "$parent" ]; then args+=(-p "$parent"); fi
    commit=$(git -c user.name='github-actions[bot]' \
      -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
      commit-tree "$tree" "${args[@]}" -m 'chore: checkpoint Gemini Batch API jobs')
    git push origin "$commit:refs/heads/$branch"
    printf '%s\n' "$commit" > "$parent_file"
    ;;
  *) echo 'Usage: batch-state.sh restore|save' >&2; exit 1 ;;
esac
