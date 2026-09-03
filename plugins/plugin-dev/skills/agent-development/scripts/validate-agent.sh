#!/bin/bash
# Agent File Validator
# Validates agent markdown files for correct structure and content

set -euo pipefail

# Usage
if [ $# -eq 0 ]; then
  echo "Usage: $0 <path/to/agent.md>"
  echo ""
  echo "Validates agent file for:"
  echo "  - YAML frontmatter structure"
  echo "  - Required fields (name, description, model, color)"
  echo "  - Field formats and constraints"
  echo "  - System prompt presence and length"
  echo "  - Example blocks in description"
  exit 1
fi

AGENT_FILE="$1"

echo "🔍 Validating agent file: $AGENT_FILE"
echo ""

# Check 1: File exists
if [ ! -f "$AGENT_FILE" ]; then
  echo "❌ File not found: $AGENT_FILE"
  exit 1
fi
echo "✅ File exists"

# Check 2: Starts with ---
FIRST_LINE=$(head -1 "$AGENT_FILE")
if [ "$FIRST_LINE" != "---" ]; then
  echo "❌ File must start with YAML frontmatter (---)"
  exit 1
fi
echo "✅ Starts with frontmatter"

# Check 3: Has closing ---
if ! tail -n +2 "$AGENT_FILE" | grep -q '^---$'; then
  echo "❌ Frontmatter not closed (missing second ---)"
  exit 1
fi
echo "✅ Frontmatter properly closed"

# Extract frontmatter and system prompt
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$AGENT_FILE")
SYSTEM_PROMPT=$(awk '/^---$/{i++; next} i>=2' "$AGENT_FILE")

# Check 4: Required fields
echo ""
echo "Checking required fields..."

error_count=0
warning_count=0

# Field extraction: grep exits 1 when a field is absent, and under `set -euo pipefail` that
# would end the script before the "Missing required field" message below is reached, so each
# pipeline is allowed to fail.

# Check name field
NAME=$(echo "$FRONTMATTER" | grep '^name:' | sed 's/name: *//' | sed 's/^"\(.*\)"$/\1/' || true)

if [ -z "$NAME" ]; then
  echo "❌ Missing required field: name"
  error_count=$((error_count + 1))
else
  echo "✅ name: $NAME"

  # Validate name format
  if ! [[ "$NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$ ]]; then
    echo "❌ name must start/end with alphanumeric and contain only letters, numbers, hyphens"
    error_count=$((error_count + 1))
  fi

  # Validate name length
  name_length=${#NAME}
  if [ $name_length -lt 3 ]; then
    echo "❌ name too short (minimum 3 characters)"
    error_count=$((error_count + 1))
  elif [ $name_length -gt 50 ]; then
    echo "❌ name too long (maximum 50 characters)"
    error_count=$((error_count + 1))
  fi

  # Check for generic names
  if [[ "$NAME" =~ ^(helper|assistant|agent|tool)$ ]]; then
    echo "⚠️  name is too generic: $NAME"
    warning_count=$((warning_count + 1))
  fi
fi

# Check description field
#
# Read the description the way a YAML parser reads it, and classify its syntax. The
# description is the field that carries multi-line <example> blocks, and the shapes that
# LOOK fine but fail to parse were measured against Claude Code's loader: a value ending
# in ':' (e.g. "... Examples:"), a value continued on unindented lines (e.g. "<example>"),
# and an indented plain-scalar continuation containing ': ' all make the frontmatter
# unparseable, after which the agent is ignored (or registered with a placeholder
# description when it ships in a plugin). Only block scalars (|, |-, >, >-) are safe for
# multi-line text, so that is what the checks steer towards.
#
# Output: line 1 "MODE=<mode> FATAL=<code> WARN=<code>", then the description text.
DESC_OUT=$(echo "$FRONTMATTER" | awk '
  BEGIN { mode=""; fatal="none"; warn="none"; state=0; indent=-1; nbuf=0 }
  state==0 && /^description:/ {
    val=$0; sub(/^description:[[:space:]]*/, "", val)
    if (val ~ /^[|>]/) { mode="block"; state=1; next }
    if (val ~ /^["\047]/) {
      mode="quoted"; sub(/^["\047]/, "", val); sub(/["\047][[:space:]]*$/, "", val)
      buf[nbuf++]=val; state=3; next
    }
    mode="plain-single"
    if (val ~ /:$/) fatal="trailing-colon"
    else if (val ~ /: /) warn="colon-space"
    buf[nbuf++]=val; state=2; next
  }
  state==1 {
    # block scalar body: blank or indented lines; the first non-blank line fixes the indent
    if ($0 ~ /^[[:space:]]*$/) { buf[nbuf++]=""; next }
    if ($0 !~ /^ /) { state=3; next }
    match($0, /^ */)
    if (indent < 0) indent=RLENGTH
    if (RLENGTH < indent) { fatal="inconsistent-indent"; state=3; next }
    buf[nbuf++]=substr($0, indent+1); next
  }
  state==2 {
    # after a plain value: blank lines, indented continuation lines, or the next key
    if ($0 ~ /^[[:space:]]*$/) { buf[nbuf++]=""; next }
    if ($0 ~ /^ /) {
      mode="plain-multi"
      if (warn=="none") warn="plain-multi"
      line=$0; sub(/^ +/, "", line)
      if (fatal=="none" && (line ~ /: / || line ~ /:$/)) fatal="colon-in-continuation"
      buf[nbuf++]=line; next
    }
    if ($0 ~ /^[A-Za-z_][A-Za-z0-9_-]*:([[:space:]]|$)/) { state=3; next }
    if (fatal=="none") fatal="unindented-continuation"
    state=3; next
  }
  END {
    while (nbuf > 0 && buf[nbuf-1] == "") nbuf--
    printf "MODE=%s FATAL=%s WARN=%s\n", mode, fatal, warn
    for (i=0; i<nbuf; i++) print buf[i]
  }
')
DESC_META=${DESC_OUT%%$'\n'*}
if [ "$DESC_META" = "$DESC_OUT" ]; then
  DESCRIPTION=""
else
  DESCRIPTION=${DESC_OUT#*$'\n'}
fi
DESC_MODE=""; DESC_FATAL="none"; DESC_WARN="none"
if [[ "$DESC_META" =~ ^MODE=([a-z-]*)\ FATAL=([a-z-]+)\ WARN=([a-z-]+)$ ]]; then
  DESC_MODE="${BASH_REMATCH[1]}"; DESC_FATAL="${BASH_REMATCH[2]}"; DESC_WARN="${BASH_REMATCH[3]}"
fi

if [ -z "$DESCRIPTION" ]; then
  echo "❌ Missing required field: description"
  error_count=$((error_count + 1))
else
  desc_length=${#DESCRIPTION}
  echo "✅ description: ${desc_length} characters (${DESC_MODE})"

  case "$DESC_FATAL" in
    none) ;;
    trailing-colon)
      echo "❌ description ends with ':' — the YAML parser rejects this and the agent is not loaded. Write the value as a block scalar: description: |-"
      error_count=$((error_count + 1)) ;;
    unindented-continuation)
      echo "❌ description continues on unindented lines (e.g. <example>) — not valid YAML; the agent is not loaded. Use description: |- and indent every line of the value by two spaces"
      error_count=$((error_count + 1)) ;;
    colon-in-continuation)
      echo "❌ description continuation line contains ': ' — invalid inside a plain multi-line value; use description: |-"
      error_count=$((error_count + 1)) ;;
    inconsistent-indent)
      echo "❌ description block scalar has a line indented less than its first line"
      error_count=$((error_count + 1)) ;;
  esac

  case "$DESC_WARN" in
    colon-space)
      echo "⚠️  description is an unquoted single line containing ': '; strict YAML parsers reject this — prefer description: |-"
      warning_count=$((warning_count + 1)) ;;
    plain-multi)
      echo "⚠️  description is a multi-line plain value; prefer description: |- (a 'Context:' line would break parsing)"
      warning_count=$((warning_count + 1)) ;;
  esac

  if [ $desc_length -lt 10 ]; then
    echo "⚠️  description too short (minimum 10 characters recommended)"
    warning_count=$((warning_count + 1))
  elif [ $desc_length -gt 5000 ]; then
    echo "⚠️  description very long (over 5000 characters)"
    warning_count=$((warning_count + 1))
  fi

  # Check for example blocks
  case "$DESCRIPTION" in
    *"<example>"*) ;;
    *)
      echo "⚠️  description should include <example> blocks for triggering"
      warning_count=$((warning_count + 1)) ;;
  esac

  # Check for "Use this agent when" pattern
  case "${DESCRIPTION,,}" in
    *"use this agent when"*) ;;
    *)
      echo "⚠️  description should start with 'Use this agent when...'"
      warning_count=$((warning_count + 1)) ;;
  esac
fi

# Check model field
MODEL=$(echo "$FRONTMATTER" | grep '^model:' | sed 's/model: *//' || true)

if [ -z "$MODEL" ]; then
  echo "❌ Missing required field: model"
  error_count=$((error_count + 1))
else
  echo "✅ model: $MODEL"

  case "$MODEL" in
    inherit|sonnet|opus|haiku)
      # Valid model
      ;;
    *)
      echo "⚠️  Unknown model: $MODEL (valid: inherit, sonnet, opus, haiku)"
      warning_count=$((warning_count + 1))
      ;;
  esac
fi

# Check color field
COLOR=$(echo "$FRONTMATTER" | grep '^color:' | sed 's/color: *//' || true)

if [ -z "$COLOR" ]; then
  echo "❌ Missing required field: color"
  error_count=$((error_count + 1))
else
  echo "✅ color: $COLOR"

  case "$COLOR" in
    blue|cyan|green|yellow|magenta|red)
      # Valid color
      ;;
    *)
      echo "⚠️  Unknown color: $COLOR (valid: blue, cyan, green, yellow, magenta, red)"
      warning_count=$((warning_count + 1))
      ;;
  esac
fi

# Check tools field (optional)
TOOLS=$(echo "$FRONTMATTER" | grep '^tools:' | sed 's/tools: *//' || true)

if [ -n "$TOOLS" ]; then
  echo "✅ tools: $TOOLS"
else
  echo "💡 tools: not specified (agent has access to all tools)"
fi

# Check 5: System prompt
echo ""
echo "Checking system prompt..."

if [ -z "$SYSTEM_PROMPT" ]; then
  echo "❌ System prompt is empty"
  error_count=$((error_count + 1))
else
  prompt_length=${#SYSTEM_PROMPT}
  echo "✅ System prompt: $prompt_length characters"

  if [ $prompt_length -lt 20 ]; then
    echo "❌ System prompt too short (minimum 20 characters)"
    error_count=$((error_count + 1))
  elif [ $prompt_length -gt 10000 ]; then
    echo "⚠️  System prompt very long (over 10,000 characters)"
    warning_count=$((warning_count + 1))
  fi

  # Check for second person
  if ! echo "$SYSTEM_PROMPT" | grep -q "You are\|You will\|Your"; then
    echo "⚠️  System prompt should use second person (You are..., You will...)"
    warning_count=$((warning_count + 1))
  fi

  # Check for structure
  if ! echo "$SYSTEM_PROMPT" | grep -qi "responsibilities\|process\|steps"; then
    echo "💡 Consider adding clear responsibilities or process steps"
  fi

  if ! echo "$SYSTEM_PROMPT" | grep -qi "output"; then
    echo "💡 Consider defining output format expectations"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ $error_count -eq 0 ] && [ $warning_count -eq 0 ]; then
  echo "✅ All checks passed!"
  exit 0
elif [ $error_count -eq 0 ]; then
  echo "⚠️  Validation passed with $warning_count warning(s)"
  exit 0
else
  echo "❌ Validation failed with $error_count error(s) and $warning_count warning(s)"
  exit 1
fi
