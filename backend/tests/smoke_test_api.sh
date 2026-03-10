#!/bin/bash
# API smoke test — spins up a temporary FastAPI server, validates key endpoints, tears down.
# Used by pre-commit hook to catch API regressions before every commit.

set -euo pipefail

PORT=18999
BASE="http://127.0.0.1:${PORT}"
PID=""
PASS=0
FAIL=0

cleanup() {
    if [ -n "$PID" ]; then
        kill "$PID" 2>/dev/null || true
        wait "$PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

cd "$(dirname "$0")/.."

# Start server
python -m uvicorn main:app --port "$PORT" --log-level warning &
PID=$!

# Wait for startup (max 20s)
for i in $(seq 1 40); do
    if curl -sf "${BASE}/api/years" > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "FAIL: Server died during startup"
        exit 1
    fi
    sleep 0.5
done

if ! curl -sf "${BASE}/api/years" > /dev/null 2>&1; then
    echo "FAIL: Server did not start within 20s"
    exit 1
fi

check() {
    local desc="$1"
    local url="$2"
    local jq_expr="$3"
    local expected="$4"

    local result
    result=$(curl -sf "$url" | python3 -c "
import sys, json
data = json.load(sys.stdin)
expr = '''$jq_expr'''
result = eval(expr, {'data': data})
print(result)
" 2>/dev/null) || { echo "FAIL: $desc (request failed)"; FAIL=$((FAIL+1)); return; }

    if [ "$result" = "$expected" ]; then
        echo "PASS: $desc"
        PASS=$((PASS+1))
    else
        echo "FAIL: $desc (got '$result', expected '$expected')"
        FAIL=$((FAIL+1))
    fi
}

# Test 1: /api/heatmap/states returns 27 states
check "heatmap/states returns states" \
    "${BASE}/api/heatmap/states" \
    "len(data) >= 27" \
    "True"

# Test 2: /api/filter-options returns non-empty tipo list for RS
check "filter-options RS has tipos" \
    "${BASE}/api/filter-options?selected_states=RS" \
    "len(data.get('tipos', [])) > 0" \
    "True"

# Test 3: /api/heatmap/bairros for POA returns 90+ bairros
check "heatmap/bairros POA has 90+ bairros" \
    "${BASE}/api/heatmap/bairros?municipio=PORTO%20ALEGRE&selected_states=RS" \
    "len(data) >= 90" \
    "True"

# Test 4: /api/available-states returns entries
check "available-states returns data" \
    "${BASE}/api/available-states" \
    "len(data) > 0" \
    "True"

# Test 5: Consistency check — heatmap weight ≈ location-stats total for POA
# Get total weight from heatmap/bairros for POA
HEATMAP_TOTAL=$(curl -sf "${BASE}/api/heatmap/bairros?municipio=PORTO%20ALEGRE&selected_states=RS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(sum(d['weight'] for d in data))
" 2>/dev/null)

STATS_TOTAL=$(curl -sf "${BASE}/api/location-stats?municipio=PORTO%20ALEGRE&selected_states=RS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('total', 0))
" 2>/dev/null)

if [ -n "$HEATMAP_TOTAL" ] && [ -n "$STATS_TOTAL" ] && [ "$HEATMAP_TOTAL" -gt 0 ] && [ "$STATS_TOTAL" -gt 0 ]; then
    # Allow 5% difference (rounding, cluster merge effects)
    RATIO=$(python3 -c "print(abs($HEATMAP_TOTAL - $STATS_TOTAL) / max($HEATMAP_TOTAL, $STATS_TOTAL) < 0.05)")
    if [ "$RATIO" = "True" ]; then
        echo "PASS: POA heatmap/location-stats consistency (heatmap=$HEATMAP_TOTAL, stats=$STATS_TOTAL)"
        PASS=$((PASS+1))
    else
        echo "FAIL: POA heatmap/location-stats mismatch (heatmap=$HEATMAP_TOTAL, stats=$STATS_TOTAL)"
        FAIL=$((FAIL+1))
    fi
else
    echo "SKIP: Could not fetch POA totals for consistency check"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
