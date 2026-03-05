#!/usr/bin/env bash
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
MAX_ITERATIONS=40
PLAN="PLAN-DECORATORS.md"
PROGRESS=".plan-progress"
LOG_DIR=".plan-logs"
PROMPT_FILE=$(mktemp)
trap 'rm -f "$PROMPT_FILE"' EXIT

# ── Setup ───────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
touch "$PROGRESS"

completed_before=$(wc -l < "$PROGRESS" | tr -d ' ')

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  scatter decorator plan runner                              ║"
echo "║  plan:     $PLAN"
echo "║  progress: $PROGRESS ($completed_before tasks done)"
echo "║  max:      $MAX_ITERATIONS iterations"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

for (( i=1; i<=MAX_ITERATIONS; i++ )); do
  done_list=""
  if [ -s "$PROGRESS" ]; then
    done_list=$(cat "$PROGRESS")
  fi

  timestamp=$(date '+%H:%M:%S')
  logfile="$LOG_DIR/iteration-$(printf '%03d' "$i").md"

  echo "┌─ iteration $i/$MAX_ITERATIONS  [$timestamp] ─────────────────────"

  # ── Write prompt to temp file (avoids all quoting hell) ───────
  cat > "$PROMPT_FILE" <<'STATIC_PART'
You are implementing the scatter decorator plan.

RULES:
1. Read the file PLAN-DECORATORS.md (the full implementation plan).
2. The following task IDs are ALREADY DONE — skip them:
STATIC_PART

  # Append done list (variable expansion needed here)
  echo "$done_list" >> "$PROMPT_FILE"

  cat >> "$PROMPT_FILE" <<'STATIC_PART'
3. Find the NEXT task that is NOT in the done list.
   Tasks are ordered: D1.1 through D1.10, then D2.1 through D2.9, then D3.1 through D3.10, then D4.1 through D4.4, then D5 (tests).
   Respect phase dependencies: D2/D3 need D1 done. D4 needs D2+D3 done. D5 needs D4 done.
4. Implement ONLY that single task. Follow the plan exactly.
   - Read the plan section for context, sketches, and constraints.
   - Read existing source files in src/decorators/ before writing to avoid conflicts.
   - Write production-quality code. No placeholders. No TODOs.
   - For test tasks (D1.8-D1.10, D5), write the tests described in the Test Plan section.
5. After completing the task, verify your work:
   - If you wrote code, make sure the file is syntactically valid.
   - If you wrote tests, run them with bun test and confirm they pass.
6. When done, print EXACTLY this line as your FINAL output (nothing after it):
   PLAN_TASK_DONE: Dx.y
   where Dx.y is the task ID you completed (e.g. D1.1, D2.3, etc.)
7. If ALL tasks are done (nothing left to implement), print exactly:
   PLAN_COMPLETE
8. If a task cannot be done because its dependency phase is incomplete, print exactly:
   PLAN_BLOCKED: Dx.y needs Dz

Do NOT ask questions. Do NOT explain what you will do. Just read, implement, verify, report.
STATIC_PART

  # ── Run claude ────────────────────────────────────────────────
  set +e
  output=$(claude --dangerously-skip-permissions < "$PROMPT_FILE" 2>&1 | tee "$logfile")
  exit_code=$?
  set -e

  # ── Parse result ──────────────────────────────────────────────
  if echo "$output" | grep -q "PLAN_COMPLETE"; then
    echo "│  ✅ ALL TASKS COMPLETE"
    echo "└──────────────────────────────────────────────────────────"
    echo ""
    echo "Done. $(wc -l < "$PROGRESS" | tr -d ' ') tasks completed."
    exit 0
  fi

  task_id=$(echo "$output" | grep -oE 'PLAN_TASK_DONE: D[0-9]+\.[0-9]+' | tail -1 | sed 's/PLAN_TASK_DONE: //' || true)

  if [ -n "$task_id" ]; then
    if ! grep -qxF "$task_id" "$PROGRESS"; then
      echo "$task_id" >> "$PROGRESS"
    fi
    completed=$(wc -l < "$PROGRESS" | tr -d ' ')
    echo "│  ✅ $task_id  (total: $completed done)"
  elif echo "$output" | grep -q "PLAN_BLOCKED"; then
    blocked_line=$(echo "$output" | grep "PLAN_BLOCKED" | tail -1)
    echo "│  🚧 $blocked_line"
    echo "│     stopping — dependency not met"
    echo "└──────────────────────────────────────────────────────────"
    exit 1
  else
    echo "│  ⚠️  no task marker found (exit code: $exit_code)"
    echo "│     check log: $logfile"
  fi

  echo "│  log: $logfile"
  echo "└──────────────────────────────────────────────────────────"
  echo ""

  sleep 2
done

echo "Hit max iterations ($MAX_ITERATIONS). $(wc -l < "$PROGRESS" | tr -d ' ') tasks done."
exit 1
