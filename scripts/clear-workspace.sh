#!/usr/bin/env bash
# clear-workspace.sh — wipe a student/project workspace for a fresh start.
#
# Usage:
#   ./clear-workspace.sh <student_id> <project_id>
#   ./clear-workspace.sh <student_id>            # wipes all projects for that student
#
# What gets removed:
#   workspaces/<student>/<project>/
#     chat-log.jsonl          active chat transcript
#     active-session.json     live-session marker
#     current-fast-eval.md    fast evaluator output
#     current-deep-eval.md    deep evaluator output
#     eval-state.json         deep evaluator bookkeeping
#     cumulative-report.md    running cross-session report
#     sessions/               archived session bundles
#     student_repo/           cloned student git repo
#     tmp/                    ephemeral script execution dirs
#
# What is NOT removed:
#   sessions/ is kept unless you pass --including-sessions
#   cumulative-report.md is kept unless you pass --including-sessions
#   The directory itself is removed and will be recreated on next session start.
#
# Options:
#   --including-sessions   also delete archived sessions/ and cumulative-report.md
#   --dry-run              show what would be deleted without deleting anything
#   --working-dir PATH     override workspace root (default /srv/ai-research-coach)

set -euo pipefail

WORKING_DIR="/srv/ai-research-coach"
INCLUDING_SESSIONS=0
DRY_RUN=0
STUDENT_ID=""
PROJECT_ID=""

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --including-sessions) INCLUDING_SESSIONS=1 ;;
    --dry-run)            DRY_RUN=1 ;;
    --working-dir)        WORKING_DIR="$2"; shift ;;
    --help|-h)            usage ;;
    -*)                   echo "Unknown option: $1"; usage ;;
    *)
      if [[ -z "$STUDENT_ID" ]]; then
        STUDENT_ID="$1"
      elif [[ -z "$PROJECT_ID" ]]; then
        PROJECT_ID="$1"
      else
        echo "Too many positional arguments."
        usage
      fi
      ;;
  esac
  shift
done

[[ -z "$STUDENT_ID" ]] && { echo "Error: student_id is required."; usage; }

WORKSPACES_ROOT="$WORKING_DIR/workspaces"

# Validate student_id and optional project_id look safe
if ! [[ "$STUDENT_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "Error: student_id '${STUDENT_ID}' contains invalid characters."
  exit 1
fi
if [[ -n "$PROJECT_ID" ]] && ! [[ "$PROJECT_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "Error: project_id '${PROJECT_ID}' contains invalid characters."
  exit 1
fi

# Resolve target paths
if [[ -n "$PROJECT_ID" ]]; then
  TARGETS=("$WORKSPACES_ROOT/$STUDENT_ID/$PROJECT_ID")
else
  # All project dirs under this student
  if [[ ! -d "$WORKSPACES_ROOT/$STUDENT_ID" ]]; then
    echo "No workspace found for student '${STUDENT_ID}' in ${WORKSPACES_ROOT}."
    exit 0
  fi
  mapfile -t TARGETS < <(find "$WORKSPACES_ROOT/$STUDENT_ID" -mindepth 1 -maxdepth 1 -type d)
  if [[ ${#TARGETS[@]} -eq 0 ]]; then
    echo "No project workspaces found for student '${STUDENT_ID}'."
    exit 0
  fi
fi

# These ephemeral files/dirs are always deleted
ALWAYS_DELETE=(
  chat-log.jsonl
  active-session.json
  current-fast-eval.md
  current-deep-eval.md
  eval-state.json
  student_repo
  tmp
)

# These are only deleted with --including-sessions
# (session-log.md is the RETURNING_VISITOR marker used by instructions.md)
SESSION_DELETE=(
  sessions
  cumulative-report.md
  session-log.md
)

echo ""
for TARGET in "${TARGETS[@]}"; do
  PROJ_ID=$(basename "$TARGET")
  echo "──────────────────────────────────────────"
  echo "  student:  $STUDENT_ID"
  echo "  project:  $PROJ_ID"
  echo "  path:     $TARGET"
  echo ""

  if [[ ! -d "$TARGET" ]]; then
    echo "  [skip] directory does not exist."
    continue
  fi

  ITEMS_TO_DELETE=()

  for name in "${ALWAYS_DELETE[@]}"; do
    [[ -e "$TARGET/$name" ]] && ITEMS_TO_DELETE+=("$TARGET/$name")
  done

  if [[ "$INCLUDING_SESSIONS" -eq 1 ]]; then
    for name in "${SESSION_DELETE[@]}"; do
      [[ -e "$TARGET/$name" ]] && ITEMS_TO_DELETE+=("$TARGET/$name")
    done
  else
    for name in "${SESSION_DELETE[@]}"; do
      [[ -e "$TARGET/$name" ]] && echo "  [keep]   $name  (use --including-sessions to remove)"
    done
  fi

  if [[ ${#ITEMS_TO_DELETE[@]} -eq 0 ]]; then
    echo "  Nothing to delete."
    continue
  fi

  for item in "${ITEMS_TO_DELETE[@]}"; do
    name=$(basename "$item")
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  [dry-run] would delete: $name"
    else
      rm -rf "$item"
      echo "  [deleted] $name"
    fi
  done

  # Remove the project dir itself if it's now empty (and not dry-run)
  if [[ "$DRY_RUN" -eq 0 ]] && [[ -d "$TARGET" ]]; then
    remaining=$(find "$TARGET" -mindepth 1 -maxdepth 1 | wc -l)
    if [[ "$remaining" -eq 0 ]]; then
      rmdir "$TARGET"
      echo "  [deleted] (empty project directory)"
    fi
  fi
done

echo "──────────────────────────────────────────"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run complete. Nothing was deleted."
else
  echo "Done."
fi
echo ""
