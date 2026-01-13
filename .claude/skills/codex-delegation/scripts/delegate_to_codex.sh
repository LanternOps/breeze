#!/bin/bash
# Helper script for delegating tasks to OpenAI Codex CLI
# Usage: delegate_to_codex.sh "<task>" [--model <model>] [--dir <directory>]

TASK="${1:-}"
MODEL="${CODEX_MODEL:-gpt-5.2-codex medium}"
WORKDIR="${PWD}"
SEARCH_ENABLED=false
TIMEOUT_SECONDS=120  # 2 minutes default

# Parse arguments
shift || true
while [[ $# -gt 0 ]]; do
    case $1 in
        --model)
            MODEL="$2"
            shift 2
            ;;
        --dir)
            WORKDIR="$2"
            shift 2
            ;;
        --search)
            SEARCH_ENABLED=true
            shift
            ;;
        --timeout)
            TIMEOUT_SECONDS="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Verify codex is installed
if ! command -v codex &> /dev/null; then
    echo "Error: 'codex' command not found. Please install OpenAI Codex CLI."
    echo "See: https://github.com/openai/codex"
    exit 1
fi

if [[ -z "$TASK" ]]; then
    echo "Usage: $0 \"<task>\" [--model <model>] [--dir <directory>] [--search] [--timeout <seconds>]"
    echo ""
    echo "Examples:"
    echo "  $0 \"Run the test suite\""
    echo "  $0 \"Install requests package\" --dir /path/to/project"
    echo "  $0 \"Search for all TODO comments\" --search"
    exit 1
fi

# Validate timeout is a number
if ! [[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
    echo "Error: --timeout must be a positive integer (seconds)"
    exit 1
fi

echo "======================================================="
echo "Delegating to OpenAI Codex:"
echo "Task: $TASK"
echo "Model: $MODEL"
echo "Directory: $WORKDIR"
echo "Timeout: ${TIMEOUT_SECONDS}s"
echo "======================================================="
echo ""

# Build command array (safer than eval)
CMD_ARGS=(exec "$TASK" --full-auto -m "$MODEL" -C "$WORKDIR")

if [[ "$SEARCH_ENABLED" == "true" ]]; then
    CMD_ARGS+=(--search)
fi

# Execute with timeout (use timeout command if available)
EXIT_CODE=0
if command -v timeout &> /dev/null; then
    timeout "${TIMEOUT_SECONDS}s" codex "${CMD_ARGS[@]}" || EXIT_CODE=$?
elif command -v gtimeout &> /dev/null; then
    # macOS with coreutils installed
    gtimeout "${TIMEOUT_SECONDS}s" codex "${CMD_ARGS[@]}" || EXIT_CODE=$?
else
    # Fallback: run without timeout
    codex "${CMD_ARGS[@]}" || EXIT_CODE=$?
fi

echo ""
echo "======================================================="
if [[ $EXIT_CODE -eq 0 ]]; then
    echo "[OK] Delegation completed successfully"
elif [[ $EXIT_CODE -eq 124 ]]; then
    echo "[TIMEOUT] Delegation timed out after ${TIMEOUT_SECONDS}s"
else
    echo "[FAILED] Delegation failed with exit code: $EXIT_CODE"
fi
echo "======================================================="

exit $EXIT_CODE
