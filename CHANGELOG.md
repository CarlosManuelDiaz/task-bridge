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

### Reliability & Functional Fixes (F1–F17)
- **Storage concurrency (`F1`)**: Added a promise mutex (`withTasksLock` / `patchTaskLocked`) and re-read latest storage state before merging sync/comment updates so slow `tasks.sync` calls never overwrite concurrent `approvePlan` or `dispatch` updates.
- **Duplicate launch guards & incremental child dispatch (`F2`)**: Guarded against concurrent duplicate dispatches, persisted workspace/branch links prior to `agent.launch`, checked `agents.list` for already active `working`/`waiting` agents, and saved each `dispatchChildren` child immediately inside the loop.
- **Fleet Clear Finished safety (`F3`)**: Skipped live `working`/`waiting` cards during `clearFinished` and aborted sweeping cleanly if `workspace.list` fails.
- **Real AC verification verdict (`F4`)**: Updated `buildAcVerificationPrompt` to write `.orca/task-bridge/ac-<KEY>.json`, parsed `READY_FOR_REVIEW` / `CHANGES_REQUIRED` into `'verified'` / `'failed'` (or `'unknown'` when missing/invalid), ignored `done` events lacking `terminalId`, and kept AC Reviewer terminals strictly read-only in `agent.tool.before` even after main plan approval.
- **Git/PR detection (`F5`)**: Only attached `OPEN` PRs, resolved base branch dynamically via `origin/HEAD` (fallback `main`/`master`), and prevented `main` commits from leaking into empty feature branch summaries.
- **Status, Done transition & Notion errors (`F6`, `F7`, `F8`)**: Fixed status mapping for `"Not started"`, `"Listo para QA"`, `"Revisión"`, and `"Finalizada"`; excluded canceled/Won't Do transitions when moving to `Done`; verified `res.ok` on Notion status/comment requests.
- **AC parsing, issue kinds, ADF, Jira `_` keys & branch hints (`F9`–`F17`)**: Extracted AC from untruncated multi-language descriptions (`**...**`, `hN.`, `Algo:`); prioritized explicit `issueType` in `mapIssueKind`; sorted and expanded active comment sync to 15 cards; cleared stale links when reassigning repos; supported `MY_PROJ-12` underscore keys; added Jira Cloud ADF text extraction; preserved `children.nodes` and hydrated active Jira issues; prevented `OPENAI_API_KEY` from triggering uppercase branch hints; and added live-session confirmation + Plan Lock preservation to `sendCommentFeedback`.
