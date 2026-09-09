#!/bin/bash
# Agent File Validator
#
# The parse verdict comes from Claude Code itself. The file is copied into a throwaway plugin
# directory and run through `claude plugin validate --json`, which reads frontmatter with the
# same parser as the runtime loader: Bun's YAML parser, plus Claude Code's one retry that
# quotes values containing a YAML indicator or `: ` and turns leading tabs into spaces. No
# YAML library reproduces that grammar and neither does a shell script, so this script does
# not carry a grammar of its own for the verdict.
#
# What the script adds on top of the product's verdict:
#   - required-field checks the product does not make: a null, empty, numeric or boolean
#     description passes `claude plugin validate`, but the project-agent loader drops the agent
#     as missing its description and a plugin agent shows a placeholder (or the digits);
#   - the description text the model will see, read the way the plugin loader reads it (block,
#     plain and quoted scalars folded per YAML, then trimmed), for the style checks: <example>
#     blocks, the "Use this agent when" trigger phrase and length. Project agents
#     (.claude/agents/) keep the untrimmed value and turn a literal \n into a newline; that
#     changes the reported length, not the verdicts.
#
# Exit codes: 0 valid (warnings allowed), 1 invalid, 2 frontmatter not verified (no `claude`
# on PATH, or it could not run; set CLAUDE_BIN to point at one).

set -euo pipefail

usage() {
  echo "Usage: $0 <path/to/agent.md>"
  echo "       $0 --description <path/to/agent.md>   print the description as the plugin loader reads it"
  echo ""
  echo "Validates agent file for:"
  echo "  - YAML frontmatter (verdict from 'claude plugin validate', the product's own parser)"
  echo "  - Required fields (name, description, model, color)"
  echo "  - Field formats and constraints"
  echo "  - System prompt presence and length"
  echo "  - Example blocks in description"
  echo ""
  echo "Environment: CLAUDE_BIN  path to the claude executable (default: claude on PATH)"
  exit 1
}

PRINT_DESCRIPTION=0
if [ "${1:-}" = "--description" ]; then
  PRINT_DESCRIPTION=1
  shift
fi
[ $# -eq 1 ] || usage
AGENT_FILE="$1"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

# ---------------------------------------------------------------------------------------------
# Description extraction, the plugin loader's way.
#
# Input: the frontmatter lines with CR and BOM removed. Output: line 1 "KIND=<kind>", then the
# description text. Kinds: absent, empty, list, mapping, unterminated, block, plain, double,
# single. The text is the YAML value (block scalars with their chomping, plain and quoted
# scalars folded, double-quoted escapes decoded) followed by the plugin loader's trim().
#
# Two product behaviours are reproduced on purpose. Leading tabs count as two spaces each,
# because a tab-led line fails Bun's parse and Claude Code's retry rewrites it that way. A
# plain value that starts with @ ` % * or contains ': ' is taken verbatim, because such a
# value also fails the first parse and the retry re-parses the whole line as a quoted string
# (a ' #' comment inside it becomes text). When the first parse fails for another reason the
# retry quotes every value containing an indicator character, which can pull a ' #' comment
# into the text; that case is not modelled.
# ---------------------------------------------------------------------------------------------
read_description() {
  LC_ALL=C awk '
    function rtrim(s) { sub(/[ \t]+$/, "", s); return s }
    function ltrim(s) { sub(/^[ \t]+/, "", s); return s }
    function repeat(s, k,    r) { r = ""; while (k-- > 0) r = r s; return r }
    function strip_comment(s) { if (match(s, /[ \t]#/)) s = substr(s, 1, RSTART - 1); return s }
    function hex2dec(h,    i, d, c) {
      d = 0
      for (i = 1; i <= length(h); i++) { c = index("0123456789abcdef", tolower(substr(h, i, 1))) - 1; d = d * 16 + c }
      return d
    }
    function utf8(code) {
      if (code < 128) return sprintf("%c", code)
      if (code < 2048) return sprintf("%c%c", 192 + int(code / 64), 128 + code % 64)
      if (code < 65536) return sprintf("%c%c%c", 224 + int(code / 4096), 128 + int(code / 64) % 64, 128 + code % 64)
      return sprintf("%c%c%c%c", 240 + int(code / 262144), 128 + int(code / 4096) % 64, 128 + int(code / 64) % 64, 128 + code % 64)
    }
    # closing quote on one physical line, honouring \" (double) and '"'"''"'"' (single)
    function closes(s,    i, c) {
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (q == "\"" && c == "\\") { i++; continue }
        if (c == q) {
          if (q == "\047" && substr(s, i + 1, 1) == "\047") { i++; continue }
          return 1
        }
      }
      return 0
    }
    BEGIN { state = "seek"; kind = "absent"; n = 0; first = ""; first_set = 0; verbatim = 0; style = ""; chomp = "clip"; ind = 0; raw = ""; q = "" }
    { while (substr($0, 1, 1) == "\t") $0 = "  " substr($0, 2) }
    state == "seek" {
      if ($0 !~ /^description:([ \t]|$)/) next
      val = $0; sub(/^description:[ \t]*/, "", val)
      while (val ~ /^[&!][^ \t]*([ \t]+|$)/) sub(/^[&!][^ \t]*[ \t]*/, "", val)
      if (val ~ /^#/ || val == "") { kind = "plain"; state = "plain"; next }
      if (val ~ /^[|>]/) {
        kind = "block"; style = substr(val, 1, 1); hdr = substr(val, 2)
        hdr = rtrim(strip_comment(" " hdr))
        if (hdr ~ /-/) chomp = "strip"; else if (hdr ~ /\+/) chomp = "keep"
        if (match(hdr, /[1-9]/)) ind = substr(hdr, RSTART, 1) + 0
        state = "block"; next
      }
      if (val ~ /^"/) { kind = "double"; q = "\""; raw = substr(val, 2); state = closes(raw) ? "done" : "quoted"; next }
      if (val ~ /^\047/) { kind = "single"; q = "\047"; raw = substr(val, 2); state = closes(raw) ? "done" : "quoted"; next }
      if (val ~ /^\[/) { kind = "list"; state = "done"; next }
      if (val ~ /^\{/) { kind = "mapping"; state = "done"; next }
      kind = "plain"; first = val; first_set = 1
      if (val ~ /^[@`%*]/ || val ~ /: /) { verbatim = 1; state = "done"; next }
      state = "plain"; next
    }
    state == "block" || state == "plain" {
      if ($0 ~ /^[ \t]*$/ || $0 ~ /^[ \t]/) { body[n++] = $0; next }
      state = "done"; next
    }
    state == "quoted" {
      raw = raw "\n" $0
      if (closes($0)) state = "done"
      next
    }
    END {
      out = ""
      if (kind == "block") {
        if (ind == 0) for (i = 0; i < n; i++) if (body[i] !~ /^[ \t]*$/) { match(body[i], /^ */); ind = RLENGTH; break }
        m = 0
        for (i = 0; i < n; i++) {
          l = body[i]
          if (l ~ /^ *$/ && length(l) <= ind) { txt[m++] = ""; continue }
          if (length(l) >= ind && substr(l, 1, ind) ~ /^ *$/) { txt[m++] = substr(l, ind + 1); continue }
          break
        }
        t = 0; while (m - t > 0 && txt[m - t - 1] == "") t++
        if (style == "|") {
          for (i = 0; i < m - t; i++) out = out (i ? "\n" : "") txt[i]
        } else {
          started = 0; pend = 0; prev_more = 0
          for (i = 0; i < m - t; i++) {
            l = txt[i]
            if (l == "") { pend++; continue }
            more = (l ~ /^[ \t]/)
            if (!started) { out = repeat("\n", pend) l; started = 1 }
            else out = out ((prev_more || more) ? "\n" : (pend > 0 ? "" : " ")) repeat("\n", pend) l
            prev_more = more; pend = 0
          }
        }
        if (out != "") { if (chomp == "clip") out = out "\n"; else if (chomp == "keep") out = out repeat("\n", t + 1) }
      } else if (kind == "plain" && verbatim) {
        out = first
      } else if (kind == "plain") {
        started = 0; pend = 0
        if (first_set) { f = rtrim(strip_comment(first)); if (f != "") { out = f; started = 1 } }
        else {
          for (i = 0; i < n; i++) if (body[i] !~ /^[ \t]*$/) {
            if (body[i] ~ /^[ \t]*-([ \t]|$)/) kind = "mapping-or-list"
            else if (body[i] ~ /^[ \t]*[^ \t#"\047][^ \t]*:([ \t]|$)/) kind = "mapping"
            break
          }
          if (kind == "mapping-or-list") kind = "list"
        }
        if (kind == "plain") for (i = 0; i < n; i++) {
          l = body[i]
          if (l ~ /^[ \t]*$/) { if (started) pend++; continue }
          l = ltrim(l); c = strip_comment(l); commented = (c != l); c = rtrim(c)
          if (c != "") { if (!started) { out = c; started = 1 } else out = out (pend > 0 ? repeat("\n", pend) : " ") c; pend = 0 }
          if (commented) break
        }
        if (kind == "plain" && !started) kind = "empty"
      } else if (kind == "double" || kind == "single") {
        L = length(raw); endpos = 0
        for (i = 1; i <= L; i++) {
          c = substr(raw, i, 1)
          if (kind == "double" && c == "\\") { i++; continue }
          if (c == q) {
            if (kind == "single" && substr(raw, i + 1, 1) == "\047") { i++; continue }
            endpos = i; break
          }
        }
        if (endpos == 0) kind = "unterminated"
        else {
          s = substr(raw, 1, endpos - 1); L = length(s); i = 1
          while (i <= L) {
            c = substr(s, i, 1)
            if (kind == "double" && c == "\\") {
              d = substr(s, i + 1, 1)
              if (d == "\n") { i += 2; while (i <= L && substr(s, i, 1) ~ /[ \t]/) i++; continue }
              if (d == "n") out = out "\n"
              else if (d == "t") out = out "\t"
              else if (d == "r") out = out "\r"
              else if (d == "\"" || d == "\\" || d == "/" || d == " ") out = out d
              else if (d == "x" || d == "u" || d == "U") {
                k = (d == "x") ? 2 : (d == "u") ? 4 : 8
                h = substr(s, i + 2, k)
                if (length(h) == k && h ~ /^[0-9a-fA-F]+$/) { out = out utf8(hex2dec(h)); i += 2 + k; continue }
                out = out "\\" d
              }
              else out = out "\\" d
              i += 2; continue
            }
            if (kind == "single" && c == "\047") { out = out "\047"; i += 2; continue }
            if (c == "\n") {
              out = rtrim(out)
              k = 0; j = i + 1
              while (1) {
                while (j <= L && substr(s, j, 1) ~ /[ \t]/) j++
                if (j <= L && substr(s, j, 1) == "\n") { k++; j++; continue }
                break
              }
              out = out (k > 0 ? repeat("\n", k) : " ")
              i = j; continue
            }
            out = out c; i++
          }
        }
      }
      # the plugin loader: description.trim() || null
      sub(/^[ \t\n\r]+/, "", out); sub(/[ \t\n\r]+$/, "", out)
      if ((kind == "block" || kind == "double" || kind == "single" || kind == "plain") && out == "") kind = "empty"
      cont = 0
      if (kind == "plain") for (i = 0; i < n; i++) if (body[i] !~ /^[ \t]*$/) cont++
      # A one-line plain scalar that the YAML 1.2 core schema resolves to a number, boolean or
      # null is not a string: the project-agent loader drops the agent, a plugin agent shows
      # the JavaScript value (0x1f as 31, .inf as Infinity).
      if (kind == "plain" && cont == 0 && !verbatim) {
        if (out ~ /^(null|Null|NULL|~)$/) kind = "null"
        else if (out ~ /^(true|True|TRUE|false|False|FALSE)$/) kind = "boolean"
        else if (out ~ /^([-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/ || out ~ /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/ || out ~ /^([-+]?\.(inf|Inf|INF)|\.(nan|NaN|NAN))$/) kind = "number"
      }
      print "KIND=" kind " LINES=" cont
      if (out != "") print out
    }
  '
}

# ---------------------------------------------------------------------------------------------
# The product's verdict: `claude plugin validate --json` over a throwaway plugin holding a copy
# of the file. Sets PRODUCT_STATUS (verified | not-verified), PRODUCT_REASON,
# PRODUCT_ERRORS and PRODUCT_WARNINGS (one "path: message" per line).
# ---------------------------------------------------------------------------------------------
PRODUCT_STATUS="not-verified"; PRODUCT_REASON=""; PRODUCT_ERRORS=""; PRODUCT_WARNINGS=""
product_verdict() {
  if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    PRODUCT_REASON="'$CLAUDE_BIN' not found on PATH"
    return 0
  fi
  local tmp base out rc parsed
  tmp=$(mktemp -d 2>/dev/null) || { PRODUCT_REASON="could not create a temporary directory"; return 0; }
  base=$(basename "$AGENT_FILE")
  mkdir -p "$tmp/.claude-plugin" "$tmp/agents"
  printf '{"name":"validate-agent-check"}\n' > "$tmp/.claude-plugin/plugin.json"
  cp "$AGENT_FILE" "$tmp/agents/$base"

  out=$("$CLAUDE_BIN" plugin validate "$tmp" --json 2>&1) && rc=0 || rc=$?
  parsed=0
  if command -v jq >/dev/null 2>&1 && printf '%s' "$out" | jq -e . >/dev/null 2>&1; then
    parsed=1
    if [ "$(printf '%s' "$out" | jq -r '.manifest.errors | length')" != "0" ]; then
      PRODUCT_REASON="the validator refused the temporary plugin: $(printf '%s' "$out" | jq -r '.manifest.errors[0].message')"
      rm -rf "$tmp"; return 0
    fi
    PRODUCT_ERRORS=$(printf '%s' "$out" | jq -r '.contents[]? | select(.type == "agent") | .errors[]? | "\(.path): \(.message)"')
    PRODUCT_WARNINGS=$(printf '%s' "$out" | jq -r '.contents[]? | select(.type == "agent") | .warnings[]? | "\(.path): \(.message)"')
  fi
  if [ $parsed -eq 0 ]; then
    # No jq, or a Claude Code older than 2.1.259 (no --json): read the plain report. Items are
    # "  ❯ path: message" lines under the "Validating agent: <file>" section.
    out=$("$CLAUDE_BIN" plugin validate "$tmp" 2>&1) && rc=0 || rc=$?
    if ! printf '%s\n' "$out" | LC_ALL=C awk '/^Validating /{found=1} END{exit !found}'; then
      PRODUCT_REASON="'$CLAUDE_BIN plugin validate' did not run: $(printf '%s\n' "$out" | head -1)"
      rm -rf "$tmp"; return 0
    fi
    local items
    items=$(printf '%s\n' "$out" | LC_ALL=C awk -v base="/agents/$base" '
      /^Validating agent: / { insec = (index($0, base) > 0); next }
      /^Validating / { insec = 0; next }
      /Found [0-9]+ error/ { k = "E" }
      /Found [0-9]+ warning/ { k = "W" }
      /^[ \t]*❯ / { if (insec) { sub(/^[ \t]*❯ /, ""); print k "\t" $0 } }')
    PRODUCT_ERRORS=$(printf '%s\n' "$items" | LC_ALL=C awk -F'\t' '$1 == "E" { print $2 }')
    PRODUCT_WARNINGS=$(printf '%s\n' "$items" | LC_ALL=C awk -F'\t' '$1 == "W" { print $2 }')
  fi
  rm -rf "$tmp"
  PRODUCT_STATUS="verified"
  return 0
}

# ---------------------------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------------------------
if [ $PRINT_DESCRIPTION -eq 0 ]; then
  echo "🔍 Validating agent file: $AGENT_FILE"
  echo ""
fi
say() { [ $PRINT_DESCRIPTION -eq 0 ] && echo "$@"; return 0; }

# Check 1: File exists
if [ ! -f "$AGENT_FILE" ]; then
  echo "❌ File not found: $AGENT_FILE"
  exit 1
fi
say "✅ File exists"

# The loader strips a UTF-8 BOM and treats CRLF line ends as line ends; read the file that way.
BOM=$(printf '\357\273\277')
CONTENT=$(tr -d '\r' < "$AGENT_FILE")
HAS_CR=0; HAS_BOM=0
if [ "${CONTENT#"$BOM"}" != "$CONTENT" ]; then HAS_BOM=1; CONTENT=${CONTENT#"$BOM"}; fi
if tr -d '\n' < "$AGENT_FILE" | LC_ALL=C awk 'index($0, "\r") { found = 1 } END { exit !found }'; then HAS_CR=1; fi

# Check 2: Starts with ---
FIRST_LINE=$(printf '%s\n' "$CONTENT" | head -1)
if ! [[ "$FIRST_LINE" =~ ^---[[:space:]]*$ ]]; then
  echo "❌ File must start with YAML frontmatter (---)"
  exit 1
fi
say "✅ Starts with frontmatter"

# Check 3: Has closing ---
if ! printf '%s\n' "$CONTENT" | tail -n +2 | grep -q '^---[[:space:]]*$'; then
  echo "❌ Frontmatter not closed (missing second ---)"
  exit 1
fi
say "✅ Frontmatter properly closed"
[ $HAS_CR -eq 1 ] && say "💡 File uses CRLF line endings (loaded fine; LF is the convention)"
[ $HAS_BOM -eq 1 ] && say "💡 File starts with a UTF-8 byte order mark (loaded fine; not needed)"

# Extract frontmatter and system prompt
FRONTMATTER=$(printf '%s\n' "$CONTENT" | awk 'NR==1{next} /^---[[:space:]]*$/{exit} {print}')
SYSTEM_PROMPT=$(printf '%s\n' "$CONTENT" | awk '/^---[[:space:]]*$/{i++; next} i>=2')

DESC_OUT=$(printf '%s\n' "$FRONTMATTER" | read_description)
DESC_META=${DESC_OUT%%$'\n'*}
if [ "$DESC_META" = "$DESC_OUT" ]; then DESCRIPTION=""; else DESCRIPTION=${DESC_OUT#*$'\n'}; fi
DESC_KIND="absent"; DESC_LINES=0
if [[ "$DESC_META" =~ ^KIND=([a-z-]+)\ LINES=([0-9]+)$ ]]; then
  DESC_KIND="${BASH_REMATCH[1]}"; DESC_LINES="${BASH_REMATCH[2]}"
fi

if [ $PRINT_DESCRIPTION -eq 1 ]; then
  case "$DESC_KIND" in
    block|plain|double|single) printf '%s\n' "$DESCRIPTION"; exit 0 ;;
    *) echo "description: $DESC_KIND" >&2; exit 1 ;;
  esac
fi

# Check 4: Frontmatter parse — the product's verdict
echo ""
echo "Checking frontmatter with 'claude plugin validate'..."
product_verdict
PARSE_FAILED=0; DESC_PRODUCT_ERROR=0; error_count=0; warning_count=0
if [ "$PRODUCT_STATUS" = "verified" ]; then
  if [ -z "$PRODUCT_ERRORS" ]; then
    echo "✅ Frontmatter parses (claude plugin validate)"
  else
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      echo "❌ $line"
      error_count=$((error_count + 1))
      case "$line" in
        frontmatter:*) PARSE_FAILED=1 ;;
        description:*) DESC_PRODUCT_ERROR=1 ;;
      esac
    done <<< "$PRODUCT_ERRORS"
    [ $PARSE_FAILED -eq 1 ] && echo "   Write multi-line descriptions as a block scalar (description: |-) with every line of the value indented two spaces; see the agent-development skill."
  fi
  if [ -n "$PRODUCT_WARNINGS" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      echo "⚠️  $line"
      warning_count=$((warning_count + 1))
    done <<< "$PRODUCT_WARNINGS"
  fi
else
  echo "⚠️  Frontmatter not verified: $PRODUCT_REASON"
  echo "   The parse verdict comes from Claude Code's own validator; install Claude Code or set CLAUDE_BIN."
fi

# Check 5: Required fields
echo ""
echo "Checking required fields..."

# Field extraction: grep exits 1 when a field is absent, and under `set -euo pipefail` that
# would end the script before the "Missing required field" message below is reached, so each
# pipeline is allowed to fail.

# Check name field
NAME=$(printf '%s\n' "$FRONTMATTER" | grep '^name:' | sed 's/name: *//' | sed 's/^"\(.*\)"$/\1/' || true)

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

# Check description field. The product has ruled on the syntax; this is about the value.
if [ $PARSE_FAILED -eq 1 ]; then
  echo "⏭️  description: not checked (frontmatter does not parse)"
elif [ $DESC_PRODUCT_ERROR -eq 1 ]; then
  echo "⏭️  description: not checked (see the error above)"
else
  case "$DESC_KIND" in
    absent)
      echo "❌ Missing required field: description"
      error_count=$((error_count + 1)) ;;
    empty|null)
      echo "❌ description is empty — a project agent is dropped as missing its description; a plugin agent shows 'Agent from <plugin> plugin'"
      error_count=$((error_count + 1)) ;;
    list|mapping)
      echo "❌ description is a YAML $DESC_KIND, not text — the loader drops it. Write the text as a block scalar: description: |-"
      error_count=$((error_count + 1)) ;;
    unterminated)
      echo "❌ description is a quoted value with no closing quote"
      error_count=$((error_count + 1)) ;;
    number|boolean)
      echo "❌ description reads as a YAML $DESC_KIND ($DESCRIPTION), not text — a project agent is dropped as missing its description; quote it or write it as a block scalar"
      error_count=$((error_count + 1)) ;;
    *)
      {
        desc_length=${#DESCRIPTION}
        echo "✅ description: ${desc_length} characters (${DESC_KIND} scalar, as the plugin loader reads it)"

        case "$DESC_KIND" in
          plain)
            if [ "$DESC_LINES" -gt 0 ]; then
              echo "⚠️  description is a multi-line plain value; prefer description: |- (a 'Context:' line or a value ending in ':' would make the file unparseable)"
              warning_count=$((warning_count + 1))
            fi
            case "$DESCRIPTION" in
              *': '*)
                echo "⚠️  description is an unquoted single line containing ': '; Claude Code loads it through its retry path, strict YAML parsers reject it — prefer description: |-"
                warning_count=$((warning_count + 1)) ;;
            esac
            case "$DESCRIPTION" in
              *'\n'*) echo "💡 description contains a literal \\n: a plugin agent shows those two characters, a project agent gets a newline" ;;
            esac ;;
          single)
            case "$DESCRIPTION" in
              *'\n'*) echo "💡 description contains a literal \\n: a plugin agent shows those two characters, a project agent gets a newline" ;;
            esac ;;
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
        case "$(printf '%s' "$DESCRIPTION" | tr '[:upper:]' '[:lower:]')" in
          *"use this agent when"*) ;;
          *)
            echo "⚠️  description should start with 'Use this agent when...'"
            warning_count=$((warning_count + 1)) ;;
        esac
      } ;;
  esac
fi

# Check model field
MODEL=$(printf '%s\n' "$FRONTMATTER" | grep '^model:' | sed 's/model: *//' || true)

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
COLOR=$(printf '%s\n' "$FRONTMATTER" | grep '^color:' | sed 's/color: *//' || true)

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
TOOLS=$(printf '%s\n' "$FRONTMATTER" | grep '^tools:' | sed 's/tools: *//' || true)

if [ -n "$TOOLS" ]; then
  echo "✅ tools: $TOOLS"
else
  echo "💡 tools: not specified (agent has access to all tools)"
fi

# Check 6: System prompt
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
  if ! printf '%s\n' "$SYSTEM_PROMPT" | grep -q "You are\|You will\|Your"; then
    echo "⚠️  System prompt should use second person (You are..., You will...)"
    warning_count=$((warning_count + 1))
  fi

  # Check for structure
  if ! printf '%s\n' "$SYSTEM_PROMPT" | grep -qi "responsibilities\|process\|steps"; then
    echo "💡 Consider adding clear responsibilities or process steps"
  fi

  if ! printf '%s\n' "$SYSTEM_PROMPT" | grep -qi "output"; then
    echo "💡 Consider defining output format expectations"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ $error_count -gt 0 ]; then
  echo "❌ Validation failed with $error_count error(s) and $warning_count warning(s)"
  exit 1
elif [ "$PRODUCT_STATUS" != "verified" ]; then
  echo "⚠️  Validation incomplete: frontmatter not verified ($warning_count warning(s))"
  exit 2
elif [ $warning_count -eq 0 ]; then
  echo "✅ All checks passed!"
  exit 0
else
  echo "⚠️  Validation passed with $warning_count warning(s)"
  exit 0
fi
