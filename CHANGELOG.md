# Changelog

All notable changes to Task Bridge are documented in this file.

## [0.3.3] - 2026-11-22

### Security
- **Plan Lock shell classifier bypasses closed**: `isReadOnlyShellCommand` now rejects `$(...)` and backticks inside double quotes, unquoted `(`/`)`/`{`/`}` (subshells, PowerShell subexpressions and script blocks), git global options that run programs (`-c`, `--config-env`, `--exec-path`), git arguments that write files or spawn programs (`--output`, `--ext-diff`, `-O`/`--open-files-in-pager`), `rg --pre`, `ag --pager`, `fd -x/-X/--exec`, `tree -o/-R` and `file -C`. `git branch` is only allowed with listing flags.
- **`guard.denyGitWrites` hardening**: Detects denied subcommands when git is invoked by path (`/usr/bin/git`), as `git.exe`, through wrappers (`env`, `command`, `xargs`) or nested shells (`sh -c "git push"`).
- **Cold-start fail-closed**: When startup hydration exceeds the 400ms hook bound, `agent.tool.before` now denies mutating tool calls (read-only calls still pass) until hydration finishes, capped at 10 seconds, instead of failing open.
- **Repo config can no longer relax the Plan Lock**: A committed `.task-bridge.json` may only tighten `requirePlanApproval` / `enforcePlanLock` (only the user's own repo profile can turn them off), and `planGate: "skill"` becomes `both` when the user enabled the plugin gate.
- **No unlocked window at agent start**: With Plan Lock enforced, the worktree is created without `--agent`; the lock and workspace link are persisted (and the hook maps rebuilt) before the agent is launched.
- **Multi-repo dispatches stay guarded**: `buildState` now rebuilds the hook maps with `rebuildLookupMaps`, so secondary repos (`linkedWorkspaces`) and AC reviewer/proposer terminals keep their lock and ticket context; each repo is linked as soon as its worktree exists.
- **Stale AC artifacts**: Previous `ac-<KEY>.json` / `proposed-ac-<KEY>.json` files are removed before a new reviewer/proposer launches, so an old verdict or proposal is never read back as the new result.

### Fixed
- **Verify AC / Propose AC with Claude Code**: The AC reviewer/proposer write guards accepted only repo-relative paths, but Claude Code's `Write` tool always sends absolute paths, so verdict/proposal files were always denied. Absolute paths are now accepted when they resolve exactly to `<worktree>/.orca/task-bridge/ac-<KEY>.json` (or `proposed-ac-<KEY>.json`).
- **Plan approval lost during dispatch**: The dispatch result used to overwrite the stored task with the snapshot read at the start (45s+ earlier), resetting a plan approved meanwhile. Dispatch now returns only the fields it decided and merges them onto the current task, keeping a newer approval. Same for subtask fan-out.
- **PR URL / completion comment posted on the wrong ticket**: Workbench drafts (PR URL, completion comment, feedback text) are only sent for the ticket selected in Workbench, and are cleared whenever the selection changes.
- **Subtask repo precedence**: A repo explicitly assigned to a subtask now wins over the parent's auto-resolved repo in `Dispatch Pending Subtasks`, which also gained the double-click guard `tasks.dispatch` already had.
- **Multi-repo dispatch aborting on repo 2**: Repo 1's terminal is no longer carried into repo 2's launch, where the duplicate-agent guard rejected it.
- **"Sync Tickets" command (`Mod+Shift+Y`)** now actually syncs. All syncs (panel, command, auto-sync) are serialized, so overlapping runs no longer race and the last scope click wins.
- **Notion transitions without token or page ID** are reported as not synced (with the reason) instead of moving the ticket only locally; transition errors name the real provider instead of always `LINEAR`.
- **`statusAliases` from `.task-bridge.json`** now apply to In Review / Done transitions, not only to dispatch.
- **Commit summary** is rebuilt on every detection instead of growing on each agent turn (`a; b (a; b) (a; b)…`).
- **`worktreeSetupCommands` on Windows**: `npm`/`pnpm`/`yarn`/`composer` shims run through `cmd.exe /d /s /c` (fixed allowlisted argv), and failures are shown as a notification instead of being ignored.
- **AC reviewer without a terminal id** is reported as `unknown` with an explanation instead of staying `running` forever.
- **Lost updates**: `detectPr`, `cleanupWorktree`, `addManual` and `delete` now write under the tasks lock and patch only their own fields; `addManual` keeps the links of an existing ticket with the same key.
- **Panel error handling**: Every action surfaces worker errors in the banner (previously ~15 handlers dropped them, e.g. the Linear "missing In Review state" explanation), and a failed initial load no longer leaves the panel stuck on "Loading".
- **Archive Worktree** now asks for a second press to confirm before removing the worktree folder, and is only offered for worktrees Task Bridge created itself (`worktreeCreatedByPlugin`; worktrees linked from the focused workspace or Create Ticket are never removed from the panel).
- **Buttons no longer fire twice**: every action (sync, dispatch, subtasks, Verify/Propose AC, transitions, archive, feedback…) runs once at a time and its buttons are disabled while it runs.
- **Comments only after a confirmed transition**: Jira and Linear completion comments and PR attachments are posted only when the status change succeeded; Jira failures now report the CLI's reason.
- **Verify AC skill guidance**: `workflow.verify` skills from `.task-bridge.json` were computed but never reached the reviewer prompt; they now do.
- **Verdict files on Windows**: The launch prompt replaces `"` with `'` on Windows, so agents could write single-quoted JSON and Verify AC ended as `unknown`. Prompts now ask for strict JSON in words, and verdict/proposal readers accept the single-quoted form.
- **Propose AC / Create Ticket / proposer results** no longer fall back to an unrelated "first worktree": Propose AC picks the ticket's worktree, its assigned repo, the focused worktree or the only open repo (or asks you to choose); Create Ticket only registers the focused worktree, refuses one already linked to another ticket, and only shows the ticket as In Progress when Jira accepted the transition.
- **Notion**: Sync honours `syncLimit` (up to 500 instead of a fixed 100), and every Notion request has a 20s timeout (combined with the caller's abort signal).
- **`copyLocalSetupFiles`** never creates folders or copies files through a symlinked parent in the new worktree.
- **`agent.prompt.before`**: turning off "Include completion runbook" only removes the runbook, not the ticket context and follow-up reminder.
- **Event handlers** (`workspace.changed`, `agent.status.changed`) log redacted errors instead of producing unhandled rejections.
- **Prompt boundaries**: Subtask fan-out notes only use validated keys (provider titles stay inside `<untrusted_ticket_data>`), and the user's own feedback instruction is placed outside the untrusted block.
- **Jira comments in ADF** (Jira Cloud API v3) are converted to text instead of `[object Object]`.
- **Completion runbook** uses `statusAliases.inReview` and tells the agent to pick the real (possibly localised) review state instead of hard-coding `In Review`.
- **Sprints**: `closedSprints` is no longer reported as the active sprint; a `sprintJql` starting with `-` falls back to the default query instead of being parsed as a CLI flag.
- **Branch type keywords** with accents (`corrección`, `añadir`) now match (Unicode word boundaries).
- **Notion token**: saving an empty field no longer deletes the stored token; use the new **Clear Notion Token** button.
- **Smaller fixes**: the limit badge shows the synced count, `tasks.transition` rejects unknown status categories, Jira/Linear/Notion URLs with `&` query strings are accepted, `validateRelativeRepoPath` rejects nested `.git`, Windows trailing dots/spaces and `:` streams, and Linear OAuth tokens, JWTs and private keys are redacted.

### Developer
- **Type checking**: `tsc --noEmit` passes with zero errors (it reported 137). Fixed drifted types in `protocol.ts` (`RepoConfigFile`, `DiscoveredSkill.sourceDir`, `RepoWorkflowMapping.dispatch`, required request inputs) and test typings (a `mockHost({ workspaces })` option that was silently ignored). Added `package.json` dev tooling (`npm run typecheck` / `npm run verify`) and Node types in `tsconfig.json`.
- **`deriveUnassignedSprintJql` with `OR`**: Instead of removing the assignee term (which produced invalid JQL such as `(OR (...))` / `AND AND`, and broke `AND`/`OR` precedence), the term is substituted in place with `assignee is EMPTY` and the whole query is intersected with `AND assignee is EMPTY`.

## [0.3.2] - 2026-11-22

### Unassigned Sprint JQL Regex & Startup Hook Documentation
- **Fixed `deriveUnassignedSprintJql` matching for `assignee = currentUser()` and `assignee in (currentUser())`**: Replaced the trailing `\b` word-boundary assertion after `)` with `(?=\s|\)|$)` so `currentUser()` followed by whitespace, `)`, or end-of-string is properly replaced with `assignee is EMPTY` instead of appending a contradictory `AND assignee is EMPTY`.
- **Handled `OR` disjunctions in `deriveUnassignedSprintJql`**: When `sprintJql` contains `OR` alongside an `assignee` clause (e.g. `assignee = currentUser() OR reporter = currentUser()`), stripped the `assignee` term before intersecting with `(<remaining jql>) AND assignee is EMPTY` so tickets assigned to other users are never included.
- **Documented 400ms cold-startup hook trade-off**: Documented in `README.md` and `CHANGELOG.md` that bounding `initLookupPromise` at 400ms on worker activation prevents `agent.tool.before` 2000ms hook timeouts, with the trade-off that tool calls during the first 400ms fail open if cold storage/workspace hydration takes longer than 400ms.

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
