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
#   cut           the frontmatter was read to the closing `---` line; the loader stops at the
#                 first `---` anywhere, so a `---` inside a value silently drops every field
#                 after it (the product's validator does not report this)
#   extension     a file not named *.md was reported as parsing because the product's validator
#                 skips it (seen against the first version of this rewrite)
#   abort         the first warning killed the script (((x++)) exits 1 under set -e), so no
#                 summary line was printed and warnings-only files exited 1
#   first-line    only the first line of a multi-line description was read
#   absorption    a stop-list extractor (stop at name|model|color|tools) folds any other key
#                 that follows the description into the description text
#   silent-abort  a file without a tools field (optional) or without a required field ended
#                 the script at the field's grep (exit 1, no message, no summary)
#   report-shape  a `claude` that printed an unrelated JSON object, or a plain report that never
#                 reached its verdict line, was read as a clean report (the version before this
#                 one; the fault shims in section 9 reproduce both)
#   sigpipe       a file larger than the pipe buffer (64 KiB) ended the script with status 141 at
#                 a head/grep -q reader under pipefail, or reported the frontmatter as not closed
#   retry-doc     the loader's retry is document-wide: a `note: @x` line anywhere makes a plain
#                 description keep its ' #' comment as text, and the script stripped it
#   tag           `description: !!str 12345678901` was reported as a number
#   alias         `description: *anchor` was reported as unreadable; the loader resolves it
#   unicode-ws    a description of only U+00A0 passed as text; the loader's trim() empties it
#   escapes       \_ \e \a \b \f \v \N \L \P \xHH \UHHHHHHHH, an escaped space or tab
#                 before a line break, and a backslash-newline followed by a blank line were
#                 kept literally, dropped or folded wrongly
#   next-line     a value starting on the line after `description:` (quoted, block header,
#                 comment then text, flow sequence) was read as absent
#   verbatim      `| text`, `>- text`, `[text`, `{text` and `"quoted" junk` load through the
#                 retry as literal text; the script reported them as blocks, lists or invalid
#   report-sense  a report whose verdict was "failed" (success false, exit 1) but named no agent
#                 error was read as a pass; a failure without a diagnostic is "not verified"
#   tag-type      `!!null null` and `!!int 12345678901` passed the value policy because every
#                 explicit tag was treated as !!str
#   retry-comment `note: harmless # Context: a comment` was read as a value with ': ' and put
#                 the whole file into retry mode, turning a block description into the text `|-`
#   alias-block   `summary: &trigger |-` with a body, then `description: *trigger`, resolved to
#                 the header `|-` instead of the block's text
#   hex-space     `\x20` before a line break inside a double-quoted value was folded away; it is
#                 escaped whitespace and the runtime keeps it
#   lf-note       every LF file printed the CRLF note (the CR test compared a value with its
#                 trailing newlines to one without)
#   alias-scope   `description: *trigger` took the LAST anchor of that name in the file, even one
#                 defined after it; the loader takes the latest one defined before the alias. An
#                 anchor on a quoted key (`"summary": &trigger ...`) was not seen at all
#   tag-next-line `description: !!null` with `null` on the next line passed as four characters of
#                 text; the type policy only looked at values starting on the key line
#   nested-anchor an anchor defined on an indented key (`metadata:` / `  summary: &trigger ...`)
#                 was not collected, so `description: *trigger` read as the literal `*trigger`
#   quoted-retry  `"description": |-` in a file whose other line triggers the loader's retry was
#                 reported unreadable; the retry rewrites bare-key lines only, so the block stays
#   anchored-map  `metadata: &meta` (a mapping header carrying only a node property) was taken
#                 for a scalar, so the anchors defined under it were skipped
#   block-indent  an explicit indentation indicator (`>2-`, `|2-`) on a nested anchored block was
#                 counted from column 0 instead of from the key's indent, leaving two spaces and
#                 a stray newline in the text
#
# Requirements: Claude Code 2.1.259 or newer on PATH (for `claude plugin validate --json`) and
# jq. Without them the suite FAILS; it never skips, because a skipped suite reads as green.
# VALIDATOR may be overridden to point the suite at another script (used to demonstrate the
# failures above): VALIDATOR=/path/to/old.sh bash validate-agent.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="${VALIDATOR:-$SCRIPT_DIR/validate-agent.sh}"
VALIDATOR="$(cd "$(dirname "$VALIDATOR")" && pwd)/$(basename "$VALIDATOR")"
PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
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
own_agents=$(ls "$PLUGIN_ROOT"/agents/*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$own_agents" -gt 0 ] || flunk "no agent files under $PLUGIN_ROOT/agents (set PLUGIN_ROOT when running a copy of this suite)"
for agent in "$PLUGIN_ROOT"/agents/*.md; do
  [ -f "$agent" ] || continue
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
  { printf -- '---\nname: %s\n' "$1"; cat; printf 'model: sonnet\ncolor: blue\n---\n\n%s\n' "$BODY"; } > "$CORPUS/agents/$1.md" \
    || { echo "FAIL: could not write $CORPUS/agents/$1.md"; exit 1; }
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
mk h03-quoted-key <<'E'
"description": Use this agent when quoted key
E
mk h04-second-key <<'E'
description: Use this agent when first
description: Use this agent when second
E
mk h05-dashes-in-value <<'E'
description: |-
  Use this agent when --- appears
  --- and again
E
mk h12-plain-hash-in-continuation-start <<'E'
description: Use this agent when the user asks for a test.
  #not a comment? starts continuation with hash
E
# r-series: shapes from the two independent reviews of this script (Bun 1.4.1 replay and the
# 2.1.266 runtime agree on every text below).
mk r01-anchor-alias <<'E'
summary: &trigger Use this agent when testing behavior. <example>alias</example>
description: *trigger
E
mk r02-retry-comment <<'E'
description: Use this agent when testing behavior. # <example>retry</example>
note: @repair
E
mk r03-nbsp-only <<'E'
description: "\u00a0"
E
mk r04-dq-escape-nbsp <<'E'
description: "Use this agent when\_the user asks for a test. <example>x</example>"
E
mk r05-tag-str-number <<'E'
description: !!str 12345678901
E
mk r06-space-before-colon <<'E'
description : Use this agent when the user asks for a test <example>x</example>
E
mk r07-next-line-dq <<'E'
description:
  "Use this agent when the user asks for a test. <example>x</example>"
E
mk r08-next-line-sq <<'E'
description:
  'Use this agent when it''s a test. <example>x</example>'
E
mk r09-next-line-block <<'E'
description:
  |-
  Use this agent when the user asks for a test.
  <example>x</example>
E
mk r10-next-line-comment-then-text <<'E'
description:
  # a comment
  Use this agent when the user asks for a test. <example>x</example>
E
mk r11-next-line-flowseq <<'E'
description:
  [a, b]
E
mk r12-pipe-then-text <<'E'
description: | Use this agent when the user asks for a test <example>x</example>
E
mk r13-open-bracket <<'E'
description: [Use this agent when the user asks for a test <example>x</example>
E
mk r14-open-brace <<'E'
description: {Use this agent when the user asks for a test <example>x</example>
E
mk r15-dq-close-then-junk <<'E'
description: "Use this agent when the user asks for a test" <example>x</example>
E
mk r16-dq-escaped-space-before-break <<'E'
description: "Use this agent when\ 
  the user asks <example>x</example>"
E
mk r17-dq-tab-escape-before-break <<'E'
description: "Use this agent when\t
  the user asks <example>x</example>"
E
mk r18-dq-escaped-break-then-blank <<'E'
description: "Use this agent when\

  the user asks <example>x</example>"
E
printf -- '---\nname: r19-nbsp-trailing\ndescription: Use this agent when the user asks for a test. <example>x</example>\302\240\nmodel: sonnet\ncolor: blue\n---\n\n%s\n' "$BODY" > "$CORPUS/agents/r19-nbsp-trailing.md"
mk r21-tag-null <<'E'
description: !!null null
E
mk r22-tag-int <<'E'
description: !!int 12345678901
E
mk r23-false-retry-comment <<'E'
description: |-
  Use this agent when testing behavior. <example>block</example>
note: harmless # Context: a comment
E
mk r24-alias-block <<'E'
summary: &trigger |-
  Use this agent when testing behavior. <example>alias</example>
description: *trigger
E
mk r25-hex-space-break <<'E'
description: "Use this agent when\x20
  testing behavior. <example>space</example>"
E
mk r26-tag-next-line-null <<'E'
description: !!null
  null
E
mk r27-alias-rebound <<'E'
summary: &trigger Use this agent when testing behavior. <example>first</example>
description: *trigger
later: &trigger A different description for a later reference.
E
mk r28-alias-quoted-key <<'E'
"summary": &trigger Use this agent when testing behavior. <example>alias</example>
description: *trigger
E
mk r29-tag-quoted-null <<'E'
description: !!null "null"
E
mk r30-tag-quoted-number <<'E'
description: !!int "12345678901"
E
mk r31-quoted-block-retry <<'E'
"description": |-
  Use this agent when testing behavior. <example>block</example>
note: @repair
E
mk r32-quoted-plain-retry <<'E'
"description": Use this agent when testing behavior. <example>plain</example>
note: @repair
E
mk r33-nested-anchor <<'E'
metadata:
  summary: &trigger Use this agent when testing behavior. <example>alias</example>
description: *trigger
E
mk r34-nested-anchor-block <<'E'
metadata:
  summary: &trigger |-
    Use this agent when testing behavior. <example>nested</example>
  other: value
description: *trigger
E
mk r35-nested-anchor-next-line <<'E'
metadata:
  summary: &trigger
    Use this agent when testing behavior. <example>next</example>
  other: value
description: *trigger
E
mk r36-anchored-map <<'E'
metadata: &meta
  summary: &trigger Use this agent when testing behavior. <example>alias</example>
description: *trigger
E
mk r37-nested-folded-indent <<'E'
metadata:
  summary: &trigger >2-
    Use this agent when
    testing behavior. <example>folded</example>
  other: value
description: *trigger
E
mk r38-nested-literal-indent <<'E'
metadata:
  summary: &trigger |2-
    Use this agent when testing behavior.
    <example>literal</example>
  other: value
description: *trigger
E
printf -- '---\nname: r20-dq-escaped-tab-char\ndescription: "Use this agent when\\\tthe user asks <example>x</example>"\nmodel: sonnet\ncolor: blue\n---\n\n%s\n' "$BODY" > "$CORPUS/agents/r20-dq-escaped-tab-char.md"
printf -- '---\r\nname: h14-crlf-dq-multi\r\ndescription: "Use this agent when the user asks for a test.\r\n  <example>crlf quoted</example>"\r\nmodel: sonnet\r\ncolor: blue\r\n---\r\n\r\n%s\r\n' "$BODY" > "$CORPUS/agents/h14-crlf-dq-multi.md"
printf -- '---\r\nname: h16-crlf-plain-multi\r\ndescription: Use this agent when the user asks for a test.\r\n  <example>crlf plain</example>\r\nmodel: sonnet\r\ncolor: blue\r\n---\r\n\r\n%s\r\n' "$BODY" > "$CORPUS/agents/h16-crlf-plain-multi.md"
printf -- '---\r\nname: h17-crlf-dq-blank\r\ndescription: "Use this agent when the user asks for a test.\r\n\r\n  <example>after blank</example>"\r\nmodel: sonnet\r\ncolor: blue\r\n---\r\n\r\n%s\r\n' "$BODY" > "$CORPUS/agents/h17-crlf-dq-blank.md"
printf -- '---\r\nname: h21-crlf-dq-three-lines\r\ndescription: "Use this agent when a\r\n  b\r\n  c"\r\nmodel: sonnet\r\ncolor: blue\r\n---\r\n\r\n%s\r\n' "$BODY" > "$CORPUS/agents/h21-crlf-dq-three-lines.md"
printf -- "---\r\nname: h22-crlf-sq-multi\r\ndescription: 'Use this agent when a\r\n  b'\r\nmodel: sonnet\r\ncolor: blue\r\n---\r\n\r\n%s\r\n" "$BODY" > "$CORPUS/agents/h22-crlf-sq-multi.md"
printf -- '---\r\nname: h25-crlf-plain-verbatim\r\ndescription: Use this agent when X: y\r\nmodel: sonnet\r\ncolor: blue\r\n---\r\n\r\n%s\r\n' "$BODY" > "$CORPUS/agents/h25-crlf-plain-verbatim.md"

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
    f19-empty-then-key|f20-block-empty|g05-null-word|g36-block-only-blank-lines|r03-nbsp-only|r21-tag-null|r26-tag-next-line-null) echo "description is empty" ;;
    h05-dashes-in-value) echo "ends it early" ;;
    f23-number|g06-hex|r22-tag-int) echo "reads as a YAML number" ;;
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
#    the g- and h- rows and f31 come from replaying the loader path (Bun 1.4.1 YAML, the parse
#    retry, trim) since they were not part of that run. Escapes are printf %b: \n newline, \t tab,
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
h03-quoted-key	Use this agent when quoted key
h04-second-key	Use this agent when second
h05-dashes-in-value	Use this agent when
h12-plain-hash-in-continuation-start	Use this agent when the user asks for a test.
h14-crlf-dq-multi	Use this agent when the user asks for a test.\n<example>crlf quoted</example>
h16-crlf-plain-multi	Use this agent when the user asks for a test. <example>crlf plain</example>
h17-crlf-dq-blank	Use this agent when the user asks for a test.\n\n<example>after blank</example>
h21-crlf-dq-three-lines	Use this agent when a\nb\nc
h22-crlf-sq-multi	Use this agent when a\nb
r01-anchor-alias	Use this agent when testing behavior. <example>alias</example>
r02-retry-comment	Use this agent when testing behavior. # <example>retry</example>
r04-dq-escape-nbsp	Use this agent when\0302\0240the user asks for a test. <example>x</example>
r05-tag-str-number	12345678901
r06-space-before-colon	Use this agent when the user asks for a test <example>x</example>
r07-next-line-dq	Use this agent when the user asks for a test. <example>x</example>
r08-next-line-sq	Use this agent when it's a test. <example>x</example>
r09-next-line-block	Use this agent when the user asks for a test.\n<example>x</example>
r10-next-line-comment-then-text	Use this agent when the user asks for a test. <example>x</example>
r12-pipe-then-text	| Use this agent when the user asks for a test <example>x</example>
r13-open-bracket	[Use this agent when the user asks for a test <example>x</example>
r14-open-brace	{Use this agent when the user asks for a test <example>x</example>
r15-dq-close-then-junk	"Use this agent when the user asks for a test" <example>x</example>
r16-dq-escaped-space-before-break	Use this agent when  the user asks <example>x</example>
r17-dq-tab-escape-before-break	Use this agent when\t the user asks <example>x</example>
r18-dq-escaped-break-then-blank	Use this agent when\nthe user asks <example>x</example>
r19-nbsp-trailing	Use this agent when the user asks for a test. <example>x</example>
r20-dq-escaped-tab-char	Use this agent when\tthe user asks <example>x</example>
r23-false-retry-comment	Use this agent when testing behavior. <example>block</example>
r24-alias-block	Use this agent when testing behavior. <example>alias</example>
r25-hex-space-break	Use this agent when  testing behavior. <example>space</example>
r27-alias-rebound	Use this agent when testing behavior. <example>first</example>
r28-alias-quoted-key	Use this agent when testing behavior. <example>alias</example>
r29-tag-quoted-null	null
r30-tag-quoted-number	12345678901
r31-quoted-block-retry	Use this agent when testing behavior. <example>block</example>
r32-quoted-plain-retry	Use this agent when testing behavior. <example>plain</example>
r33-nested-anchor	Use this agent when testing behavior. <example>alias</example>
r34-nested-anchor-block	Use this agent when testing behavior. <example>nested</example>
r35-nested-anchor-next-line	Use this agent when testing behavior. <example>next</example>
r36-anchored-map	Use this agent when testing behavior. <example>alias</example>
r37-nested-folded-indent	Use this agent when testing behavior. <example>folded</example>
r38-nested-literal-indent	Use this agent when testing behavior.\n<example>literal</example>
TABLE
if [ $text_ok -eq $text_total ]; then pass "description text matches the runtime on $text_ok/$text_total shapes"; else flunk "description text: $text_ok/$text_total shapes match the runtime"; fi

# --description refuses what the loader would not show as text.
for name in f19-empty-then-key f21-list-value f23-number g25-mapping-value r03-nbsp-only r11-next-line-flowseq r21-tag-null r22-tag-int r26-tag-next-line-null; do
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
run "$CORPUS/agents/f01-plain-single.md"
if [ $RC -eq 0 ] && ! has "CRLF"; then pass "LF file: no CRLF note"; else flunk "f01: exit $RC, CRLF note on an LF file: $(has CRLF && echo yes || echo no) (lf-note)"; fi
run "$CORPUS/agents/bom-block.md"
if [ $RC -eq 0 ] && has "byte order mark"; then pass "BOM file accepted with a note"; else flunk "bom-block: exit $RC, BOM note: $(has 'byte order mark' && echo yes || echo no)"; fi
run "$CORPUS/agents/h05-dashes-in-value.md"
if [ $RC -eq 1 ] && has "ends it early" && has "line 4" && has "Missing required field: model"; then pass "'---' inside a value: reported as cutting the frontmatter at line 4, fields after it missing"; else flunk "h05: exit $RC, cut message: $(has 'ends it early' && echo yes || echo no), line 4 named: $(has 'line 4' && echo yes || echo no) (cut)"; fi
cp "$CORPUS/agents/f01-plain-single.md" "$TMP_DIR/agent.txt"
run "$TMP_DIR/agent.txt"
if [ $RC -eq 1 ] && has "skips 'agent.txt'"; then pass "non-.md file: error, frontmatter not claimed verified"; else flunk "agent.txt: exit $RC, skip message: $(has "skips 'agent.txt'" && echo yes || echo no) (extension)"; fi

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

# A `claude` that runs but does not produce the validator's report: an unrelated JSON object
# (exit 0 or 3), or a plain report cut off before its verdict line. Each is "not verified",
# never a pass (report-shape).
printf '#!/bin/bash\necho '"'"'{"error":"validator failed before inspecting the agent"}'"'"'\nexit 0\n' > "$TMP_DIR/shim/claude-json-unrelated"
printf '#!/bin/bash\necho '"'"'{"error":"validator failed before inspecting the agent"}'"'"'\nexit 3\n' > "$TMP_DIR/shim/claude-json-exit3"
printf '#!/bin/bash\nfor a in "$@"; do [ "$a" = "--json" ] && { echo "error: unknown option '"'"'--json'"'"'" >&2; exit 1; }; done\necho "Validating plugin manifest: $2"\nexit 0\n' > "$TMP_DIR/shim/claude-plain-truncated"
printf '#!/bin/bash\necho '"'"'{"success":false,"manifest":{"errors":[]},"contents":[]}'"'"'\nexit 1\n' > "$TMP_DIR/shim/claude-json-failed"
printf '#!/bin/bash\nfor a in "$@"; do [ "$a" = "--json" ] && { echo "error: unknown option '"'"'--json'"'"'" >&2; exit 1; }; done\necho "Validating plugin manifest: $2/.claude-plugin/plugin.json"\necho "Validation failed: stopped before validating agents"\nexit 1\n' > "$TMP_DIR/shim/claude-plain-failed"
chmod +x "$TMP_DIR/shim/claude-json-unrelated" "$TMP_DIR/shim/claude-json-exit3" "$TMP_DIR/shim/claude-plain-truncated" "$TMP_DIR/shim/claude-json-failed" "$TMP_DIR/shim/claude-plain-failed"
for shim in claude-json-unrelated claude-json-exit3 claude-plain-truncated claude-json-failed claude-plain-failed; do
  OUT=$(CLAUDE_BIN="$TMP_DIR/shim/$shim" bash "$VALIDATOR" "$TMP_DIR/no-tools.md" 2>&1); RC=$?
  if [ $RC -eq 2 ] && has "Frontmatter not verified" && has "Validation incomplete" && ! has "Frontmatter parses"; then
    pass "$shim: exit 2, frontmatter reported unverified"
  else
    flunk "$shim: exit $RC, 'not verified' present: $(has 'Frontmatter not verified' && echo yes || echo no), 'parses' present: $(has 'Frontmatter parses' && echo yes || echo no) (report-shape / report-sense)"
  fi
done

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

# 11. A file larger than the pipe buffer: the readers must consume their input (sigpipe).
{ printf -- '---\nname: big-agent\ndescription: |-\n  Use this agent when the user asks for X. Examples: <example>Context: c</example>\nmodel: inherit\ncolor: blue\n---\n\n'; printf '%s\n' "$BODY" | awk '{ for (i = 0; i < 800; i++) print }'; } > "$TMP_DIR/big.md"
big_bytes=$(wc -c < "$TMP_DIR/big.md" | tr -d ' ')
[ "$big_bytes" -gt 65536 ] || flunk "big.md is only $big_bytes bytes; the check needs more than 65536"
run "$TMP_DIR/big.md"
if [ $RC -eq 0 ] && has "Frontmatter properly closed" && has "Frontmatter parses" && has_summary; then
  pass "file of $big_bytes bytes: exit 0 with a summary"
else
  flunk "file of $big_bytes bytes: exit $RC, closed: $(has 'properly closed' && echo yes || echo no), summary: $(has_summary && echo yes || echo no) (sigpipe)"
fi

# 12. Argument handling: `--` ends the options, and a file name starting with '-' is a file.
cp "$TMP_DIR/no-tools.md" "$TMP_DIR/-dash.md"
OUT=$(cd "$TMP_DIR" && bash "$VALIDATOR" -- -dash.md 2>&1); RC=$?
if [ $RC -eq 0 ] && has "Frontmatter parses"; then pass "-- then a file named -dash.md"; else flunk "-- -dash.md: exit $RC (expected 0)"; fi
OUT=$(cd "$TMP_DIR" && bash "$VALIDATOR" --description -- -dash.md 2>&1); RC=$?
if [ $RC -eq 0 ] && has "Use this agent when"; then pass "--description -- -dash.md"; else flunk "--description -- -dash.md: exit $RC, got: $(printf '%s' "$OUT" | head -c 80)"; fi

echo ""
if [ $fail -eq 0 ]; then
  echo "All tests passed"
  exit 0
else
  echo "Some tests failed"
  exit 1
fi
