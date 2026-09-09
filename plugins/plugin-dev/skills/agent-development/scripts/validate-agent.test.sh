#!/bin/bash
# Regression tests for validate-agent.sh.
#
# The script takes its parse verdict from Claude Code (`claude plugin validate`), so the suite
# asserts against the product rather than against the script's exit codes: it runs the product
# once over a corpus of description shapes and checks that the script's verdict for each file
# is the product's verdict plus the script's own required-field policy. The description text is
# checked against the text the model was observed to receive.
#
# Every check names the defect it pins, and each was seen FAILING against a validator that has
# that defect before it was accepted here:
#   own-grammar   the script decided parse-ability with an awk classifier of its own. With
#                 VALIDATOR pointed at PR #89404's script the corpus check below fails on 19 of
#                 44 shapes, at the previous version of this script on 20 of 44 (Claude Code
#                 2.1.266): false passes (an unterminated quote, a list, a number, a boolean, a
#                 null), a false error (a tab-indented continuation), and parse failures
#                 reported in the script's words rather than the product's
#   text          the description text differed from the runtime's: a multi-line double-quoted
#                 value read as its first line (a false <example> warning), an inline ' #'
#                 comment kept (a false <example> pass), a leading blank line kept, CRs kept
#   silent-pass   with no `claude` on PATH, or one that failed to run, the frontmatter was
#                 reported valid instead of unverified
#   crlf          a CRLF file was rejected at the first-line check although the loader reads it
#   abort         the first warning killed the script (((x++)) exits 1 under set -e), so no
#                 summary line was printed and warnings-only files exited 1
#   first-line    only the first line of a multi-line description was read
#   absorption    a stop-list extractor (stop at name|model|color|tools) folds any other key
#                 that follows the description into the description text
#   silent-abort  a file without a tools field (optional) or without a required field ended
#                 the script at the field's grep (exit 1, no message, no summary)
#
# Requirements: Claude Code 2.1.259 or newer on PATH (for `claude plugin validate --json`) and
# jq. Without them the suite FAILS; it never skips, because a skipped suite reads as green.
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
run() { OUT=$(bash "$VALIDATOR" "$@" 2>&1); RC=$?; }
has() { case "$OUT" in *"$1"*) return 0;; *) return 1;; esac; }
has_summary() { has "Validation passed" || has "All checks passed" || has "Validation failed" || has "Validation incomplete"; }
reported_length() {
  local n
  n=$(printf '%s\n' "$OUT" | sed -n 's/^✅ description: \([0-9]*\) characters.*/\1/p' | head -1)
  echo "${n:-0}"
}

# 0. Preconditions: the product, with --json, and jq.
CLAUDE=$(command -v claude || true)
if [ -z "$CLAUDE" ]; then
  echo "FAIL: 'claude' is not on PATH; the suite verifies against the product and cannot run"
  exit 1
fi
if ! "$CLAUDE" plugin validate --help 2>&1 | grep -q -- '--json'; then
  echo "FAIL: this Claude Code ($("$CLAUDE" --version 2>/dev/null | head -1)) has no 'claude plugin validate --json' (2.1.259+ needed)"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is not on PATH; the suite reads the product's JSON report with it"
  exit 1
fi

BODY="You are a test agent. Your responsibilities: follow the process steps and produce output."

# 1. The plugin's own agents: exit 0, a summary line, no error, and the whole description read.
#    Their descriptions run well past 1000 characters; a first-line or truncating extractor
#    reports 200-300.
for agent in "$PLUGIN_ROOT"/agents/*.md; do
  label="own agent $(basename "$agent")"
  run "$agent"
  if [ $RC -ne 0 ]; then flunk "$label: exit $RC"; continue; fi
  has_summary || { flunk "$label: no summary line (abort)"; continue; }
  has "❌" && { flunk "$label: error reported"; continue; }
  n=$(reported_length)
  [ "$n" -ge 1000 ] || { flunk "$label: description read as $n chars (first-line / truncation)"; continue; }
  pass "$label ($n chars)"
done

# 2. Corpus of description shapes. One agent file per shape, same body everywhere.
CORPUS="$TMP_DIR/corpus"
mkdir -p "$CORPUS/.claude-plugin" "$CORPUS/agents"
printf '{"name":"validate-agent-test"}\n' > "$CORPUS/.claude-plugin/plugin.json"
mk() { # mk NAME <<'E' ...description lines... E
  { printf -- '---\nname: %s\n' "$1"; cat; printf 'model: sonnet\ncolor: blue\n---\n\n%s\n' "$BODY"; } > "$CORPUS/agents/$1.md"
}
mk f01-plain-single <<'E'
description: Use this agent when the user asks for a test. Plain single line.
E
mk f02-plain-trailing-colon <<'E'
description: Use this agent when the user asks for a test. Examples:
E
mk f03-plain-colon-space <<'E'
description: Use this agent when the user asks for a test. Context: none
E
mk f04-plain-multi-indented <<'E'
description: Use this agent when the user asks for a test.
  Second line indented, no colons.
  <example>third</example>
E
mk f05-plain-multi-colon-in-continuation <<'E'
description: Use this agent when the user asks for a test.
  <example>
  Context: the user wants a test
  </example>
E
mk f06-plain-multi-unindented <<'E'
description: Use this agent when the user asks for a test.
<example>
Context: the user wants a test
</example>
E
mk f07-block-literal-strip <<'E'
description: |-
  Use this agent when the user asks for a test.

  <example>
  Context: the user wants a test
  user: "run a test"
  assistant: "I'll use the test agent"
  </example>
E
mk f08-block-inconsistent-indent <<'E'
description: |-
    Use this agent when the user asks for a test.
  <example>less indented</example>
E
mk f09-block-extra-indent <<'E'
description: |-
  Use this agent when the user asks for a test.
    <example>more indented</example>
E
mk f10-block-keep <<'E'
description: |
  Use this agent when the user asks for a test.
  <example>x</example>
E
mk f11-folded-strip <<'E'
description: >-
  Use this agent when the user asks for a test.
  <example>x</example>
E
mk f12-dq-single <<'E'
description: "Use this agent when the user asks for a test. Context: quoted"
E
mk f13-dq-multi <<'E'
description: "Use this agent when the user asks for a test.
  <example>Context: second line</example>"
E
mk f14-dq-escape-newline <<'E'
description: "Use this agent when the user asks for a test.\n<example>x</example>"
E
mk f15-dq-unterminated <<'E'
description: "Use this agent when the user asks for a test
E
mk f16-sq-escaped-apostrophe <<'E'
description: 'Use this agent when it''s a test. <example>x</example>'
E
mk f17-plain-hash-comment <<'E'
description: Use this agent when the user asks for a test # <example>not part of value</example>
E
mk f18-plain-at-indicator <<'E'
description: @use this agent when the user asks for a test
E
mk f19-empty-then-key <<'E'
description:
E
mk f20-block-empty <<'E'
description: |-
E
mk f21-list-value <<'E'
description:
  - Use this agent when the user asks for a test
E
mk f22-yes-boolean <<'E'
description: yes
E
mk f23-number <<'E'
description: 12345678901
E
mk f24-absorption-permissionMode <<'E'
description: Use this agent when the user asks for a test. Eighty chars of text here..
permissionMode: acceptEdits
maxTurns: 5
E
mk f25-plain-multi-blank-line <<'E'
description: Use this agent when the user asks for a test.

  <example>after blank line</example>
E
mk f26-plain-multi-trailing-colon-continuation <<'E'
description: Use this agent when the user asks for a test.
  <example>
  Context:
  </example>
E
printf -- '---\nname: f27-tab-continuation\ndescription: Use this agent when the user asks for a test.\n\t<example>tab indented</example>\nmodel: sonnet\ncolor: blue\n---\n\n%s\n' "$BODY" > "$CORPUS/agents/f27-tab-continuation.md"
printf -- '---\r\nname: f28-crlf-trailing-colon\r\ndescription: Use this agent when the user asks for a test. Examples:\r\nmodel: sonnet\r\ncolor: blue\r\n---\r\n\r\n%s\r\n' "$BODY" > "$CORPUS/agents/f28-crlf-trailing-colon.md"
printf -- '---\r\nname: f29-crlf-block\r\ndescription: |-\r\n  Use this agent when the user asks for a test.\r\n  <example>x</example>\r\nmodel: sonnet\r\ncolor: blue\r\n---\r\n\r\n%s\r\n' "$BODY" > "$CORPUS/agents/f29-crlf-block.md"
mk f30-plain-multi-dash-continuation <<'E'
description: Use this agent when the user asks for a test.
  - looks like a list item but is a continuation
E
mk f31-plain-literal-backslash-n <<'E'
description: Use this agent when the user asks for a test.\n<example>x</example>
E
mk block-leading-blank <<'E'
description: |-

  Use this agent when the user asks for a test.
  <example>x</example>
E
mk block-spaces <<'E'
description: |-
  Use this agent when the user asks for a test.
    
  <example>x</example>
E
mk g03-true <<'E'
description: true
E
mk g05-null-word <<'E'
description: null
E
mk g06-hex <<'E'
description: 0x1f
E
mk g11-next-line-plain <<'E'
description:
  Use this agent when the user asks for a test.
  <example>next line</example>
E
mk g13-folded-more-indented <<'E'
description: >-
  Use this agent when the user asks for a test.

  <example>
    Context: more indented
    user: "u"
  </example>

  Trailing paragraph.
E
mk g15-dq-escapes <<'E'
description: "Use this agent when \"quoted\" tab\there back\\slash and é done"
E
mk g16-dq-escaped-linebreak <<'E'
description: "Use this agent when the user asks for a test.\
  <example>joined</example>"
E
mk g25-mapping-value <<'E'
description:
  key: value
E
mk g27-flow-seq <<'E'
description: [a, b]
E
mk g36-block-only-blank-lines <<'E'
description: |-


E
printf -- '\xEF\xBB\xBF---\nname: bom-block\ndescription: |-\n  Use this agent when the user asks for a test.\n  <example>x</example>\nmodel: sonnet\ncolor: blue\n---\n\n%s\n' "$BODY" > "$CORPUS/agents/bom-block.md"

# The product's verdict over the whole corpus, once.
REPORT=$("$CLAUDE" plugin validate "$CORPUS" --json 2>/dev/null)
if ! printf '%s' "$REPORT" | jq -e . >/dev/null 2>&1; then
  echo "FAIL: 'claude plugin validate --json' produced no JSON report"; exit 1
fi
if [ "$(printf '%s' "$REPORT" | jq -r '.manifest.errors | length')" != "0" ]; then
  echo "FAIL: the product refused the corpus plugin: $(printf '%s' "$REPORT" | jq -r '.manifest.errors[0].message')"; exit 1
fi
product_error() { # product_error NAME -> first error message for that agent file, or empty
  printf '%s' "$REPORT" | jq -r --arg f "/agents/$1.md" '.contents[]? | select(.type == "agent" and (.file | endswith($f))) | .errors[0].message // empty'
}
product_error_count=$(printf '%s' "$REPORT" | jq -r '[.contents[]? | select(.type == "agent") | select((.errors | length) > 0)] | length')
[ "$product_error_count" -ge 8 ] || { echo "FAIL: the product reported errors for only $product_error_count corpus files; expected the parse failures and the list (at least 8)"; exit 1; }

# Shapes the script rejects on its own: the product passes them, but the project-agent loader
# drops the agent as missing its description and a plugin agent shows a placeholder or the
# JavaScript value.
policy_reject() {
  case "$1" in
    f19-empty-then-key|f20-block-empty|g05-null-word|g36-block-only-blank-lines) echo "description is empty" ;;
    f23-number|g06-hex) echo "reads as a YAML number" ;;
    g03-true) echo "reads as a YAML boolean" ;;
    *) echo "" ;;
  esac
}

echo ""
echo "Corpus verdicts (script vs product):"
agree=0; total=0
for file in "$CORPUS"/agents/*.md; do
  name=$(basename "$file" .md)
  perr=$(product_error "$name")
  policy=$(policy_reject "$name")
  if [ -n "$perr" ] || [ -n "$policy" ]; then want=1; else want=0; fi
  run "$file"
  total=$((total + 1))
  has_summary || { flunk "$name: no summary line (abort)"; continue; }
  if [ $RC -ne $want ]; then
    flunk "$name: exit $RC, product $([ -n "$perr" ] && echo "rejects" || echo "accepts")$([ -n "$policy" ] && echo ", script policy rejects") (own-grammar)"
    continue
  fi
  if [ -n "$perr" ] && ! has "${perr:0:40}"; then
    flunk "$name: the product's message is not in the output: ${perr:0:60}"
    continue
  fi
  if [ -n "$policy" ] && ! has "$policy"; then
    flunk "$name: expected '$policy' in the output"
    continue
  fi
  agree=$((agree + 1))
done
if [ $agree -eq $total ]; then pass "corpus: script verdict = product verdict (+ policy) on $agree/$total shapes"; else flunk "corpus: $agree/$total shapes agree with the product"; fi

# 3. The description text, as the model sees it. The f-/block- rows were observed in the agent
#    listing Claude Code 2.1.266 handed the model with this corpus loaded through --plugin-dir;
#    the g- rows and f31 come from replaying the loader path (Bun 1.4.1 YAML, the parse retry,
#    trim) since they were not part of that run. Escapes are printf %b: \n newline, \t tab,
#    \\ backslash.
echo ""
echo "Description text (--description vs runtime):"
text_ok=0; text_total=0
while IFS=$'\t' read -r name esc; do
  [ -n "$name" ] || continue
  text_total=$((text_total + 1))
  want=$(printf '%b' "$esc"; printf x); want=${want%x}
  got=$(bash "$VALIDATOR" --description "$CORPUS/agents/$name.md" 2>/dev/null; printf x); rc=$?; got=${got%x}; got=${got%$'\n'}
  if [ "$got" = "$want" ]; then text_ok=$((text_ok + 1)); else flunk "$name: --description read $(printf '%s' "$got" | wc -c | tr -d ' ') chars, runtime shows $(printf '%s' "$want" | wc -c | tr -d ' ') (text): got $(printf '%s' "$got" | head -c 80 | tr '\n' '|')"; fi
done <<'TABLE'
f01-plain-single	Use this agent when the user asks for a test. Plain single line.
f03-plain-colon-space	Use this agent when the user asks for a test. Context: none
f04-plain-multi-indented	Use this agent when the user asks for a test. Second line indented, no colons. <example>third</example>
f07-block-literal-strip	Use this agent when the user asks for a test.\n\n<example>\nContext: the user wants a test\nuser: "run a test"\nassistant: "I'll use the test agent"\n</example>
f09-block-extra-indent	Use this agent when the user asks for a test.\n  <example>more indented</example>
f10-block-keep	Use this agent when the user asks for a test.\n<example>x</example>
f11-folded-strip	Use this agent when the user asks for a test. <example>x</example>
f12-dq-single	Use this agent when the user asks for a test. Context: quoted
f13-dq-multi	Use this agent when the user asks for a test. <example>Context: second line</example>
f14-dq-escape-newline	Use this agent when the user asks for a test.\n<example>x</example>
f16-sq-escaped-apostrophe	Use this agent when it's a test. <example>x</example>
f17-plain-hash-comment	Use this agent when the user asks for a test
f18-plain-at-indicator	@use this agent when the user asks for a test
f22-yes-boolean	yes
f24-absorption-permissionMode	Use this agent when the user asks for a test. Eighty chars of text here..
f25-plain-multi-blank-line	Use this agent when the user asks for a test.\n<example>after blank line</example>
f27-tab-continuation	Use this agent when the user asks for a test. <example>tab indented</example>
f29-crlf-block	Use this agent when the user asks for a test.\n<example>x</example>
f30-plain-multi-dash-continuation	Use this agent when the user asks for a test. - looks like a list item but is a continuation
block-leading-blank	Use this agent when the user asks for a test.\n<example>x</example>
block-spaces	Use this agent when the user asks for a test.\n  \n<example>x</example>
f31-plain-literal-backslash-n	Use this agent when the user asks for a test.\\n<example>x</example>
g11-next-line-plain	Use this agent when the user asks for a test. <example>next line</example>
g13-folded-more-indented	Use this agent when the user asks for a test.\n<example>\n  Context: more indented\n  user: "u"\n</example>\nTrailing paragraph.
g15-dq-escapes	Use this agent when "quoted" tab\there back\\slash and é done
g16-dq-escaped-linebreak	Use this agent when the user asks for a test.<example>joined</example>
bom-block	Use this agent when the user asks for a test.\n<example>x</example>
TABLE
if [ $text_ok -eq $text_total ]; then pass "description text matches the runtime on $text_ok/$text_total shapes"; else flunk "description text: $text_ok/$text_total shapes match the runtime"; fi

# --description refuses what the loader would not show as text.
for name in f19-empty-then-key f21-list-value f23-number g25-mapping-value; do
  ERR=$(bash "$VALIDATOR" --description "$CORPUS/agents/$name.md" 2>&1 >/dev/null); rc=$?
  if [ $rc -eq 1 ] && case "$ERR" in description:*) true;; *) false;; esac; then pass "--description refuses $name ($ERR)"; else flunk "--description $name: exit $rc, stderr '$ERR' (expected exit 1 and 'description: <kind>')"; fi
done

# 4. Style checks read the runtime text, not the file's first line.
run "$CORPUS/agents/f13-dq-multi.md"
if [ $RC -eq 0 ] && ! has "should include <example>"; then pass "multi-line double-quoted value: <example> seen (no false warning)"; else flunk "f13: exit $RC, false <example> warning: $(has 'should include <example>' && echo yes || echo no) (first-line)"; fi
run "$CORPUS/agents/f17-plain-hash-comment.md"
if [ $RC -eq 0 ] && has "should include <example>"; then pass "inline ' #' comment is not part of the value: <example> warning raised"; else flunk "f17: exit $RC, <example> warning: $(has 'should include <example>' && echo yes || echo no) (text)"; fi
run "$CORPUS/agents/f04-plain-multi-indented.md"
if [ $RC -eq 0 ] && has "multi-line plain value"; then pass "plain multi-line value accepted with a warning"; else flunk "f04: exit $RC, warning present: $(has 'multi-line plain value' && echo yes || echo no)"; fi
run "$CORPUS/agents/f03-plain-colon-space.md"
if [ $RC -eq 0 ] && has "containing ': '"; then pass "single line containing ': ' accepted with a warning"; else flunk "f03: exit $RC, warning present: $(has "containing ': '" && echo yes || echo no)"; fi
run "$CORPUS/agents/f29-crlf-block.md"
if [ $RC -eq 0 ] && has "CRLF"; then pass "CRLF file accepted with a note"; else flunk "f29: exit $RC, CRLF note: $(has CRLF && echo yes || echo no) (crlf)"; fi
run "$CORPUS/agents/bom-block.md"
if [ $RC -eq 0 ] && has "byte order mark"; then pass "BOM file accepted with a note"; else flunk "bom-block: exit $RC, BOM note: $(has 'byte order mark' && echo yes || echo no)"; fi

# 5. Absorption: keys after the description must not be counted as description text.
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

# 6. Warnings only: exit 0 and a summary line (the abort regression).
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

# 7. Optional field absent: tools is optional, so a file without it exits 0 with a summary.
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

# 8. Invalid file still fails, and the missing field is NAMED (the same abort used to end the
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

# 9. No product, no verdict: without a usable `claude` the frontmatter is reported unverified
#    and the exit code is 2, never 0.
OUT=$(CLAUDE_BIN=/nonexistent/claude bash "$VALIDATOR" "$TMP_DIR/no-tools.md" 2>&1); RC=$?
if [ $RC -eq 2 ] && has "Frontmatter not verified" && has "Validation incomplete"; then
  pass "no claude on PATH: exit 2, frontmatter reported unverified"
else
  flunk "no claude on PATH: exit $RC, 'not verified' present: $(has 'Frontmatter not verified' && echo yes || echo no) (silent-pass)"
fi
mkdir -p "$TMP_DIR/shim"
printf '#!/bin/bash\necho "cannot start" >&2\nexit 3\n' > "$TMP_DIR/shim/claude-broken"
chmod +x "$TMP_DIR/shim/claude-broken"
OUT=$(CLAUDE_BIN="$TMP_DIR/shim/claude-broken" bash "$VALIDATOR" "$TMP_DIR/no-tools.md" 2>&1); RC=$?
if [ $RC -eq 2 ] && has "Frontmatter not verified"; then
  pass "claude that fails to run: exit 2, frontmatter reported unverified"
else
  flunk "broken claude: exit $RC, 'not verified' present: $(has 'Frontmatter not verified' && echo yes || echo no) (silent-pass)"
fi

# 10. A Claude Code without --json (older than 2.1.259): the plain report carries the same
#     verdict. The shim rejects --json the way commander does and otherwise runs the real CLI.
printf '#!/bin/bash\nfor a in "$@"; do [ "$a" = "--json" ] && { echo "error: unknown option '"'"'--json'"'"'" >&2; exit 1; }; done\nexec "%s" "$@"\n' "$CLAUDE" > "$TMP_DIR/shim/claude-nojson"
chmod +x "$TMP_DIR/shim/claude-nojson"
OUT=$(CLAUDE_BIN="$TMP_DIR/shim/claude-nojson" bash "$VALIDATOR" "$CORPUS/agents/f02-plain-trailing-colon.md" 2>&1); RC=$?
if [ $RC -eq 1 ] && has "❌ frontmatter: YAML frontmatter failed to parse"; then
  pass "plain report fallback: parse failure surfaced with the product's message"
else
  flunk "plain report fallback (f02): exit $RC, product message present: $(has 'YAML frontmatter failed to parse' && echo yes || echo no)"
fi
OUT=$(CLAUDE_BIN="$TMP_DIR/shim/claude-nojson" bash "$VALIDATOR" "$TMP_DIR/no-tools.md" 2>&1); RC=$?
if [ $RC -eq 0 ] && has "✅ Frontmatter parses"; then
  pass "plain report fallback: valid file passes"
else
  flunk "plain report fallback (valid): exit $RC, 'Frontmatter parses' present: $(has 'Frontmatter parses' && echo yes || echo no)"
fi

echo ""
if [ $fail -eq 0 ]; then
  echo "All tests passed"
  exit 0
else
  echo "Some tests failed"
  exit 1
fi
