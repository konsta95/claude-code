<!-- BEGIN CODEX PR REVIEW RULES v1 -->
# Code Review Rules

These instructions apply only to native Codex pull-request reviews. They do not mandate pull requests or approvals, authorize edits, or change repository authoring workflows.

- Report only actual material defects introduced by this PR. Give a changed file:line, a reachable trigger, expected versus actual behavior, and a reproducer or decisive source-path proof. Unvalidated or speculative concerns, missing newly requested tests, style, naming, and unrelated existing debt are advisory.
- Existing required executable acceptance checks retain their current role; actual failures are not waived. An unavailable interpreter or check is an honest unvalidated coverage gap, never PASS and never an automatic code-fix request.
- Review is read-only: do not edit, invoke a fix agent, or start an automatic fix/re-review loop.
- Follow-ups resolve original unresolved findings and evidence-backed serious regressions caused by fixes. No new nits; do not reopen a closed finding without new evidence.
- Use current supported contracts and documented safe exceptions. Do not revive retired CodeRabbit or mutation-testing requirements.

## Repository-specific checks

- Managed and telemetry boundaries — for mods/sec-default and mods/telemetry, flag a demonstrated introduced bypass of the pinned caller/provider tier, managed MCP allowlist or first-party analytics opt-out/closed-value validation. Managed policy continuing past user hooks, a failed policy read failing closed, one-burst memoization, optional telemetry absence and collector pass-through are intentional. Prove a real boundary breach; do not ban all telemetry, shell probes or installed plugins by name.
- Instruction loader — for mods/agents-md, preserve the four instructionFiles modes, project CLAUDE precedence in fallback mode, project-file framing/order, per-loop deduplication and root/session reset. Flag changed code that demonstrably leaks managed-only filtered instructions or attaches instructions to the wrong project/agent. Legacy option migration and the README's engine-only attachment/symlink/add-dir limitations are accepted compatibility paths; do not invent full CLAUDE-loader parity the mod does not claim.
- Read-only diff and upstream scope — for mods/diff, flag introduced wrong-repository/base hunks, unsafe joined ref/path reads or a write disguised as its read-only git flow. Keeping previous data while git is unavailable/transient, folding generated/test/lock files and respecting a user's closed pane are deliberate. Review changed local code and actual workflow contracts; an upstream sync does not require rebuilding the closed-source Claude engine or rewriting all bundled review plugins.

## Relevant existing checks

Use current CI results and only affected existing checks when authorized and available in a disposable test environment. These examples do not require all commands on every PR. Missing prerequisites remain unvalidated; do not use live providers, deploy/provision resources, or run mutating snapshot/replay builders as a review.

- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test mods/<changed-mod>` — Existing supported engine kit for affected built-in mod; ensure the binary actually supports plugin test.
- `tsc -p mods/tsconfig.json` — Existing Mod tests CI typecheck against committed mods/types and mod-specific declarations.

<!-- END CODEX PR REVIEW RULES v1 -->
