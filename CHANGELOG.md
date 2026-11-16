# Changelog

All notable changes to Task Bridge are documented in this file.

## [Unreleased]

### Security (S1–S7)
- **Prompt isolation (`S1`)**: Stripped zero-width/bidi invisible characters (`\u200B-\u200F`, `\u202A-\u202E`, `\u2060-\u2064`, `\u2066-\u2069`, `\uFEFF`), neutralized forged `</untrusted_ticket_data>` closing-tag variants, moved ticket titles/metadata (`Title`, `Project`, `Type`, `Assignee`, `Parent`) inside `<untrusted_ticket_data>` in dispatch, AC verification, and comment-feedback prompts, and removed untrusted ticket titles from the `agent.prompt.before` reminder.
- **Plan-First Gate allowlist (`S2`)**: Switched `agent.tool.before` from regex denylist to per-agent read-only tool and command allowlists (supporting quote-aware read-only inspection and multi-agent tools), failing closed on worker restart by hydrating lookup maps from storage on activation.
- **Hook & command isolation (`S3`)**: Removed `cachedActiveTask` fallback from `agent.prompt.before`, `agent.tool.before`, and `agent.status.changed`, and restricted `taskBridge.completeActive` to tickets linked to the currently focused workspace.
- **Branch key matching (`S4`)**: Enforced word/delimiter boundaries when auto-linking branches and guarding `--delete-branch` during worktree cleanup (`ENG-6` no longer matches `feature/ENG-674_x`).
- **Setup file copy (`S5`)**: Added recursive symlink/junction and source-root containment filtering inside `cpSync` in `copyLocalSetupFiles`.
- **Demo ticket isolation (`S6`)**: Tagged demo seed tickets with `demo: true` and blocked all real provider transitions, comments, and `--reference`/`--linear-issue` flags for demo items.
- **Secret redaction (`S7`)**: Redacted full Atlassian `ATATT3x...` tokens (including `=`), `Basic ...` headers, Slack (`xox[abpr]-...`), and AWS (`AKIA...`) credentials.
