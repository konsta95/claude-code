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
#   - checks the product does not make: a null, empty, numeric or boolean description passes
#     `claude plugin validate`, but the project-agent loader drops the agent as missing its
#     description and a plugin agent shows a placeholder (or the digits); a `---` anywhere
#     inside the frontmatter ends it early for the loader, silently dropping every field after
#     it; a file whose name does not end in .md is not validated by the product at all;
#   - the description text the model will see, read the way the plugin loader reads it (block,
#     plain and quoted scalars folded per YAML, double-quoted escapes decoded, then trimmed),
#     for the style checks: <example> blocks, the "Use this agent when" trigger phrase and
#     length. Project agents (.claude/agents/) keep the untrimmed value and turn a literal \n
#     into a newline; that changes the reported length, not the verdicts.
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
[ "${1:-}" = "--" ] && shift
[ $# -eq 1 ] || usage
AGENT_FILE="$1"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
TMP_PLUGIN=""
cleanup() { [ -n "$TMP_PLUGIN" ] && rm -rf "$TMP_PLUGIN"; return 0; }
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------
# Frontmatter, the loader's way.
#
# The loader matches /^---\s*\n([\s\S]*?)---\s*\n?/: the frontmatter ends at the FIRST `---`
# after the opening line, wherever it is, even in the middle of a value. Input: the file (BOM
# removed, CRs kept). Output: line 1 "END=<line> CUT=<0|1>" — END is the line holding that
# `---` (0 when there is none) and CUT is 1 when it is not a line of its own — then the
# frontmatter text. The whole input is read (no early exit), so a large file cannot end the
# writer with SIGPIPE.
# ---------------------------------------------------------------------------------------------
frontmatter_cut() {
  LC_ALL=C awk '
    NR == 1 { if ($0 !~ /^---[ \t\r]*$/) bad = 1; next }
    bad || found { next }
    { p = index($0, "---")
      if (p == 0) { fm[n++] = $0; next }
      cut = ($0 ~ /^---[ \t\r]*$/) ? 0 : 1
      endline = NR; found = 1
      if (cut && p > 1) fm[n++] = substr($0, 1, p - 1)
    }
    END {
      if (bad || !found) { print "END=0 CUT=0" } else { print "END=" endline " CUT=" cut }
      if (!bad) for (i = 0; i < n; i++) print fm[i]
    }
  '
}

# ---------------------------------------------------------------------------------------------
# Description extraction, the plugin loader's way.
#
# Input: the frontmatter lines (CRs kept). Output: line 1 "KIND=<kind> LINES=<n>", then the
# description text. Kinds: absent, empty, null, number, boolean, list, mapping, unterminated,
# invalid, block, plain, double, single; LINES counts the lines of a plain value beyond the
# key line. The text is the YAML value (block scalars with their chomping, plain and quoted
# scalars folded, double-quoted escapes decoded, a scalar alias resolved) followed by the
# plugin loader's trim(). The last `description:` key wins, as it does in the parser.
#
# The loader's retry is modelled document-wide, because it is triggered by any line. The first
# parse fails on a plain value that starts with @ ` % or an undefined alias, contains ': ' or
# ends with ':', on a block indicator or quoted value followed by text, on an unclosed [ or {,
# and on a tab-led line. When it fails, the retry re-parses every `key: value` line whose
# value holds an indicator character or ': ' as a quoted string (unless it already is one),
# so such a description is taken verbatim — a ' #' comment inside it becomes text — and a
# block-scalar description no longer parses. Leading tabs count as two spaces each for the
# same reason. Inside a quoted value a CRLF line break folds to a newline where an LF break
# folds to a space (measured against Bun 1.4.1). Not modelled: first-parse failures other
# than those listed; a \0 escape (bash cannot hold NUL); invalid UTF-8 bytes, which the loader
# replaces with U+FFFD.
# ---------------------------------------------------------------------------------------------
read_description() {
  LC_ALL=C awk '
    function rtrim(s) { sub(/[ \t\r]+$/, "", s); return s }
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
    # String.prototype.trim(): WhiteSpace and LineTerminator code points, as UTF-8 byte strings
    function js_trim(s,    i, k, changed) {
      do {
        changed = 0
        for (i = 1; i <= nws; i++) {
          k = length(WS[i])
          if (substr(s, 1, k) == WS[i]) { s = substr(s, k + 1); changed = 1 }
          if (length(s) >= k && substr(s, length(s) - k + 1) == WS[i]) { s = substr(s, 1, length(s) - k); changed = 1 }
        }
      } while (changed && s != "")
      return s
    }
    # closing quote on one physical line, honouring \" (double) and a doubled quote (single);
    # sets closepos
    function closes(s,    i, c) {
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (q == "\"" && c == "\\") { i++; continue }
        if (c == q) {
          if (q == "\047" && substr(s, i + 1, 1) == "\047") { i++; continue }
          closepos = i; return 1
        }
      }
      return 0
    }
    # does this key-line value make Bun'"'"'s first parse fail? (the shapes the retry exists for)
    function fails_first(s,    hdr, name, r) {
      s = rtrim(s)
      if (s == "" || s ~ /^#/) return 0
      if (s ~ /^[@`%]/) return 1
      if (s ~ /^\*/) { name = substr(s, 2); sub(/[ \t].*$/, "", name); return !find_anchor(name, cur) }
      if (s ~ /^[|>]/) { hdr = substr(s, 2); sub(/^[-+0-9]+/, "", hdr); return (hdr !~ /^[ \t]*(#.*)?$/) }
      if (s ~ /^"/ || s ~ /^\047/) {
        q = substr(s, 1, 1)
        if (!closes(substr(s, 2))) return 0
        r = substr(s, closepos + 2)
        return (r !~ /^[ \t]*(#.*)?$/)
      }
      if (s ~ /^\[/) return (s !~ /\][ \t]*(#.*)?$/)
      if (s ~ /^\{/) return (s !~ /\}[ \t]*(#.*)?$/)
      if (s ~ /^[&!][^ \t]*[ \t]+/) { sub(/^[&!][^ \t]*[ \t]+/, "", s); return fails_first(s) }
      s = rtrim(strip_comment(s))
      if (s ~ /: / || s ~ /:$/) return 1
      return 0
    }
    # would the retry rewrite this value as a quoted string? (the loader'"'"'s own test)
    function retry_quotes(s) {
      s = rtrim(s)
      if (s == "") return 0
      if (s ~ /^".*"$/ || s ~ /^\047.*\047$/) return 0
      if (s ~ /^\[.*\]$/) return 0
      return (s ~ /[][{}*&#!|>%@`]/ || s ~ /: /)
    }
    # the latest anchor of that name defined on a line before the given one (0 when none)
    function find_anchor(name, before,    k) {
      for (k = na; k >= 1; k--) if (anchor_name[k] == name && anchor_line[k] < before) return k
      return 0
    }
    function reset() { kind = "absent"; n = 0; split("", body); first = ""; first_set = 0; verbatim = 0; tagged = 0; tagtype = ""; nextline = 0; style = ""; chomp = "clip"; ind = 0; raw = ""; q = ""; alias_line = 0; base_indent = 0 }
    function verbatim_value(v) { kind = "plain"; first = v; first_set = 1; verbatim = 1; state = "done" }
    # one line after the key line, in state plain (value not started), block, plain or quoted
    function indent_of(s) { match(s, /^[ \t]*/); return RLENGTH }
    function feed(rawline, line,    d) {
      d = (line ~ /^[ \t]*$/) ? -1 : indent_of(line)
      if (state == "plain" && !first_set) {
        # the value has not started on the key line: skip blank and comment lines, then read
        # the first content line as if it were the value
        if (d < 0 || line ~ /^[ \t]*#/) return
        if (d <= base_indent) { state = "done"; return }
        nextline = 1; dispatch(ltrim(line), ltrim(rawline), 1); return
      }
      if (state == "block" || state == "plain") {
        if (d < 0 || d > base_indent) { body[n++] = line; return }
        state = "done"; return
      }
      if (state == "quoted") {
        raw = raw "\n" rawline
        if (closes(rawline)) state = "done"
      }
    }
    # the value part of the key line, or (from_next) the first content line after an empty one
    function dispatch(val, valraw, from_next,    hdr, flags, rest, name, k) {
      # the retry rewrites this line as a quoted string - unless the key is quoted, which the
      # rewrite does not match: then the value either parses as it is or not at all
      if (!from_next && retry_mode && retry_quotes(valraw)) {
        if (!key_quoted) { verbatim_value(val); return }
        if (fails_first(valraw)) { kind = "invalid"; state = "done"; return }
      }
      while (val ~ /^[&!][^ \t]*([ \t]+|$)/) {
        if (val ~ /^!/) {
          tag = val; sub(/[ \t].*$/, "", tag)
          if (tag == "!!str") tagged = 1
          else if (tag == "!!null") tagtype = "null"
          else if (tag == "!!int" || tag == "!!float") tagtype = "number"
          else if (tag == "!!bool") tagtype = "boolean"
        }
        sub(/^[&!][^ \t]*[ \t]*/, "", val); sub(/^[&!][^ \t]*[ \t]*/, "", valraw)
      }
      if (val == "" || val ~ /^#/) { kind = "plain"; state = "plain"; return }
      if (val ~ /^\*/) {
        name = substr(val, 2); sub(/[ \t].*$/, "", name)
        k = find_anchor(name, cur)
        if (k) { alias_line = anchor_line[k]; base_indent = anchor_indent[k]; dispatch(anchor_val[k], anchor_valraw[k], 0); return }
        kind = "invalid"; state = "done"; return
      }
      if (val ~ /^[|>]/) {
        hdr = substr(val, 2); sub(/^[-+0-9]+/, "", hdr)
        if (hdr ~ /^[ \t]*(#.*)?$/) {
          kind = "block"; style = substr(val, 1, 1); flags = substr(val, 2); sub(/[ \t].*$/, "", flags)
          chomp = (flags ~ /-/) ? "strip" : (flags ~ /\+/) ? "keep" : "clip"
          if (match(flags, /[1-9]/)) ind = base_indent + substr(flags, RSTART, 1)
          state = "block"; return
        }
        kind = "invalid"; state = "done"; return
      }
      if (val ~ /^"/ || val ~ /^\047/) {
        q = substr(val, 1, 1); kind = (q == "\"") ? "double" : "single"; raw = substr(valraw, 2)
        if (closes(raw)) {
          rest = substr(raw, closepos + 1)
          if (rest ~ /^[ \t\r]*(#.*)?$/) { state = "done"; return }
          kind = "invalid"; state = "done"; return
        }
        state = "quoted"; return
      }
      if (val ~ /^\[/) { kind = (val ~ /\][ \t\r]*(#.*)?$/) ? "list" : "invalid"; state = "done"; return }
      if (val ~ /^\{/) { kind = (val ~ /\}[ \t\r]*(#.*)?$/) ? "mapping" : "invalid"; state = "done"; return }
      if (from_next && val ~ /^-([ \t]|$)/) { kind = "list"; state = "done"; return }
      if (from_next && val ~ /^[^ \t#"\047][^ \t]*[ \t]*:([ \t]|$)/) { kind = "mapping"; state = "done"; return }
      kind = "plain"; first = val; first_set = 1; state = "plain"
    }
    BEGIN {
      keyre = "^(\"description\"|\047description\047|description)[ \t]*:([ \t\r]|$)"
      anykey = "^[ \t]*(\"[^\"]*\"|\047[^\047]*\047|[A-Za-z0-9_.-]+)[ \t]*:[ \t]+"
      na = 0; cur = 0; key_quoted = 0
      nws = split(" |\t|\n|\r|\013|\014|\302\240|\341\232\200|\342\200\200|\342\200\201|\342\200\202|\342\200\203|\342\200\204|\342\200\205|\342\200\206|\342\200\207|\342\200\210|\342\200\211|\342\200\212|\342\200\250|\342\200\251|\342\200\257|\342\201\237|\343\200\200|\357\273\277", WS, "|")
      N = 0
    }
    { L[++N] = $0 }
    END {
      # pass 1: leading tabs (the retry turns each into two spaces), anchors, and whether the
      # first parse fails anywhere
      retry_mode = 0
      for (i = 1; i <= N; i++) {
        if (substr(L[i], 1, 1) == "\t") retry_mode = 1
        while (substr(L[i], 1, 1) == "\t") L[i] = "  " substr(L[i], 2)
      }
      # key lines at any nesting level; the lines of a scalar value (deeper than its key, or up
      # to the closing quote) are not keys
      skip_indent = -1; inq = 0
      for (i = 1; i <= N; i++) {
        line = L[i]; sub(/\r$/, "", line); cur = i
        if (inq) { if (closes(line)) inq = 0; continue }
        if (line ~ /^[ \t]*$/ || line ~ /^[ \t]*#/) continue
        d = indent_of(line)
        if (skip_indent >= 0 && d > skip_indent) continue
        skip_indent = -1
        if (!match(line, anykey)) continue
        val = substr(line, RLENGTH + 1); vraw = substr(L[i], RLENGTH + 1)
        if (val ~ /^[ \t]*$/ || val ~ /^#/) continue
        if (fails_first(val)) retry_mode = 1
        if (val ~ /^&[^ \t]+([ \t]+|$)/) {
          name = substr(val, 2); sub(/[ \t].*$/, "", name)
          sub(/^&[^ \t]+[ \t]*/, "", val); sub(/^&[^ \t]+[ \t]*/, "", vraw)
          na++; anchor_name[na] = name; anchor_line[na] = i; anchor_indent[na] = d; anchor_val[na] = val; anchor_valraw[na] = vraw
        }
        v = val; sub(/^[&!][^ \t]*[ \t]*/, "", v); sub(/^[&!][^ \t]*[ \t]*/, "", v)
        if (v ~ /^[ \t]*$/ || v ~ /^#/) continue
        if (v ~ /^["\047]/) { q = substr(v, 1, 1); if (!closes(substr(v, 2))) { inq = 1; continue } }
        skip_indent = d
      }
      # pass 2: the description
      state = "seek"; reset()
      for (i = 1; i <= N; i++) {
        rawline = L[i]; line = rawline; sub(/\r$/, "", line); cur = i
        if (state != "quoted" && rawline ~ keyre) { reset(); state = "seek" }
        if (state == "seek") {
          if (rawline !~ keyre) continue
          key_quoted = (rawline ~ /^["\047]/)
          val = line; sub(/^[^:]*:[ \t]*/, "", val)
          valraw = rawline; sub(/^[^:]*:[ \t]*/, "", valraw)
          dispatch(val, valraw, 0)
          if (alias_line) {
            # the alias took the key-line value of the anchor; the lines after the anchor line belong to it too
            for (j = alias_line + 1; j <= N && state != "done"; j++) { rl = L[j]; ln = rl; sub(/\r$/, "", ln); feed(rl, ln) }
            state = "done"; alias_line = 0
          }
          continue
        }
        if (state == "done") continue
        feed(rawline, line)
      }
      out = ""
      if (kind == "block" && retry_mode && !key_quoted) kind = "invalid"
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
        # a quoted key-line value followed by indented lines does not parse
        for (i = 0; i < n; i++) if (body[i] !~ /^[ \t]*$/) { kind = "invalid"; break }
      } else if (kind == "plain") {
        started = 0; pend = 0
        if (first_set) { f = rtrim(strip_comment(first)); if (f != "") { out = f; started = 1 } }
        for (i = 0; i < n; i++) {
          l = body[i]
          if (l ~ /^[ \t]*$/) { if (started) pend++; continue }
          l = ltrim(l)
          if (l ~ /^#/) break
          c = strip_comment(l); commented = (c != l); c = rtrim(c)
          if (c != "") { if (!started) { out = c; started = 1 } else out = out (pend > 0 ? repeat("\n", pend) : " ") c; pend = 0 }
          if (commented) break
        }
        if (!started) kind = "empty"
      } else if (kind == "double" || kind == "single") {
        # CRLF breaks fold differently from LF breaks: mark them, and read a lone CR as a break
        gsub(/\r\n/, "\002\n", raw); gsub(/\r/, "\n", raw)
        L2 = length(raw); endpos = 0
        for (i = 1; i <= L2; i++) {
          c = substr(raw, i, 1)
          if (kind == "double" && c == "\\") { i++; continue }
          if (c == q) {
            if (kind == "single" && substr(raw, i + 1, 1) == "\047") { i++; continue }
            endpos = i; break
          }
        }
        if (endpos == 0) kind = "unterminated"
        else {
          # escaped whitespace is kept through folding: \003 stands for a space, \004 for a tab
          s = substr(raw, 1, endpos - 1); L2 = length(s); i = 1
          while (i <= L2) {
            c = substr(s, i, 1)
            if (kind == "double" && c == "\\") {
              d = substr(s, i + 1, 1)
              if (d == "\n" || d == "\002") {
                i += (d == "\002") ? 3 : 2
                k = 0
                while (1) {
                  while (i <= L2 && substr(s, i, 1) ~ /[ \t\002]/) i++
                  if (i <= L2 && substr(s, i, 1) == "\n") { k++; i++; continue }
                  break
                }
                out = out repeat("\n", k); continue
              }
              if (d == "n") out = out "\n"
              else if (d == "t" || d == "\t") out = out "\004"
              else if (d == " ") out = out "\003"
              else if (d == "r") out = out "\r"
              else if (d == "a") out = out "\007"
              else if (d == "b") out = out "\010"
              else if (d == "e") out = out "\033"
              else if (d == "f") out = out "\014"
              else if (d == "v") out = out "\013"
              else if (d == "N") out = out "\302\205"
              else if (d == "_") out = out "\302\240"
              else if (d == "L") out = out "\342\200\250"
              else if (d == "P") out = out "\342\200\251"
              else if (d == "0") out = out ""
              else if (d == "\"" || d == "\\" || d == "/") out = out d
              else if (d == "x" || d == "u" || d == "U") {
                k = (d == "x") ? 2 : (d == "u") ? 4 : 8
                h = substr(s, i + 2, k)
                if (length(h) == k && h ~ /^[0-9a-fA-F]+$/) {
                  code = hex2dec(h); i += 2 + k
                  if (code >= 55296 && code < 56320 && substr(s, i, 2) == "\\u") {
                    h = substr(s, i + 2, 4)
                    if (length(h) == 4 && h ~ /^[0-9a-fA-F]+$/) { lo = hex2dec(h); if (lo >= 56320 && lo < 57344) { code = 65536 + (code - 55296) * 1024 + (lo - 56320); i += 6 } }
                  }
                  ch = utf8(code)
                  if (code == 32) ch = "\003"; else if (code == 9) ch = "\004"
                  out = out ch; continue
                }
                out = out "\\" d
              }
              else out = out "\\" d
              i += 2; continue
            }
            if (kind == "single" && c == "\047") { out = out "\047"; i += 2; continue }
            if (c == "\002") { i++; continue }
            if (c == "\n") {
              crlf = (i > 1 && substr(s, i - 1, 1) == "\002")
              out = rtrim(out)
              k = 0; j = i + 1
              while (1) {
                while (j <= L2 && substr(s, j, 1) ~ /[ \t\002]/) j++
                if (j <= L2 && substr(s, j, 1) == "\n") { k++; j++; continue }
                break
              }
              out = out repeat("\n", k) ((k > 0) ? (crlf ? "\n" : "") : (crlf ? "\n" : " "))
              i = j; continue
            }
            out = out c; i++
          }
          gsub(/\003/, " ", out); gsub(/\004/, "\t", out)
        }
      }
      # the plugin loader: description.trim() || null
      out = js_trim(out)
      if ((kind == "block" || kind == "double" || kind == "single" || kind == "plain") && out == "") kind = "empty"
      cont = nextline
      if (kind == "plain") for (i = 0; i < n; i++) if (body[i] !~ /^[ \t]*$/) cont++
      # A one-line plain scalar that the YAML 1.2 core schema resolves to a number, boolean or
      # null is not a string: the project-agent loader drops the agent, a plugin agent shows
      # the JavaScript value (0x1f as 31, .inf as Infinity). A tag (!!str) makes it a string.
      if (kind == "plain" && cont - nextline == 0 && !verbatim && tagtype != "") kind = tagtype
      else if (kind == "plain" && cont - nextline == 0 && !verbatim && !tagged) {
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
# of the file. Sets PRODUCT_STATUS (verified | not-verified), PRODUCT_REASON, PRODUCT_ERRORS
# and PRODUCT_WARNINGS (one "path: message" per line). A report counts only when it is
# complete and consistent: the JSON must be the validator's report object (success, manifest,
# contents) and the plain report must carry its manifest heading and closing verdict line; a
# success must come with exit 0 and no agent error, a failure with exit 1 and at least one
# agent error to show for it. Anything else — a crash, a truncated report, an unrelated JSON
# object, a failure that names no problem — leaves the frontmatter unverified rather than
# passed.
# ---------------------------------------------------------------------------------------------
PRODUCT_STATUS="not-verified"; PRODUCT_REASON=""; PRODUCT_ERRORS=""; PRODUCT_WARNINGS=""
product_verdict() {
  if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    PRODUCT_REASON="'$CLAUDE_BIN' not found on PATH"
    return 0
  fi
  local base out rc parsed
  TMP_PLUGIN=$(mktemp -d 2>/dev/null) || { TMP_PLUGIN=""; PRODUCT_REASON="could not create a temporary directory"; return 0; }
  base=$(basename -- "$AGENT_FILE")
  mkdir -p "$TMP_PLUGIN/.claude-plugin" "$TMP_PLUGIN/agents"
  printf '{"name":"validate-agent-check"}\n' > "$TMP_PLUGIN/.claude-plugin/plugin.json"
  cp -- "$AGENT_FILE" "$TMP_PLUGIN/agents/$base"

  out=$("$CLAUDE_BIN" plugin validate "$TMP_PLUGIN" --json 2>&1) && rc=0 || rc=$?
  parsed=0
  if [ $rc -le 1 ] && command -v jq >/dev/null 2>&1 \
     && printf '%s' "$out" | jq -e 'type == "object" and (.success | type) == "boolean" and (.manifest | type) == "object" and (.contents | type) == "array"' >/dev/null 2>&1; then
    parsed=1
    if [ "$(printf '%s' "$out" | jq -r '.manifest.errors | length')" != "0" ]; then
      PRODUCT_REASON="the validator refused the temporary plugin: $(printf '%s' "$out" | jq -r '.manifest.errors[0].message')"
      return 0
    fi
    PRODUCT_ERRORS=$(printf '%s' "$out" | jq -r '.contents[]? | select(.type == "agent") | .errors[]? | "\(.path): \(.message)"')
    PRODUCT_WARNINGS=$(printf '%s' "$out" | jq -r '.contents[]? | select(.type == "agent") | .warnings[]? | "\(.path): \(.message)"')
    local success
    success=$(printf '%s' "$out" | jq -r '.success')
    if [ "$success" = "true" ] && { [ $rc -ne 0 ] || [ -n "$PRODUCT_ERRORS" ]; }; then
      PRODUCT_REASON="'$CLAUDE_BIN plugin validate' reported success with exit $rc and $(printf '%s\n' "$PRODUCT_ERRORS" | LC_ALL=C awk 'NF { n++ } END { print n + 0 }') agent error(s)"
      PRODUCT_ERRORS=""; PRODUCT_WARNINGS=""; return 0
    fi
    if [ "$success" = "false" ] && { [ $rc -ne 1 ] || [ -z "$PRODUCT_ERRORS" ]; }; then
      PRODUCT_REASON="'$CLAUDE_BIN plugin validate' reported failure (exit $rc) without an agent diagnostic"
      PRODUCT_ERRORS=""; PRODUCT_WARNINGS=""; return 0
    fi
  fi
  if [ $parsed -eq 0 ]; then
    # No jq, or a Claude Code older than 2.1.259 (no --json): read the plain report. Items are
    # "  ❯ path: message" lines under the "Validating agent: <file>" section.
    out=$("$CLAUDE_BIN" plugin validate "$TMP_PLUGIN" 2>&1) && rc=0 || rc=$?
    if [ $rc -gt 1 ] || ! printf '%s\n' "$out" | LC_ALL=C awk '/^Validating plugin manifest: /{h=1} /Validation (passed|failed)/{v=1} END{exit !(h && v)}'; then
      PRODUCT_REASON="'$CLAUDE_BIN plugin validate' did not complete (exit $rc): ${out%%$'\n'*}"
      return 0
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
    local verdict
    verdict=$(printf '%s\n' "$out" | LC_ALL=C awk '/Validation passed/ { v = "passed" } /Validation failed/ { v = "failed" } END { print v }')
    if [ "$verdict" = "passed" ] && { [ $rc -ne 0 ] || [ -n "$PRODUCT_ERRORS" ]; }; then
      PRODUCT_REASON="'$CLAUDE_BIN plugin validate' reported success with exit $rc and an agent error"
      PRODUCT_ERRORS=""; PRODUCT_WARNINGS=""; return 0
    fi
    if [ "$verdict" = "failed" ] && { [ $rc -ne 1 ] || [ -z "$PRODUCT_ERRORS" ]; }; then
      PRODUCT_REASON="'$CLAUDE_BIN plugin validate' reported failure (exit $rc) without an agent diagnostic"
      PRODUCT_ERRORS=""; PRODUCT_WARNINGS=""; return 0
    fi
  fi
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
error_count=0; warning_count=0

# Check 1: File exists and can be read
if [ ! -f "$AGENT_FILE" ]; then
  echo "❌ File not found: $AGENT_FILE"
  exit 1
fi
if [ ! -r "$AGENT_FILE" ]; then
  echo "❌ File not readable: $AGENT_FILE"
  exit 1
fi
say "✅ File exists"

# The loader strips a UTF-8 BOM and reads CRLF line ends as line ends; read the file that way.
# RAW keeps the CRs (quoted values fold them differently), CONTENT has them removed. Every
# reader below consumes its whole input: an early-exiting reader (head, grep -q) would end the
# writer with SIGPIPE on a file larger than the pipe buffer and, under pipefail, the script.
BOM=$(printf '\357\273\277')
RAW=$(cat -- "$AGENT_FILE"; printf x); RAW=${RAW%x}
HAS_BOM=0
if [ "${RAW#"$BOM"}" != "$RAW" ]; then HAS_BOM=1; RAW=${RAW#"$BOM"}; fi
CONTENT=$(printf '%s' "$RAW" | tr -d '\r'; printf x); CONTENT=${CONTENT%x}
HAS_CR=0
case "$RAW" in *$'\r'*) HAS_CR=1 ;; esac

# Check 2: Starts with ---
FM_OUT=$(printf '%s\n' "$RAW" | frontmatter_cut)
FM_META=${FM_OUT%%$'\n'*}
if [ "$FM_META" = "$FM_OUT" ]; then FRONTMATTER_RAW=""; else FRONTMATTER_RAW=${FM_OUT#*$'\n'}; fi
FM_END=0; FM_CUT=0
if [[ "$FM_META" =~ ^END=([0-9]+)\ CUT=([01])$ ]]; then FM_END="${BASH_REMATCH[1]}"; FM_CUT="${BASH_REMATCH[2]}"; fi
FIRST_LINE=${CONTENT%%$'\n'*}
if ! [[ "$FIRST_LINE" =~ ^---[[:space:]]*$ ]]; then
  echo "❌ File must start with YAML frontmatter (---)"
  exit 1
fi
say "✅ Starts with frontmatter"

# Check 3: Has closing ---
if [ "$FM_END" -eq 0 ]; then
  echo "❌ Frontmatter not closed (missing second ---)"
  exit 1
fi
say "✅ Frontmatter properly closed"
[ $HAS_CR -eq 1 ] && say "💡 File uses CRLF line endings (LF is the convention; the parse verdict below covers them)"
[ $HAS_BOM -eq 1 ] && say "💡 File starts with a UTF-8 byte order mark (loaded fine; not needed)"

FRONTMATTER=$(printf '%s\n' "$FRONTMATTER_RAW" | tr -d '\r')
SYSTEM_PROMPT=$(printf '%s\n' "$CONTENT" | awk -v end="$FM_END" 'NR > end')

DESC_OUT=$(printf '%s\n' "$FRONTMATTER_RAW" | read_description)
DESC_META=${DESC_OUT%%$'\n'*}
if [ "$DESC_META" = "$DESC_OUT" ]; then DESCRIPTION=""; else DESCRIPTION=${DESC_OUT#*$'\n'}; fi
DESC_KIND="absent"; DESC_LINES=0
if [[ "$DESC_META" =~ ^KIND=([a-z-]+)\ LINES=([0-9]+)$ ]]; then
  DESC_KIND="${BASH_REMATCH[1]}"; DESC_LINES="${BASH_REMATCH[2]}"
fi

# Check 4: Frontmatter parse — the product's verdict
PARSE_FAILED=0; DESC_PRODUCT_ERROR=0; NOT_MD=0
case "$(basename -- "$AGENT_FILE")" in
  *.md|*.MD|*.Md|*.mD) product_verdict ;;
  *) NOT_MD=1; PRODUCT_STATUS="skipped" ;;
esac
if [ "$PRODUCT_STATUS" = "verified" ] && [ -n "$PRODUCT_ERRORS" ]; then
  while IFS= read -r line; do
    case "$line" in
      frontmatter:*) PARSE_FAILED=1 ;;
      description:*) DESC_PRODUCT_ERROR=1 ;;
    esac
  done <<< "$PRODUCT_ERRORS"
fi

if [ $PRINT_DESCRIPTION -eq 1 ]; then
  if [ $NOT_MD -eq 1 ]; then echo "not an .md file: the loader and 'claude plugin validate' read agents/*.md only" >&2; exit 1; fi
  if [ $PARSE_FAILED -eq 1 ] || [ $DESC_PRODUCT_ERROR -eq 1 ]; then echo "${PRODUCT_ERRORS%%$'\n'*}" >&2; exit 1; fi
  case "$DESC_KIND" in
    block|plain|double|single) printf '%s\n' "$DESCRIPTION" ;;
    *) echo "description: $DESC_KIND" >&2; exit 1 ;;
  esac
  if [ "$PRODUCT_STATUS" != "verified" ]; then echo "frontmatter not verified: $PRODUCT_REASON" >&2; exit 2; fi
  exit 0
fi

if [ "$FM_CUT" -eq 1 ]; then
  echo "❌ '---' inside the frontmatter ends it early: the loader stops at the first '---' it finds (line $FM_END), so everything after it — the rest of that value, model, color, tools — is dropped and read as system prompt"
  error_count=$((error_count + 1))
fi

echo ""
echo "Checking frontmatter with 'claude plugin validate'..."
if [ $NOT_MD -eq 1 ]; then
  echo "❌ Agent files are agents/<name>.md: 'claude plugin validate' skips '$(basename -- "$AGENT_FILE")', so its frontmatter was not checked"
  error_count=$((error_count + 1))
elif [ "$PRODUCT_STATUS" = "verified" ]; then
  if [ -z "$PRODUCT_ERRORS" ]; then
    echo "✅ Frontmatter parses (claude plugin validate)"
  else
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      echo "❌ $line"
      error_count=$((error_count + 1))
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
    invalid)
      echo "❌ description is not a readable YAML value here (text after a quoted value, an indicator on a continuation line, an undefined alias, or a block scalar in a file that needs the loader's retry)"
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
  case "$SYSTEM_PROMPT" in
    *"You are"*|*"You will"*|*"Your"*) ;;
    *)
      echo "⚠️  System prompt should use second person (You are..., You will...)"
      warning_count=$((warning_count + 1)) ;;
  esac

  # Check for structure
  PROMPT_LC=$(printf '%s' "$SYSTEM_PROMPT" | tr '[:upper:]' '[:lower:]')
  case "$PROMPT_LC" in
    *responsibilities*|*process*|*steps*) ;;
    *) echo "💡 Consider adding clear responsibilities or process steps" ;;
  esac
  case "$PROMPT_LC" in
    *output*) ;;
    *) echo "💡 Consider defining output format expectations" ;;
  esac
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
