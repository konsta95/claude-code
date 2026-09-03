#!/bin/bash
# Regression tests for validate-agent.sh.
#
# Every check names the defect it pins, and each was seen FAILING against a validator that
# has that defect before it was accepted here:
#   abort         the first warning killed the script (((x++)) exits 1 under set -e), so no
#                 summary line was printed and warnings-only files exited 1
#   first-line    only the first line of a multi-line description was read
#   absorption    a stop-list extractor (stop at name|model|color|tools) folds any other key
#                 that follows the description into the description text
#   unparseable   a description continued on unindented lines, or ending in ':', passed even
#                 though Claude Code's YAML parser rejects the file and drops the agent
#   false-error   a valid plain multi-line value or a single line containing ': ' was rejected
#   silent-abort  a file without a tools field (optional) or without a required field ended
#                 the script at the field's grep (exit 1, no message, no summary)
#
# VALIDATOR may be overridden to point the suite at another script (used to demonstrate the
# failures above): VALIDATOR=/path/to/old.sh bash validate-agent.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="${VALIDATOR:-$SCRIPT_DIR/validate-agent.sh}"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMP_DIR="$(mktemp -d)" || exit 1
trap 'rm -rf "$TMP_DIR"' EXIT

fail=0
pass() { echo "PASS: $1"; }
flunk() { echo "FAIL: $1"; fail=1; }

OUT=""; RC=0
run() { OUT=$(bash "$VALIDATOR" "$1" 2>&1); RC=$?; }
has() { case "$OUT" in *"$1"*) return 0;; *) return 1;; esac; }
reported_length() {
  local n
  n=$(printf '%s\n' "$OUT" | sed -n 's/^✅ description: \([0-9]*\) characters.*/\1/p' | head -1)
  echo "${n:-0}"
}

BODY="You are a test agent. Your responsibilities: follow the process steps and produce output."

# 1. The plugin's own agents: exit 0, a summary line, no error, and the whole description read.
#    Their descriptions run well past 1000 characters; a first-line or truncating extractor
#    reports 200-300.
for agent in "$PLUGIN_ROOT"/agents/*.md; do
  label="own agent $(basename "$agent")"
  run "$agent"
  if [ $RC -ne 0 ]; then flunk "$label: exit $RC"; continue; fi
  has "Validation passed" || has "All checks passed" || { flunk "$label: no summary line (abort)"; continue; }
  has "❌" && { flunk "$label: error reported"; continue; }
  n=$(reported_length)
  [ "$n" -ge 1000 ] || { flunk "$label: description read as $n chars (first-line / truncation)"; continue; }
  pass "$label ($n chars)"
done

# 2. Absorption: keys after the description must not be counted as description text.
DESC='Use this agent when the user asks for X. Examples: <example>Context: c</example>'
cat > "$TMP_DIR/exact.md" <<EOF
---
name: exact-agent
description: |-
  $DESC
permissionMode: default
maxTurns: 3
model: inherit
color: blue
---

$BODY
EOF
run "$TMP_DIR/exact.md"
n=$(reported_length)
if [ $RC -eq 0 ] && [ "$n" -eq ${#DESC} ]; then
  pass "exact length with keys after the description (${#DESC} chars)"
else
  flunk "keys after the description: exit $RC, read $n chars, expected ${#DESC} (absorption)"
fi

# 3. Unparseable shapes must fail: unindented continuation, and a value ending in ':'.
cat > "$TMP_DIR/unindented.md" <<EOF
---
name: unindented-agent
description: Use this agent when the user asks for X. Examples

<example>
Context: c
user: "u"
assistant: "a"
</example>

model: inherit
color: blue
---

$BODY
EOF
run "$TMP_DIR/unindented.md"
if [ $RC -eq 1 ] && has "unindented"; then
  pass "unindented continuation rejected"
else
  flunk "unindented continuation: exit $RC (expected 1 with an 'unindented' error)"
fi

cat > "$TMP_DIR/colon.md" <<EOF
---
name: colon-agent
description: Use this agent when the user asks for X. Examples:
model: inherit
color: blue
---

$BODY
EOF
run "$TMP_DIR/colon.md"
if [ $RC -eq 1 ] && has "ends with ':'"; then
  pass "value ending in ':' rejected"
else
  flunk "value ending in ':': exit $RC (expected 1 with an \"ends with ':'\" error)"
fi

cat > "$TMP_DIR/indented-colon.md" <<EOF
---
name: indented-colon-agent
description: Use this agent when the user asks for X. Examples
  <example>
  Context: c
  </example>
model: inherit
color: blue
---

$BODY
EOF
run "$TMP_DIR/indented-colon.md"
if [ $RC -eq 1 ] && has "continuation line contains ': '"; then
  pass "indented plain continuation with ': ' rejected"
else
  flunk "indented plain continuation with ': ': exit $RC (expected 1)"
fi

# 4. Valid but fragile shapes must NOT be rejected (they load): a plain multi-line value
#    without ': ', and a single unquoted line containing ': '.
cat > "$TMP_DIR/plain-multi.md" <<EOF
---
name: plain-multi-agent
description: Use this agent when the user asks for X. Examples
  <example>
  Context - c
  </example>
model: inherit
color: blue
---

$BODY
EOF
run "$TMP_DIR/plain-multi.md"
if [ $RC -eq 0 ] && has "⚠️" && ! has "❌"; then
  pass "plain multi-line value accepted with a warning"
else
  flunk "plain multi-line value: exit $RC (expected 0 with a warning, no error)"
fi

cat > "$TMP_DIR/single-colon.md" <<EOF
---
name: single-colon-agent
description: Use this agent when the user asks for X. Examples: <example>Context: c</example>
model: inherit
color: blue
---

$BODY
EOF
run "$TMP_DIR/single-colon.md"
if [ $RC -eq 0 ] && ! has "❌"; then
  pass "single line containing ': ' accepted"
else
  flunk "single line containing ': ': exit $RC (expected 0, no error)"
fi

# 5. Warnings only: exit 0 and a summary line (the abort regression).
cat > "$TMP_DIR/warnings.md" <<EOF
---
name: warnings-agent
description: |-
  This description has no trigger phrase and no example block.
model: inherit
color: blue
---

$BODY
EOF
run "$TMP_DIR/warnings.md"
if [ $RC -eq 0 ] && has "Validation passed with"; then
  pass "warnings-only file exits 0 with a summary"
else
  flunk "warnings-only file: exit $RC, summary present: $(has 'Validation passed with' && echo yes || echo no)"
fi

# 6. Optional field absent: tools is optional, so a file without it exits 0 with a summary.
#    (grep finds no tools line; under set -euo pipefail that used to end the script.)
cat > "$TMP_DIR/no-tools.md" <<EOF
---
name: no-tools-agent
description: |-
  Use this agent when the user asks for X. Examples: <example>Context: c</example>
model: inherit
color: blue
---

$BODY
EOF
run "$TMP_DIR/no-tools.md"
if [ $RC -eq 0 ] && has "tools: not specified"; then
  pass "file without a tools field exits 0"
else
  flunk "file without a tools field: exit $RC (expected 0 with the 'tools: not specified' note)"
fi

# 7. Invalid file still fails, and the missing field is NAMED (the same abort used to end the
#    script before the message).
cat > "$TMP_DIR/invalid.md" <<EOF
---
name: -bad-
description: |-
  Use this agent when the user asks for X. Examples: <example>Context: c</example>
model: inherit
---

$BODY
EOF
run "$TMP_DIR/invalid.md"
if [ $RC -eq 1 ] && has "Missing required field: color"; then
  pass "invalid file exits 1 and names the missing field"
else
  flunk "invalid file: exit $RC, missing-field message present: $(has 'Missing required field: color' && echo yes || echo no)"
fi

echo ""
if [ $fail -eq 0 ]; then
  echo "All tests passed"
  exit 0
else
  echo "Some tests failed"
  exit 1
fi
