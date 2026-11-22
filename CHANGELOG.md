# Changelog

All notable changes to Task Bridge are documented in this file.

## [0.3.1] - 2026-11-22

### Real Jira Cloud Verification Fixes
- **Plain-string Jira sprint names & multi-sprint grouping**: Updated `extractSprintInfo` to accept plain sprint name strings (`"sprint": "Sprint 42"`) as returned by `orca jira search` / `orca jira list`, tracked all open sprints in `activeSprints`, and grouped Queue cards by sprint when multiple sprints are open simultaneously.
- **CLI query errors vs. expired token warning**: Distinguished `ok: false` CLI responses (such as invalid `sprintJql` syntax) as `Jira Query Error` displaying `error.message` directly, reserving the expired API token warning strictly for connected sites that return 0 tickets and 0 projects.
- **Derived `Unassigned in Sprint` JQL**: Derived the unassigned sprint query from the user's configured `sprintJql` (`deriveUnassignedSprintJql`) so project and board filters are respected.
- **Safe Jira assignment & ticket creation validation**: Used `sites[].accountId` from `orca jira connection` directly for `orca jira assignee set --to-id`, avoided selecting the first unfiltered user from `orca jira assignee list`, and threw an explicit error when `orca jira create` does not return a valid ticket key instead of falling back to `${projectKey}-1`.
- **Staged `proposedAcceptanceCriteria` approval (`Accept Proposed AC`)**: Stored `Propose AC` results in `proposedAcceptanceCriteria` and added an **Accept Proposed AC** action (`tasks.acceptProposedAc`) in Workbench so unapproved criteria never overwrite `acceptanceCriteria` before `Verify AC`.
- **Truncation badge wording**: Updated the truncation badge in Queue to `Showing X (limit reached)`.
- **Bounded startup hook initialization**: Added immediate startup repository scanning with a 400ms `Promise.race` bound on `initLookupPromise` so `agent.tool.before` never blocks even if `workspace.changed` is not emitted on activation.

## [0.3.0] - 2026-11-22

### Sprint / Cycle Scope, Undefined Ticket Guards, Unlinked Worktree Registration & Hook Caching
- **Sprint / Cycle scope**: Added `'sprint'` scope filter (`Sprint` pill in Queue). Queries Jira via `orca jira search <sprintJql>` (configurable via `sprintJql` setting, defaulting to `sprint in openSprints() AND assignee = currentUser() AND statusCategory != Done`) and Linear via `orca linear list-issues --cycle active`, while showing an informational notice when Notion is selected.
- **Sprint Header**: Extracted sprint and cycle names from ticket payloads and rendered a Sprint Header card in Queue.
- **Undefined ticket warnings & Propose AC**: Flagged tickets lacking a description (`No Description`) or Acceptance Criteria (`Missing AC`) in Queue and Workbench, warned before/upon dispatch, and added **Propose AC** (`tasks.proposeAcceptanceCriteria`) to launch a read-only analyst agent that drafts criteria from the ticket and codebase and posts them as a ticket comment (`orca jira comment add`) without modifying the ticket description.
- **Register unlinked worktree work**: Added **Create Ticket** (`tasks.createFromWorkspace` + `tasks.discoverJiraMetadata`) when the focused worktree has no linked ticket, deriving the title and description from the Git branch and recent commits (`orca jira create`), assigning the created ticket to the user, and linking/renaming the worktree.
- **Unassigned in Sprint**: Added an **Unassigned in Sprint** collapsible section in Sprint scope with 1-click **Assign to Me** (`tasks.assignToMe`).
- **Zero-I/O `agent.tool.before` hook & negative config caching**: Cached negative `.task-bridge.json` lookups (`null` with `mtimeMs` tracking), moved repository scanning to worker activation and `workspace.changed`, and removed all `workspace.list` / filesystem I/O from `agent.tool.before` so tool calls never hit Orca's 2000ms hook timeout in repositories without `.task-bridge.json`.
- **Silent Jira credential / expired token detection**: Probed `orca jira project list` whenever a connected Jira site returns 0 tickets; surfaced a clear `"Jira returned no data: check your API token in Settings → Jira"` warning callout, tracked `lastSyncedWithDataAt` (`Last synced with data`), and marked cached tickets as potentially outdated (`Cached (may be outdated)`).
- **Configurable `syncLimit` & truncation indicator**: Added `syncLimit` setting (`50`, `100`, `200`, `500`, default `100`) and displayed a limit indicator in Queue when provider results are truncated.

## [0.2.0] - 2026-11-16

### Repo Configuration, Skills, Guards & Multi-Repo (`A1`–`A7`, `N1`–`N3`)
- **Shared `.task-bridge.json` repository config (`A1`)**: Loaded `.task-bridge.json` cleanly with strict symlink/size/containment checks and clear override precedence (`defaults < .task-bridge.json < RepoProfile user overrides`), exposing config source badges in Workbench.
- **Custom AC headings, branch types & status aliases (`A2`–`A4`)**: Added configurable `acceptanceCriteriaHeadings`, keyword/`issueType`-based `branchTypes` rules (with manual override selector in Workbench), and `statusAliases` for status classification and Jira/Linear transitions.
- **Allowlisted worktree setup commands (`A5`)**: Added `worktreeSetupCommands` filtered strictly through `parseWorktreeSetupCommand` (`npm ci`, `npm install`, `pnpm install`, `yarn install`, `composer install`, `uv sync`) and gated behind per-repo SHA-256 hash approval (`tasks.approveRepoSetup`).
- **Chained/parent subtask base branches & multi-repo dispatch (`A6`, `A7`)**: Added `subtaskBase: "default" | "parent" | "chain"` (`--base` on `worktree create`) in `dispatchChildren`, and `repoIds` multi-repository dispatch tracking `linkedWorkspaces`.
- **Safe `SKILL.md` discovery & workflow skill prompts (`N1`)**: Added symlink-safe `SKILL.md` discovery across `.agents/skills`, `.claude/skills`, `.codex/skills`, `.gemini/skills`, `.cursor/skills`, `.github/skills`, per-phase `workflow` skill mapping (`dispatch`, `verify`, `feedback`, `prFeedback`), and `planGate: "skill" | "plugin" | "both"`.
- **Cross-agent Git write guard (`N2`)**: Added `guard.denyGitWrites` in `agent.tool.before` across all agents via `findDeniedGitWriteInToolCall` even when Plan Lock is disabled.
- **PR review feedback tracking & follow-up (`N3`)**: Counted open PR review feedback (`unresolvedPrCommentsCount`) during PR detection and added `tasks.sendPrFeedback` with Fleet badges and `Send PR Feedback` action.

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
