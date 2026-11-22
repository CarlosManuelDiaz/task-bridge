import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  Input,
  KeyValue,
  Link,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  Textarea,
  type PanelContext,
  type Tone
} from 'orca'
import {
  buildAgentPrompt,
  buildBranchName,
  type LiveAgentState,
  type TaskBridgeState,
  type TaskItem,
  type TaskKind,
  type TaskPriority,
  type TaskProvider,
  type TaskScopeFilter,
  type TaskStatusCategory
} from './protocol'

const INITIAL_STATE: TaskBridgeState = {
  tasks: [],
  fleet: [],
  scope: 'assigned',
  activeBranch: null,
  activeWorkspaceId: null,
  activeWorkspaceName: null,
  activeRepoId: null,
  activeRepoGuidelines: null,
  availableRepos: [],
  availableAgents: [
    { id: 'antigravity', label: 'Antigravity (agy)', cliFound: true },
    { id: 'claude', label: 'Claude Code', cliFound: true },
    { id: 'codex', label: 'Codex', cliFound: true },
    { id: 'gemini', label: 'Gemini CLI', cliFound: true },
    { id: 'cursor', label: 'Cursor CLI', cliFound: true }
  ],
  repoProfiles: {},
  activeTaskId: null,
  jiraSites: [],
  selectedJiraSiteId: null,
  linearConnected: false,
  notionConfigured: false,
  usingDemoData: true,
  defaultAgent: 'claude',
  branchPrefixMode: 'auto',
  branchTemplate: '{prefix}/{key}-{slug}',
  featurePrefix: 'feat',
  bugPrefix: 'fix',
  chorePrefix: 'chore',
  requirePlanApproval: false,
  enforcePlanLock: false,
  worktreeCopyFiles: [],
  autoSyncMinutes: 5,
  autoMoveInProgress: true,
  injectCompletionSkill: true,
  lastSyncedAt: null,
  diagnosticsReport: ''
}

const bridgeState = atom<TaskBridgeState>(INITIAL_STATE)
const loaded = atom<boolean>(false)
const activeTab = atom<string>('activeTab', 'queue', { persist: 'plugin' })
const providerFilter = atom<string>('providerFilter', 'all', { persist: 'plugin' })
const projectFilter = atom<string>('all')
const searchQuery = atom<string>('')
const selectedTaskId = atom<string | null>('selectedTaskId', null, { persist: 'plugin' })
const statusMessage = atom<{ text: string; tone: Tone } | null>(null)

// Child query controls (inspired by tienne/jira-tasks)
const childSearchQuery = atom<string>('')
const childStatusFilter = atom<string>('all')

// Workbench & Fleet controls
const selectedAgent = atom<string>('claude')
const selectedAcReviewerAgent = atom<string>('selectedAcReviewerAgent', '__auto__', {
  persist: 'plugin'
})
const branchOverride = atom<string>('')
const selectedBranchTypePrefix = atom<string>('__auto__')
const createWorktreeToggle = atom<boolean>(true)
const requirePlanApprovalToggle = atom<boolean>(false)
const enforcePlanLockToggle = atom<boolean>(false)
const profileBranchTemplateInput = atom<string>('{prefix}/{key}-{slug}')
const profileFeaturePrefixInput = atom<string>('feat')
const profileBugPrefixInput = atom<string>('fix')
const profileChorePrefixInput = atom<string>('chore')
const profileCopyFilesInput = atom<string>('')
const profileTicketPrefixesInput = atom<string>('')
const commentFeedbackInput = atom<string>('')
const hydratedRepoKey = atom<string | null>(null)
const prUrlInput = atom<string>('')
const completionCommentInput = atom<string>('')

// Manual ticket form & unlinked worktree registration controls
const newProvider = atom<TaskProvider>('linear')
const newKind = atom<TaskKind>('feature')
const newPriority = atom<TaskPriority>('medium')
const newKey = atom<string>('')
const newTitle = atom<string>('')
const newDescription = atom<string>('')
const newCriteria = atom<string>('')
const notionTokenInput = atom<string>('')
const createWsProjectInput = atom<string>('')
const createWsTypeInput = atom<string>('')
const createWsTitleInput = atom<string>('')

function getBranchNamingConfig(state: TaskBridgeState, repoId?: string) {
  const profile = repoId ? state.repoProfiles?.[repoId] : undefined
  const repoFile = repoId ? state.repoConfigsByRepoId?.[repoId] : undefined
  return {
    branchPrefixMode: state.branchPrefixMode,
    branchTemplate: profile?.branchTemplate ?? repoFile?.branchTemplate ?? state.branchTemplate,
    featurePrefix: profile?.featurePrefix ?? repoFile?.featurePrefix ?? state.featurePrefix,
    bugPrefix: profile?.bugPrefix ?? repoFile?.bugPrefix ?? state.bugPrefix,
    chorePrefix: profile?.chorePrefix ?? repoFile?.chorePrefix ?? state.chorePrefix,
    branchTypes: repoFile?.branchTypes ?? state.branchTypes
  }
}

function resolveTaskRepoInfo(
  state: TaskBridgeState,
  task: TaskItem
): { repoId: string | null; label: string; isAmbiguous: boolean } {
  const repos = state.availableRepos ?? []
  if (task.repoId) {
    const matched = repos.find((r) => r.repoId === task.repoId)
    return {
      repoId: task.repoId,
      label: matched ? matched.name : task.repoId,
      isAmbiguous: false
    }
  }
  const keyMatch = task.key.trim().toUpperCase().match(/^([A-Z0-9]+)-/)
  const keyPrefix = keyMatch ? keyMatch[1] : null
  if (keyPrefix) {
    for (const profile of Object.values(state.repoProfiles ?? {})) {
      const prefixes = (profile.ticketPrefixes ?? []).map((p) => p.toUpperCase())
      if (prefixes.includes(keyPrefix)) {
        const matched = repos.find((r) => r.repoId === profile.repoId)
        if (matched) {
          return { repoId: matched.repoId, label: `${matched.name} (prefix)`, isAmbiguous: false }
        }
      }
    }
  }
  const focused = repos.find((r) => r.isFocused)
  if (focused) {
    return { repoId: focused.repoId, label: `${focused.name} (focused)`, isAmbiguous: false }
  }
  if (repos.length === 1) {
    return { repoId: repos[0].repoId, label: repos[0].name, isAmbiguous: false }
  }
  if (repos.length > 1) {
    return { repoId: null, label: 'Pick repository', isAmbiguous: true }
  }
  return { repoId: state.activeRepoId ?? null, label: state.activeWorkspaceName ?? 'Auto', isAmbiguous: false }
}

function getWorkbenchTargetRepoContext(
  state: TaskBridgeState,
  task: TaskItem | null
): {
  repoId: string | null
  repoName: string
  guidelines: RepoGuidelines | null
} {
  const resolved = task ? resolveTaskRepoInfo(state, task) : null
  const repoId = resolved?.repoId ?? state.activeRepoId ?? null
  const repoEntry = repoId ? (state.availableRepos ?? []).find((r) => r.repoId === repoId) : undefined
  const guidelines =
    (repoId ? state.repoGuidelinesByRepoId?.[repoId] : undefined) ??
    (repoId && state.activeRepoId === repoId ? state.activeRepoGuidelines : null) ??
    (!resolved?.repoId ? state.activeRepoGuidelines : null)
  const repoName =
    repoEntry?.name ?? guidelines?.repoName ?? state.activeWorkspaceName ?? repoId ?? 'Default'
  return { repoId, repoName, guidelines }
}

function hydrateRepoControls(next: TaskBridgeState, targetRepoId: string | null): void {
  const repoKey = targetRepoId ?? '__global__'
  if (read(hydratedRepoKey) === repoKey) return
  set(hydratedRepoKey, repoKey)

  const profile = targetRepoId ? next.repoProfiles?.[targetRepoId] : undefined
  const repoFile = targetRepoId ? next.repoConfigsByRepoId?.[targetRepoId] : undefined
  const defaultAgent = profile?.defaultAgent ?? repoFile?.defaultAgent ?? next.defaultAgent
  if (defaultAgent) {
    set(selectedAgent, defaultAgent)
  }
  set(
    requirePlanApprovalToggle,
    profile?.requirePlanApproval ?? repoFile?.requirePlanApproval ?? next.requirePlanApproval
  )
  set(
    enforcePlanLockToggle,
    profile?.enforcePlanLock ?? repoFile?.enforcePlanLock ?? next.enforcePlanLock
  )
  set(
    profileBranchTemplateInput,
    profile?.branchTemplate ?? repoFile?.branchTemplate ?? (next.branchTemplate || '{prefix}/{key}-{slug}')
  )
  set(
    profileFeaturePrefixInput,
    profile?.featurePrefix ?? repoFile?.featurePrefix ?? (next.featurePrefix || 'feat')
  )
  set(
    profileBugPrefixInput,
    profile?.bugPrefix ?? repoFile?.bugPrefix ?? (next.bugPrefix || 'fix')
  )
  set(
    profileChorePrefixInput,
    profile?.chorePrefix ?? repoFile?.chorePrefix ?? (next.chorePrefix || 'chore')
  )
  set(
    profileCopyFilesInput,
    (profile?.worktreeCopyFiles ?? repoFile?.worktreeCopyFiles ?? next.worktreeCopyFiles ?? []).join(', ')
  )
  set(profileTicketPrefixesInput, (profile?.ticketPrefixes ?? []).join(', '))
}

function applyIncomingState(next: TaskBridgeState): void {
  set(bridgeState, next)
  set(loaded, true)
  const currentSelected = read(selectedTaskId)
  if (!currentSelected || !next.tasks.some((t) => t.id === currentSelected)) {
    const fallback = next.activeTaskId ?? next.tasks[0]?.id ?? null
    set(selectedTaskId, fallback)
  }
  const currentProj = read(projectFilter)
  if (currentProj !== 'all' && !next.tasks.some((t) => t.project === currentProj)) {
    set(projectFilter, 'all')
  }
  const selectedAfterFallback = read(selectedTaskId)
  const selectedTask = next.tasks.find((t) => t.id === selectedAfterFallback) ?? null
  const { repoId } = getWorkbenchTargetRepoContext(next, selectedTask)
  hydrateRepoControls(next, repoId)
}

function providerTone(provider: TaskProvider): Tone {
  if (provider === 'linear') return 'accent'
  if (provider === 'jira') return 'warning'
  return 'neutral'
}

function providerLabel(provider: TaskProvider): string {
  if (provider === 'linear') return 'Linear'
  if (provider === 'jira') return 'Jira'
  return 'Notion'
}

function statusTone(category: TaskStatusCategory): Tone {
  switch (category) {
    case 'in_progress':
      return 'accent'
    case 'in_review':
    case 'done':
      return 'success'
    case 'todo':
      return 'warning'
    default:
      return 'neutral'
  }
}

function agentStateTone(agentState: LiveAgentState): Tone {
  switch (agentState) {
    case 'working':
      return 'accent'
    case 'done':
      return 'success'
    case 'waiting':
      return 'warning'
    case 'blocked':
      return 'danger'
    default:
      return 'neutral'
  }
}

function priorityTone(priority: TaskPriority): Tone {
  if (priority === 'urgent') return 'danger'
  if (priority === 'high') return 'warning'
  if (priority === 'medium') return 'accent'
  return 'neutral'
}

async function handleSync(nextScope?: TaskScopeFilter): Promise<void> {
  const filter = read(providerFilter)
  const provider =
    filter === 'linear' || filter === 'jira' || filter === 'notion' ? filter : 'all'
  const scope = nextScope ?? read(bridgeState).scope
  const res = await plugin.request('tasks.sync', { provider, scope })
  applyIncomingState(res.state)
  set(statusMessage, { text: res.message, tone: 'accent' })
}

async function handleAssignTaskRepo(taskId: string, repoValue: string): Promise<void> {
  const res = await plugin.request('tasks.assignRepo', {
    taskId,
    repoId: repoValue === '__auto__' ? null : repoValue
  })
  set(hydratedRepoKey, null)
  applyIncomingState(res.state)
  set(statusMessage, { text: res.summary, tone: 'accent' })
}

function formatActionError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function handleQuickDispatch(task: TaskItem): Promise<void> {
  const state = read(bridgeState)
  const targetRepo = resolveTaskRepoInfo(state, task)
  try {
    const res = await plugin.request('tasks.dispatch', {
      taskId: task.id,
      agent: read(selectedAgent),
      ...(targetRepo.repoId ? { repoId: targetRepo.repoId } : {}),
      createWorktree: true
    })
    applyIncomingState(res.state)
    set(selectedTaskId, task.id)
    set(statusMessage, {
      text: res.summary,
      tone: res.launchWarning ? 'warning' : 'success'
    })
  } catch (err) {
    set(statusMessage, { text: formatActionError(err), tone: 'warning' })
  }
}

async function handleOpenWorkspace(taskId: string): Promise<void> {
  const res = await plugin.request('tasks.openWorkspace', { taskId })
  set(statusMessage, {
    text: res.summary,
    tone: res.opened ? 'accent' : 'warning'
  })
}

async function handleWorkbenchDispatch(): Promise<void> {
  const state = read(bridgeState)
  const currentId = read(selectedTaskId) ?? state.tasks[0]?.id
  if (!currentId) return

  const task = state.tasks.find((t) => t.id === currentId)
  const targetRepo = task ? resolveTaskRepoInfo(state, task) : null
  const customBranch = read(branchOverride).trim()
  const branchPrefixChoice = read(selectedBranchTypePrefix)
  try {
    const res = await plugin.request('tasks.dispatch', {
      taskId: currentId,
      agent: read(selectedAgent),
      ...(targetRepo?.repoId ? { repoId: targetRepo.repoId } : {}),
      ...(customBranch ? { customBranch } : {}),
      ...(branchPrefixChoice && branchPrefixChoice !== '__auto__'
        ? { branchPrefixOverride: branchPrefixChoice }
        : {}),
      createWorktree: read(createWorktreeToggle),
      requirePlanApproval: read(requirePlanApprovalToggle),
      enforcePlanLock: read(enforcePlanLockToggle)
    })
    applyIncomingState(res.state)
    set(statusMessage, {
      text: res.summary,
      tone: res.launchWarning ? 'warning' : 'success'
    })
  } catch (err) {
    set(statusMessage, { text: formatActionError(err), tone: 'warning' })
  }
}

async function handleApprovePlan(taskId: string): Promise<void> {
  const res = await plugin.request('tasks.approvePlan', { taskId })
  applyIncomingState(res.state)
  set(statusMessage, { text: res.summary, tone: 'success' })
}

async function handleSaveRepoProfile(): Promise<void> {
  const state = read(bridgeState)
  const currentTaskId = read(selectedTaskId) ?? state.activeTaskId ?? state.tasks[0]?.id ?? null
  const currentTask = state.tasks.find((t) => t.id === currentTaskId) ?? null
  const { repoId, repoName } = getWorkbenchTargetRepoContext(state, currentTask)
  if (!repoId) {
    set(statusMessage, {
      text: 'Select a Target Repository or focus a Git repository workspace in Orca to save a repo profile.',
      tone: 'warning'
    })
    return
  }

  const copyFiles = read(profileCopyFilesInput)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const ticketPrefixes = read(profileTicketPrefixesInput)
    .split(/[\n,]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)

  const res = await plugin.request('tasks.saveRepoProfile', {
    repoId,
    profile: {
      repoName,
      defaultAgent: read(selectedAgent),
      branchTemplate: read(profileBranchTemplateInput).trim(),
      featurePrefix: read(profileFeaturePrefixInput).trim(),
      bugPrefix: read(profileBugPrefixInput).trim(),
      chorePrefix: read(profileChorePrefixInput).trim(),
      requirePlanApproval: read(requirePlanApprovalToggle),
      enforcePlanLock: read(enforcePlanLockToggle),
      worktreeCopyFiles: copyFiles,
      ticketPrefixes
    }
  })
  set(hydratedRepoKey, null)
  applyIncomingState(res.state)
  set(statusMessage, { text: res.summary, tone: 'success' })
}

async function handleSendCommentFeedback(taskId: string): Promise<void> {
  const customInstruction = read(commentFeedbackInput).trim()
  const res = await plugin.request('tasks.sendCommentFeedback', {
    taskId,
    ...(customInstruction ? { customInstruction } : {})
  })
  set(commentFeedbackInput, '')
  applyIncomingState(res.state)
  set(statusMessage, { text: res.summary, tone: 'success' })
}

async function handleSendPrFeedback(taskId: string): Promise<void> {
  const res = await plugin.request('tasks.sendPrFeedback', { taskId })
  applyIncomingState(res.state)
  set(statusMessage, { text: res.summary, tone: 'success' })
}

async function handleApproveRepoSetup(repoId: string, configHash: string): Promise<void> {
  const res = await plugin.request('tasks.approveRepoSetup', { repoId, configHash })
  applyIncomingState(res.state)
  set(statusMessage, { text: res.summary, tone: 'success' })
}

async function handleApplyDetectedGuidelines(): Promise<void> {
  const state = read(bridgeState)
  const currentTaskId = read(selectedTaskId) ?? state.activeTaskId ?? state.tasks[0]?.id ?? null
  const currentTask = state.tasks.find((t) => t.id === currentTaskId) ?? null
  const { repoId, guidelines: g } = getWorkbenchTargetRepoContext(state, currentTask)
  if (!g) return

  if (g.detectedBranchHint) {
    const hint = g.detectedBranchHint
    if (hint.startsWith('feature/')) {
      set(profileFeaturePrefixInput, 'feature')
    } else if (hint.startsWith('feat/')) {
      set(profileFeaturePrefixInput, 'feat')
    }
    set(
      profileBranchTemplateInput,
      hint.replace(/^feature\//, '{prefix}/').replace(/^feat\//, '{prefix}/') ||
        '{prefix}/{key}-{slug}'
    )
  }
  if (g.detectedPlanRequired) {
    set(requirePlanApprovalToggle, true)
  }
  if (repoId) {
    await handleSaveRepoProfile()
  } else {
    set(statusMessage, {
      text: 'Applied detected repo guidelines to Workbench controls.',
      tone: 'accent'
    })
  }
}

async function handleCleanupWorktree(taskId: string, deleteBranch = false): Promise<void> {
  const res = await plugin.request('tasks.cleanupWorktree', { taskId, deleteBranch })
  applyIncomingState(res.state)
  set(statusMessage, {
    text: res.summary,
    tone: res.removed ? 'success' : 'warning'
  })
}

async function handleDismissFleet(taskId?: string, clearFinished = false): Promise<void> {
  const res = await plugin.request('tasks.dismissFleet', {
    ...(taskId ? { taskId } : {}),
    ...(clearFinished ? { clearFinished: true } : {})
  })
  applyIncomingState(res.state)
  set(statusMessage, {
    text: res.summary,
    tone: res.removedCount > 0 ? 'success' : 'accent'
  })
}

async function handleDispatchChildren(parentTaskId: string): Promise<void> {
  try {
    const state = read(bridgeState)
    const parentTask = state.tasks.find((t) => t.id === parentTaskId)
    const targetRepo = parentTask ? resolveTaskRepoInfo(state, parentTask) : null
    const res = await plugin.request('tasks.dispatchChildren', {
      parentTaskId,
      agent: read(selectedAgent),
      maxParallel: 3,
      ...(targetRepo?.repoId ? { repoId: targetRepo.repoId } : {})
    })
    applyIncomingState(res.state)
    set(statusMessage, {
      text: res.summary,
      tone: res.dispatchedKeys.length > 0 ? 'success' : 'warning'
    })
  } catch (err) {
    set(statusMessage, { text: formatActionError(err), tone: 'warning' })
  }
}

async function handleDetectPr(taskId: string): Promise<void> {
  const res = await plugin.request('tasks.detectPr', { taskId })
  applyIncomingState(res.state)
  if (res.prUrl) {
    set(prUrlInput, res.prUrl)
  }
  if (res.commitSummary) {
    set(completionCommentInput, res.commitSummary)
  }
  set(statusMessage, {
    text: res.summary,
    tone: res.prUrl ? 'success' : 'accent'
  })
}

async function handleVerifyAc(taskId: string): Promise<void> {
  const reviewerChoice = read(selectedAcReviewerAgent)
  const res = await plugin.request('tasks.verifyAcceptanceCriteria', {
    taskId,
    ...(reviewerChoice && reviewerChoice !== '__auto__' ? { reviewerAgent: reviewerChoice } : {})
  })
  applyIncomingState(res.state)
  set(statusMessage, { text: res.summary, tone: 'success' })
}

async function handleProposeAc(taskId: string): Promise<void> {
  try {
    const reviewerChoice = read(selectedAcReviewerAgent)
    const res = await plugin.request('tasks.proposeAcceptanceCriteria', {
      taskId,
      ...(reviewerChoice && reviewerChoice !== '__auto__' ? { reviewerAgent: reviewerChoice } : {})
    })
    applyIncomingState(res.state)
    set(statusMessage, { text: res.summary, tone: 'success' })
  } catch (err) {
    set(statusMessage, { text: formatActionError(err), tone: 'warning' })
  }
}

async function handleAssignToMe(taskId: string): Promise<void> {
  try {
    const res = await plugin.request('tasks.assignToMe', { taskId })
    applyIncomingState(res.state)
    set(statusMessage, {
      text: res.summary,
      tone: res.assigned ? 'success' : 'warning'
    })
  } catch (err) {
    set(statusMessage, { text: formatActionError(err), tone: 'warning' })
  }
}

async function handleDiscoverJiraMetadata(projectKey?: string): Promise<void> {
  try {
    const res = await plugin.request('tasks.discoverJiraMetadata', {
      ...(projectKey ? { projectKey } : {})
    })
    applyIncomingState(res.state)
    if (!read(createWsProjectInput) && res.projects[0]?.key) {
      set(createWsProjectInput, res.projects[0].key)
    }
    if (!read(createWsTypeInput) && res.issueTypes[0]?.id) {
      set(createWsTypeInput, res.issueTypes[0].id)
    }
    set(statusMessage, { text: res.summary, tone: 'accent' })
  } catch (err) {
    set(statusMessage, { text: formatActionError(err), tone: 'warning' })
  }
}

async function handleCreateFromWorkspace(): Promise<void> {
  const state = read(bridgeState)
  const projectKey = (read(createWsProjectInput).trim() || state.defaultJiraProject || '').toUpperCase()
  const issueTypeId = read(createWsTypeInput).trim() || state.defaultJiraIssueType || ''
  if (!projectKey || !issueTypeId) {
    set(statusMessage, {
      text: 'Provide a Jira Project Key and Issue Type ID (or click Load Jira Projects & Types) before creating a ticket.',
      tone: 'warning'
    })
    return
  }
  try {
    const title = read(createWsTitleInput).trim()
    const res = await plugin.request('tasks.createFromWorkspace', {
      projectKey,
      issueTypeId,
      ...(title ? { title } : {})
    })
    set(createWsTitleInput, '')
    applyIncomingState(res.state)
    set(selectedTaskId, res.created.id)
    set(statusMessage, { text: res.summary, tone: 'success' })
  } catch (err) {
    set(statusMessage, { text: formatActionError(err), tone: 'warning' })
  }
}

async function handleTransition(
  taskId: string,
  targetCategory: TaskStatusCategory
): Promise<void> {
  const res = await plugin.request('tasks.transition', {
    taskId,
    targetCategory,
    prUrl: read(prUrlInput),
    comment: read(completionCommentInput)
  })
  applyIncomingState(res.state)
  set(statusMessage, {
    text: res.summary,
    tone: res.providerSynced ? 'success' : 'warning'
  })
}

async function handleAddManual(): Promise<void> {
  const key = read(newKey).trim()
  const title = read(newTitle).trim()
  if (!key || !title) {
    set(statusMessage, {
      text: 'Please provide both a Ticket Key and a Ticket Title.',
      tone: 'warning'
    })
    return
  }

  const res = await plugin.request('tasks.addManual', {
    provider: read(newProvider),
    kind: read(newKind),
    priority: read(newPriority),
    key,
    title,
    description: read(newDescription),
    acceptanceCriteria: read(newCriteria)
  })
  applyIncomingState(res.state)
  set(selectedTaskId, res.created.id)
  set(newKey, '')
  set(newTitle, '')
  set(newDescription, '')
  set(newCriteria, '')
  set(activeTab, 'queue')
  set(statusMessage, {
    text: `Added [${res.created.key}] ${res.created.title} to queue.`,
    tone: 'success'
  })
}

async function handleSaveNotionToken(): Promise<void> {
  const res = await plugin.request('tasks.saveNotionToken', {
    token: read(notionTokenInput)
  })
  applyIncomingState(res.state)
  set(notionTokenInput, '')
  set(statusMessage, {
    text: res.configured
      ? 'Notion API token saved in encrypted storage.'
      : 'Notion API token cleared.',
    tone: res.configured ? 'success' : 'neutral'
  })
}

function selectTaskForWorkbench(taskId: string): void {
  const state = read(bridgeState)
  set(selectedTaskId, taskId)
  set(branchOverride, '')
  set(childSearchQuery, '')
  set(childStatusFilter, 'all')
  set(hydratedRepoKey, null)
  const task = state.tasks.find((t) => t.id === taskId) ?? null
  hydrateRepoControls(state, getWorkbenchTargetRepoContext(state, task).repoId)
  if (task?.detectedPrUrl) set(prUrlInput, task.detectedPrUrl)
  if (task?.detectedCommitSummary) set(completionCommentInput, task.detectedCommitSummary)
}

function openTaskInWorkbench(taskId: string): void {
  selectTaskForWorkbench(taskId)
  set(activeTab, 'workbench')
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('tasks.stateChanged', (next) => {
      applyIncomingState(next)
    })
  )
  void plugin.request('tasks.getState').then((initial) => {
    applyIncomingState(initial)
  })
}

export default function Panel() {
  const state = read(bridgeState)
  const isLoaded = read(loaded)
  const tab = read(activeTab)
  const filter = read(providerFilter)
  const projFilter = read(projectFilter)
  const query = read(searchQuery).trim().toLowerCase()
  const banner = read(statusMessage)

  const distinctProjects = Array.from(new Set(state.tasks.map((t) => t.project).filter(Boolean)))

  const filteredTasks = state.tasks.filter((task) => {
    if (filter !== 'all' && task.provider !== filter) return false
    if (projFilter !== 'all' && task.project !== projFilter) return false
    if (state.scope === 'done' && task.statusCategory !== 'done') return false
    if (!query) return true
    return (
      task.key.toLowerCase().includes(query) ||
      task.title.toLowerCase().includes(query) ||
      task.description.toLowerCase().includes(query) ||
      task.assignee.toLowerCase().includes(query)
    )
  })

  const currentTaskId = read(selectedTaskId) ?? state.activeTaskId ?? state.tasks[0]?.id ?? null
  const selectedTask = state.tasks.find((t) => t.id === currentTaskId) ?? null
  const activeTask = state.tasks.find((t) => t.id === state.activeTaskId) ?? null

  const selectedTaskRepo = selectedTask ? resolveTaskRepoInfo(state, selectedTask) : null
  const workbenchRepoCtx = getWorkbenchTargetRepoContext(state, selectedTask)
  const activeBranchConfig = getBranchNamingConfig(
    state,
    selectedTaskRepo?.repoId ?? state.activeRepoId ?? undefined
  )
  const branchPrefixChoice = read(selectedBranchTypePrefix)
  const effectiveBranch = selectedTask
    ? read(branchOverride).trim() ||
      buildBranchName(
        selectedTask,
        activeBranchConfig,
        branchPrefixChoice && branchPrefixChoice !== '__auto__' ? branchPrefixChoice : undefined
      )
    : ''
  const workbenchRepoConfig = workbenchRepoCtx.repoId
    ? state.repoConfigsByRepoId?.[workbenchRepoCtx.repoId]
    : undefined
  const workbenchRepoSources = workbenchRepoCtx.repoId
    ? state.repoConfigSourcesByRepoId?.[workbenchRepoCtx.repoId]
    : undefined
  const workbenchSetupApproval = workbenchRepoCtx.repoId
    ? state.repoSetupApprovals?.find((a) => a.repoId === workbenchRepoCtx.repoId)
    : undefined
  const workbenchSkills = workbenchRepoCtx.repoId
    ? (state.discoveredSkillsByRepoId?.[workbenchRepoCtx.repoId] ?? [])
    : []
  const agentOptions = state.availableAgents?.length
    ? state.availableAgents
    : INITIAL_STATE.availableAgents
  const selectedAgentEntry = agentOptions.find((a) => a.id === read(selectedAgent))

  const promptPreview = selectedTask
    ? buildAgentPrompt(selectedTask, {
        branch: effectiveBranch,
        includeCompletionSkill: state.injectCompletionSkill,
        requirePlanApproval: read(requirePlanApprovalToggle),
        enforcePlanLock: read(enforcePlanLockToggle),
        guidelines: workbenchRepoCtx.guidelines
      })
    : ''

  // Child issues filtering for the selected ticket (inspired by tienne/jira-tasks)
  const allChildren = selectedTask?.children ?? []
  const pendingChildrenCount = allChildren.filter(
    (c) => c.statusCategory === 'todo' || c.statusCategory === 'backlog'
  ).length
  const childStatuses = Array.from(new Set(allChildren.map((c) => c.status).filter(Boolean)))
  const childQuery = read(childSearchQuery).trim().toLowerCase()
  const childStatus = read(childStatusFilter)
  const filteredChildren = allChildren.filter((c) => {
    if (childStatus !== 'all' && c.status !== childStatus) return false
    if (!childQuery) return true
    return (
      c.key.toLowerCase().includes(childQuery) ||
      c.title.toLowerCase().includes(childQuery) ||
      c.assignee.toLowerCase().includes(childQuery)
    )
  })

  const fleetItems = state.fleet ?? []

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Stack gap="none">
          <Row gap="xs" align="center">
            <Heading level={2}>Task Bridge</Heading>
            {state.usingDemoData ? <Badge tone="neutral">DEMO</Badge> : null}
          </Row>
          <Text muted size="xs">
            Linear, Jira & Notion to Worktree
          </Text>
        </Stack>
        <Row gap="xs" align="center">
          <Badge tone="accent">{`${state.tasks.length} tickets`}</Badge>
          {fleetItems.length > 0 ? (
            <Badge tone="success">{`${fleetItems.length} in flight`}</Badge>
          ) : null}
          {state.autoSyncMinutes > 0 && !state.usingDemoData && fleetItems.length > 0 ? (
            <Badge tone="neutral">{`Auto ${state.autoSyncMinutes}m`}</Badge>
          ) : null}
          <Button size="xs" variant="outline" icon="refresh" onPress={() => handleSync()}>
            Sync
          </Button>
        </Row>
      </Row>

      {activeTask ? (
        <Box
          direction="row"
          justify="between"
          align="center"
          padding="xs"
          border="accent"
          radius="sm"
          background="card"
        >
          <Row gap="xs" align="center">
            <Badge tone="accent">{activeTask.key}</Badge>
            <Text size="xs" weight="medium" truncate>
              {activeTask.linkedBranch ??
                buildBranchName(
                  activeTask,
                  getBranchNamingConfig(state, activeTask.repoId ?? state.activeRepoId ?? undefined)
                )}
            </Text>
          </Row>
          <Badge tone={statusTone(activeTask.statusCategory)}>{activeTask.status}</Badge>
        </Box>
      ) : state.activeBranch ? (
        <Card
          title={`Unlinked Worktree (${state.activeBranch.replace(/^refs\/heads\//, '')})`}
          description="Register work in this active branch as a Jira ticket derived from the branch name and recent commits."
        >
          <Stack gap="xs">
            <Row gap="xs">
              <Input
                label="Jira Project Key"
                placeholder={state.defaultJiraProject || 'e.g. ENG'}
                value={read(createWsProjectInput)}
                onChange={(val) => set(createWsProjectInput, val)}
              />
              <Input
                label="Issue Type ID"
                placeholder={state.defaultJiraIssueType || 'e.g. 10001'}
                value={read(createWsTypeInput)}
                onChange={(val) => set(createWsTypeInput, val)}
              />
            </Row>
            <Input
              label="Optional Custom Ticket Title (leave blank to derive from branch & commits)"
              placeholder="Auto-derived from branch slug and git log"
              value={read(createWsTitleInput)}
              onChange={(val) => set(createWsTitleInput, val)}
            />
            <Row gap="xs" wrap>
              <Button
                size="xs"
                variant="solid"
                tone="accent"
                icon="add"
                onPress={handleCreateFromWorkspace}
              >
                Create Ticket
              </Button>
              <Button
                size="xs"
                variant="outline"
                icon="refresh"
                onPress={() => handleDiscoverJiraMetadata(read(createWsProjectInput).trim() || undefined)}
              >
                Load Jira Projects & Types
              </Button>
            </Row>
          </Stack>
        </Card>
      ) : null}

      {state.jiraAuthWarning ? (
        <Callout tone="warning" title="Jira Connection Warning">
          <Text size="xs">{state.jiraAuthWarning}</Text>
        </Callout>
      ) : null}

      {banner ? (
        <Callout tone={banner.tone} title="Task Bridge">
          <Text size="xs">{banner.text}</Text>
        </Callout>
      ) : null}

      <Tabs
        label="Task Bridge Sections"
        value={tab}
        onChange={(nextTab) => set(activeTab, nextTab)}
      >
        <Tab value="queue" label="Queue" icon="layers">
          <Stack gap="sm">
            <Row gap="xs" wrap>
              {(
                [
                  { id: 'assigned', label: 'Assigned' },
                  { id: 'sprint', label: 'Sprint' },
                  { id: 'reported', label: 'Reported' },
                  { id: 'all', label: 'All' },
                  { id: 'done', label: 'Done' }
                ] as const
              ).map((s) => (
                <Button
                  key={s.id}
                  size="xs"
                  variant={state.scope === s.id ? 'solid' : 'ghost'}
                  tone={state.scope === s.id ? 'accent' : 'neutral'}
                  onPress={() => handleSync(s.id)}
                >
                  {s.label}
                </Button>
              ))}
            </Row>

            {state.scope === 'sprint' && filter === 'notion' ? (
              <Callout tone="neutral" title="Sprint Scope Not Available for Notion">
                <Text size="xs">
                  Sprint / Cycle filtering applies to Jira Sprints and Linear Cycles. Switch Provider to All, Jira, or Linear.
                </Text>
              </Callout>
            ) : null}

            {state.scope === 'sprint' && state.activeSprint ? (
              <Card
                title={`Sprint: ${state.activeSprint.name}`}
                description={state.activeSprint.goal || 'Active sprint / cycle'}
              >
                <Stack gap="xs">
                  <Row gap="xs" wrap>
                    <Badge tone={state.activeSprint.isOverdue ? 'warning' : 'accent'}>
                      {state.activeSprint.isOverdue
                        ? `Ended ${state.activeSprint.overdueDays ?? 1}d ago (still open)`
                        : typeof state.activeSprint.daysRemaining === 'number'
                          ? `${state.activeSprint.daysRemaining}d remaining`
                          : state.activeSprint.state || 'Active'}
                    </Badge>
                    {state.activeSprint.startDate || state.activeSprint.endDate ? (
                      <Text muted size="xs">
                        {`${state.activeSprint.startDate?.slice(0, 10) ?? '—'} → ${state.activeSprint.endDate?.slice(0, 10) ?? '—'}`}
                      </Text>
                    ) : null}
                  </Row>
                </Stack>
              </Card>
            ) : null}

            <Row gap="xs">
              <Select
                label="Provider Filter"
                labelHidden
                value={filter}
                onChange={(val) => set(providerFilter, val)}
                options={[
                  { value: 'all', label: 'All Providers' },
                  { value: 'linear', label: 'Linear' },
                  { value: 'jira', label: 'Jira' },
                  { value: 'notion', label: 'Notion' }
                ]}
              />
              <Select
                label="Project Filter"
                labelHidden
                value={projFilter}
                onChange={(val) => set(projectFilter, val)}
                options={[
                  { value: 'all', label: 'All Projects' },
                  ...distinctProjects.map((p) => ({ value: p, label: p }))
                ]}
              />
            </Row>

            <Input
              label="Search tickets"
              labelHidden
              type="search"
              placeholder="Search by key, title, or assignee..."
              value={read(searchQuery)}
              onChange={(val) => set(searchQuery, val)}
            />

            {state.lastSyncedAt || state.lastSyncedWithDataAt || state.syncTruncated || state.cachedTasksMayBeStale ? (
              <Row gap="xs" wrap align="center">
                {state.lastSyncedWithDataAt ? (
                  <Text muted size="xs">
                    Last synced with data <RelativeTime at={state.lastSyncedWithDataAt} format="short" />
                  </Text>
                ) : state.lastSyncedAt ? (
                  <Text muted size="xs">
                    Last synced <RelativeTime at={state.lastSyncedAt} format="short" />
                  </Text>
                ) : null}
                {state.cachedTasksMayBeStale ? (
                  <Badge tone="warning">Cached (may be outdated)</Badge>
                ) : null}
                {state.syncTruncated ? (
                  <Badge tone="neutral">
                    {`Showing ${filteredTasks.length} of ${state.syncTotalCount ?? `${state.syncLimit ?? 100}+`}`}
                  </Badge>
                ) : null}
              </Row>
            ) : null}

            {state.scope === 'sprint' && (state.unassignedSprintTasks?.length ?? 0) > 0 ? (
              <Collapsible
                title={`Unassigned in Sprint (${state.unassignedSprintTasks?.length ?? 0})`}
                defaultOpen
              >
                <Stack gap="xs">
                  {(state.unassignedSprintTasks ?? []).map((uTask) => (
                    <Box
                      key={uTask.id}
                      direction="row"
                      justify="between"
                      align="center"
                      padding="xs"
                      border
                      radius="sm"
                    >
                      <Stack gap="none">
                        <Text size="xs" weight="medium">
                          <Code>{uTask.key}</Code> {uTask.title}
                        </Text>
                        <Text muted size="xs">
                          {`${uTask.status} · Unassigned`}
                        </Text>
                      </Stack>
                      <Button
                        size="xs"
                        variant="outline"
                        tone="accent"
                        icon="check"
                        onPress={() => handleAssignToMe(uTask.id)}
                      >
                        {`Assign to Me ${uTask.key}`}
                      </Button>
                    </Box>
                  ))}
                </Stack>
              </Collapsible>
            ) : null}

            {!isLoaded && filteredTasks.length === 0 ? (
              <EmptyState
                title="Loading ticket queue"
                description="Connecting to Task Bridge worker..."
                icon="refresh"
              />
            ) : filteredTasks.length === 0 ? (
              <EmptyState
                title="No matching tickets"
                description="Try clearing the filter or add a ticket in the Add & Connect tab."
                icon="search"
              />
            ) : (
              <Stack gap="sm">
                {filteredTasks.map((task) => {
                  const taskRepo = resolveTaskRepoInfo(state, task)
                  const autoBranch =
                    task.linkedBranch ??
                    buildBranchName(
                      task,
                      getBranchNamingConfig(state, taskRepo.repoId ?? state.activeRepoId ?? undefined)
                    )
                  return (
                    <Card
                      key={task.id}
                      title={`${task.key} · ${task.title}`}
                      description={task.description || 'No description provided.'}
                    >
                      <Stack gap="xs">
                        {task.parent ? (
                          <Text muted size="xs">
                            Parent: <Code>{task.parent.key}</Code> {task.parent.title}
                          </Text>
                        ) : null}

                        <Row gap="xs" wrap>
                          <Badge tone={providerTone(task.provider)}>
                            {providerLabel(task.provider)}
                          </Badge>
                          <Badge tone="neutral">{task.issueType || 'Task'}</Badge>
                          <Badge tone={statusTone(task.statusCategory)}>{task.status}</Badge>
                          <Badge tone={priorityTone(task.priority)}>{task.priority}</Badge>
                          {(state.availableRepos?.length ?? 0) > 0 ? (
                            <Badge tone={taskRepo.isAmbiguous ? 'warning' : 'neutral'}>
                              {`Repo: ${taskRepo.label}`}
                            </Badge>
                          ) : null}
                          {task.children && task.children.length > 0 ? (
                            <Badge tone="neutral">{`${task.children.length} subtasks`}</Badge>
                          ) : null}
                          {task.agentState && task.agentState !== 'idle' ? (
                            <Badge tone={agentStateTone(task.agentState)}>
                              {`${task.dispatchedAgent ?? state.defaultAgent}: ${task.agentState}`}
                            </Badge>
                          ) : null}
                          {task.planLockActive && !task.planApproved ? (
                            <Badge tone="warning">Plan Lock</Badge>
                          ) : task.planApproved ? (
                            <Badge tone="success">Plan Approved</Badge>
                          ) : null}
                          {(task.unreadCommentsCount ?? 0) > 0 ? (
                            <Badge tone="warning">{`${task.unreadCommentsCount} new comments`}</Badge>
                          ) : null}
                          {!task.description.trim() ? (
                            <Badge tone="warning">No Description</Badge>
                          ) : null}
                          {task.acceptanceCriteria.length === 0 ? (
                            <Badge tone="warning">Missing AC</Badge>
                          ) : null}
                          {task.staleFromFailedSync ? (
                            <Badge tone="warning">Outdated</Badge>
                          ) : null}
                        </Row>

                        <Text muted size="xs">
                          Assignee: {task.assignee || 'Unassigned'} · Branch:{' '}
                          <Code>{autoBranch}</Code>
                        </Text>

                        <Row gap="xs" wrap>
                          <Button
                            size="xs"
                            variant="solid"
                            tone="accent"
                            icon="play"
                            onPress={() => handleQuickDispatch(task)}
                          >
                            {`Start ${task.key}`}
                          </Button>
                          {task.planLockActive && !task.planApproved ? (
                            <Button
                              size="xs"
                              variant="solid"
                              tone="warning"
                              icon="check"
                              onPress={() => handleApprovePlan(task.id)}
                            >
                              {`Approve Plan ${task.key}`}
                            </Button>
                          ) : null}
                          {task.linkedOrcaWorkspaceId ? (
                            <Button
                              size="xs"
                              variant="outline"
                              icon="folder"
                              onPress={() => handleOpenWorkspace(task.id)}
                            >
                              {`Open ${task.key}`}
                            </Button>
                          ) : null}
                          <Button
                            size="xs"
                            variant="outline"
                            icon="code"
                            onPress={() => openTaskInWorkbench(task.id)}
                          >
                            {`Configure ${task.key}`}
                          </Button>
                          {task.statusCategory !== 'in_review' &&
                          task.statusCategory !== 'done' ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              icon="check"
                              onPress={() => handleTransition(task.id, 'in_review')}
                            >
                              {`Review ${task.key}`}
                            </Button>
                          ) : null}
                        </Row>
                      </Stack>
                    </Card>
                  )
                })}
              </Stack>
            )}
          </Stack>
        </Tab>

        <Tab value="fleet" label="Fleet" icon="activity">
          {fleetItems.length === 0 ? (
            <EmptyState
              title="No tickets in flight"
              description="Dispatch a ticket from the Queue or Workbench tab to monitor live coding agents alongside their issues."
              icon="bot"
            />
          ) : (
            <Stack gap="sm">
              <Row justify="between" align="center">
                <Text muted size="xs">
                  Live view crossing dispatched tickets with Orca worktrees and coding agents.
                </Text>
                {fleetItems.some(
                  (item) =>
                    item.statusCategory === 'done' ||
                    item.statusCategory === 'in_review' ||
                    !item.workspaceExists
                ) ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onPress={() => handleDismissFleet(undefined, true)}
                  >
                    Clear Finished
                  </Button>
                ) : null}
              </Row>
              <Select
                label="AC Reviewer Agent"
                value={read(selectedAcReviewerAgent)}
                onChange={(val) => set(selectedAcReviewerAgent, val)}
                options={[
                  { value: '__auto__', label: 'Auto (prefer other installed CLI)' },
                  ...agentOptions.map((a) => ({
                    value: a.id,
                    label: a.cliFound ? a.label : `${a.label} (CLI not in PATH)`
                  }))
                ]}
              />
              {fleetItems.map((item) => (
                <Card
                  key={item.taskId}
                  title={`${item.key} · ${item.title}`}
                  description={`Branch: ${item.branch}`}
                >
                  <Stack gap="xs">
                    <Row gap="xs" wrap>
                      <Badge tone={providerTone(item.provider)}>
                        {providerLabel(item.provider)}
                      </Badge>
                      <Badge tone={agentStateTone(item.agentState)}>
                        {`● ${item.agentState} · ${item.agent} · ${item.elapsedMinutes}m`}
                      </Badge>
                      <Badge tone={statusTone(item.statusCategory)}>{item.status}</Badge>
                      {!item.workspaceExists ? (
                        <Badge tone="neutral">No Worktree</Badge>
                      ) : null}
                      {item.acVerificationStatus === 'verified' ? (
                        <Badge tone="success">AC Verified</Badge>
                      ) : item.acVerificationStatus === 'failed' ? (
                        <Badge tone="danger">AC Failed</Badge>
                      ) : item.acVerificationStatus === 'unknown' ? (
                        <Badge tone="neutral">AC Unknown</Badge>
                      ) : item.acVerificationStatus === 'running' ? (
                        <Badge tone="warning">Verifying AC…</Badge>
                      ) : null}
                      {item.planStatus === 'awaiting_approval' ? (
                        <Badge tone="warning">Plan Pending</Badge>
                      ) : item.planStatus === 'approved' ? (
                        <Badge tone="success">Plan Approved</Badge>
                      ) : null}
                      {item.unreadCommentsCount > 0 ? (
                        <Badge tone="warning">{`${item.unreadCommentsCount} new comments`}</Badge>
                      ) : null}
                      {(item.unresolvedPrCommentsCount ?? 0) > 0 ? (
                        <Badge tone="warning">{`${item.unresolvedPrCommentsCount} PR comments`}</Badge>
                      ) : null}
                      {item.detectedPrUrl ? <Badge tone="accent">PR Ready</Badge> : null}
                    </Row>

                    <Row gap="xs" wrap>
                      {item.planStatus === 'awaiting_approval' ? (
                        <Button
                          size="xs"
                          variant="solid"
                          tone="warning"
                          icon="check"
                          onPress={() => handleApprovePlan(item.taskId)}
                        >
                          {`Approve Plan ${item.key}`}
                        </Button>
                      ) : null}
                      {item.unreadCommentsCount > 0 ? (
                        <Button
                          size="xs"
                          variant="outline"
                          tone="warning"
                          icon="zap"
                          onPress={() => handleSendCommentFeedback(item.taskId)}
                        >
                          {`Send Comments ${item.key}`}
                        </Button>
                      ) : null}
                      {(item.unresolvedPrCommentsCount ?? 0) > 0 ? (
                        <Button
                          size="xs"
                          variant="outline"
                          tone="warning"
                          icon="zap"
                          onPress={() => handleSendPrFeedback(item.taskId)}
                        >
                          {`Send PR Feedback ${item.key}`}
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="solid"
                        tone="accent"
                        icon="folder"
                        onPress={() => handleOpenWorkspace(item.taskId)}
                      >
                        {`Open ${item.key}`}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        icon="search"
                        onPress={() => handleDetectPr(item.taskId)}
                      >
                        {`Detect PR ${item.key}`}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        icon="bot"
                        onPress={() => handleVerifyAc(item.taskId)}
                      >
                        {`Verify AC ${item.key}`}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        icon="check"
                        onPress={() => handleTransition(item.taskId, 'in_review')}
                      >
                        {`In Review ${item.key}`}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        icon="check"
                        onPress={() => handleTransition(item.taskId, 'done')}
                      >
                        {`Done ${item.key}`}
                      </Button>
                      {item.workspaceExists &&
                      (item.statusCategory === 'done' || item.statusCategory === 'in_review') ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onPress={() => handleCleanupWorktree(item.taskId)}
                        >
                          {`Archive Worktree ${item.key}`}
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost"
                        onPress={() => handleDismissFleet(item.taskId)}
                      >
                        {`Remove ${item.key}`}
                      </Button>
                    </Row>
                  </Stack>
                </Card>
              ))}
            </Stack>
          )}
        </Tab>

        <Tab value="workbench" label="Workbench" icon="rocket">
          {!selectedTask ? (
            <EmptyState
              title="No ticket selected"
              description="Select a ticket from the Queue tab to configure its worktree and agent prompt."
              icon="layers"
            />
          ) : (
            <Stack gap="sm">
              <Select
                label="Selected Ticket"
                value={selectedTask.id}
                onChange={(val) => {
                  selectTaskForWorkbench(val)
                }}
                options={state.tasks.map((t) => ({
                  value: t.id,
                  label: `[${t.key}] ${t.title}`
                }))}
              />

              <Card title={`${selectedTask.key}: ${selectedTask.title}`}>
                <Stack gap="xs">
                  <KeyValue
                    items={[
                      {
                        label: 'Provider',
                        value: `${providerLabel(selectedTask.provider)} · ${selectedTask.issueType || 'Task'}`,
                        tone: providerTone(selectedTask.provider)
                      },
                      {
                        label: 'Status',
                        value: selectedTask.status,
                        tone: statusTone(selectedTask.statusCategory)
                      },
                      {
                        label: 'Assignee / Reporter',
                        value: `${selectedTask.assignee || 'Unassigned'} / ${selectedTask.reporter || 'Not available'}`
                      },
                      ...(selectedTask.parent
                        ? [
                            {
                              label: 'Parent Issue',
                              value: `[${selectedTask.parent.key}] ${selectedTask.parent.title}`
                            }
                          ]
                        : []),
                      {
                        label: 'Target Branch',
                        value: effectiveBranch,
                        code: true
                      }
                    ]}
                  />

                  <Separator />

                  <Select
                    label="Target Repository"
                    value={selectedTask.repoId ?? '__auto__'}
                    onChange={(val) => handleAssignTaskRepo(selectedTask.id, val)}
                    options={[
                      {
                        value: '__auto__',
                        label: selectedTaskRepo
                          ? `Auto (${selectedTaskRepo.label})`
                          : 'Auto (focused Git repo)'
                      },
                      ...(state.availableRepos ?? []).map((repo) => ({
                        value: repo.repoId,
                        label: `${repo.name} (${repo.branch.replace(/^refs\/heads\//, '')})`
                      }))
                    ]}
                  />
                  {selectedTaskRepo?.isAmbiguous ? (
                    <Text tone="warning" size="xs">
                      Multiple Git repositories are open in Orca. Pick which repository this ticket targets before launching.
                    </Text>
                  ) : null}

                  <Select
                    label="Coding Agent"
                    value={read(selectedAgent)}
                    onChange={(val) => set(selectedAgent, val)}
                    options={agentOptions.map((a) => ({
                      value: a.id,
                      label: a.cliFound ? a.label : `${a.label} (CLI not in PATH)`
                    }))}
                  />
                  {selectedAgentEntry && !selectedAgentEntry.cliFound ? (
                    <Text muted size="xs">
                      {`"${selectedAgentEntry.id}" was not detected on Windows PATH. Orca will only start it if configured as a Chat agent or installed on PATH.`}
                    </Text>
                  ) : null}

                  {activeBranchConfig.branchTypes && activeBranchConfig.branchTypes.length > 0 ? (
                    <Select
                      label="Branch Type"
                      value={read(selectedBranchTypePrefix)}
                      onChange={(val) => set(selectedBranchTypePrefix, val)}
                      options={[
                        { value: '__auto__', label: 'Auto (ticket type / keywords)' },
                        ...activeBranchConfig.branchTypes.map((bt) => ({
                          value: bt.prefix,
                          label: bt.prefix
                        }))
                      ]}
                    />
                  ) : null}

                  <Input
                    label="Custom Branch Override"
                    placeholder={buildBranchName(selectedTask, activeBranchConfig)}
                    value={read(branchOverride)}
                    onChange={(val) => set(branchOverride, val)}
                  />

                  <Switch
                    label="Create isolated Git worktree"
                    checked={read(createWorktreeToggle)}
                    onChange={(checked) => set(createWorktreeToggle, checked)}
                  />

                  <Switch
                    label="Require plan before coding"
                    checked={read(requirePlanApprovalToggle)}
                    onChange={(checked) => set(requirePlanApprovalToggle, checked)}
                  />

                  <Switch
                    label="Enforce Plan Lock (block file edits until approved)"
                    checked={read(enforcePlanLockToggle)}
                    onChange={(checked) => set(enforcePlanLockToggle, checked)}
                  />
                  <Text muted size="xs">
                    Blocks Edit/Write and mutating Bash commands via agent.tool.before (enforced in Claude Code; other agents follow prompt Plan-First rules).
                  </Text>

                  {!selectedTask.description.trim() || selectedTask.acceptanceCriteria.length === 0 ? (
                    <Callout tone="warning" title="Ticket Needs Definition Before Dispatch">
                      <Stack gap="xs">
                        <Text size="xs">
                          {!selectedTask.description.trim() && selectedTask.acceptanceCriteria.length === 0
                            ? 'This ticket is missing both a description and Acceptance Criteria.'
                            : !selectedTask.description.trim()
                              ? 'This ticket has no description.'
                              : 'This ticket has no Acceptance Criteria defined.'}
                        </Text>
                        <Button
                          size="xs"
                          variant="outline"
                          tone="warning"
                          icon="bot"
                          onPress={() => handleProposeAc(selectedTask.id)}
                        >
                          Propose AC
                        </Button>
                      </Stack>
                    </Callout>
                  ) : null}

                  <Row gap="xs" wrap>
                    <Button
                      variant="solid"
                      tone="accent"
                      icon="rocket"
                      onPress={handleWorkbenchDispatch}
                    >
                      Launch Worktree & Agent
                    </Button>
                    <Button
                      variant="outline"
                      icon="bot"
                      onPress={() => handleProposeAc(selectedTask.id)}
                    >
                      Propose AC
                    </Button>
                    {selectedTask.planLockActive && !selectedTask.planApproved ? (
                      <Button
                        variant="solid"
                        tone="warning"
                        icon="check"
                        onPress={() => handleApprovePlan(selectedTask.id)}
                      >
                        Approve Plan & Unlock Edits
                      </Button>
                    ) : null}
                    {selectedTask.linkedOrcaWorkspaceId ? (
                      <Button
                        variant="outline"
                        icon="folder"
                        onPress={() => handleOpenWorkspace(selectedTask.id)}
                      >
                        Open Existing Workspace
                      </Button>
                    ) : null}
                  </Row>
                </Stack>
              </Card>

              <Collapsible
                title={`Repo Guidelines & Branch Profile${workbenchRepoCtx.guidelines ? ` (${workbenchRepoCtx.guidelines.detectedFiles.length} file${workbenchRepoCtx.guidelines.detectedFiles.length === 1 ? '' : 's'} · ${workbenchRepoCtx.repoName})` : workbenchRepoCtx.repoId ? ` (${workbenchRepoCtx.repoName})` : ''}`}
                defaultOpen={Boolean(workbenchRepoCtx.guidelines)}
              >
                <Stack gap="xs">
                  {workbenchRepoCtx.guidelines ? (
                    <Stack gap="xs">
                      <Callout tone="accent" title={`Detected in ${workbenchRepoCtx.repoName}: ${workbenchRepoCtx.guidelines.detectedFiles.join(', ')}`}>
                        <Stack gap="none">
                          {workbenchRepoCtx.guidelines.detectedBranchHint ? (
                            <Text size="xs">
                              {`• Branch convention: ${workbenchRepoCtx.guidelines.detectedBranchHint}`}
                            </Text>
                          ) : null}
                          {workbenchRepoCtx.guidelines.summaryLines.map((line, idx) => (
                            <Text key={idx} size="xs">
                              {`• ${line}`}
                            </Text>
                          ))}
                        </Stack>
                      </Callout>
                      <Button
                        size="xs"
                        variant="outline"
                        icon="zap"
                        onPress={handleApplyDetectedGuidelines}
                      >
                        Apply Detected Guidelines
                      </Button>
                    </Stack>
                  ) : (
                    <Text muted size="xs">
                      No CLAUDE.md, AGENTS.md, or PR template detected in the selected repository yet.
                    </Text>
                  )}

                  {workbenchRepoConfig || workbenchRepoSources ? (
                    <Row gap="xs" wrap>
                      {workbenchRepoConfig ? (
                        <Badge tone="accent">.task-bridge.json loaded</Badge>
                      ) : null}
                      {workbenchRepoSources?.branchTemplate ? (
                        <Badge tone="neutral">{`Branch: ${workbenchRepoSources.branchTemplate}`}</Badge>
                      ) : null}
                      {workbenchRepoConfig?.planGate ? (
                        <Badge tone="neutral">{`Plan Gate: ${workbenchRepoConfig.planGate}`}</Badge>
                      ) : null}
                      {workbenchRepoConfig?.subtaskBase && workbenchRepoConfig.subtaskBase !== 'default' ? (
                        <Badge tone="neutral">{`Subtasks: ${workbenchRepoConfig.subtaskBase}`}</Badge>
                      ) : null}
                    </Row>
                  ) : null}

                  {workbenchSetupApproval ? (
                    <Callout
                      tone={workbenchSetupApproval.approved ? 'success' : 'warning'}
                      title={
                        workbenchSetupApproval.approved
                          ? 'Worktree Setup Commands Approved'
                          : 'Worktree Setup Commands Require Approval'
                      }
                    >
                      <Stack gap="xs">
                        <Text size="xs">
                          {`Commands: ${workbenchSetupApproval.commands.join(' · ')}`}
                        </Text>
                        {!workbenchSetupApproval.approved ? (
                          <Button
                            size="xs"
                            variant="solid"
                            tone="warning"
                            icon="check"
                            onPress={() =>
                              handleApproveRepoSetup(
                                workbenchSetupApproval.repoId,
                                workbenchSetupApproval.configHash
                              )
                            }
                          >
                            Approve Setup Commands
                          </Button>
                        ) : null}
                      </Stack>
                    </Callout>
                  ) : null}

                  {workbenchSkills.length > 0 ? (
                    <Stack gap="none">
                      <Text size="xs" weight="medium">
                        {`Discovered Repo Skills (${workbenchSkills.length})`}
                      </Text>
                      <Row gap="xs" wrap>
                        {workbenchSkills.slice(0, 8).map((s) => (
                          <Badge key={s.relativePath} tone="neutral">
                            {`${s.name} (${s.sourceDir})`}
                          </Badge>
                        ))}
                      </Row>
                    </Stack>
                  ) : null}

                  <Input
                    label="Branch Template ({prefix}, {key}, {KEY}, {slug}, {project})"
                    placeholder="{prefix}/{key}-{slug}"
                    value={read(profileBranchTemplateInput)}
                    onChange={(val) => set(profileBranchTemplateInput, val)}
                  />
                  <Row gap="xs">
                    <Input
                      label="Feature Prefix"
                      placeholder="feature"
                      value={read(profileFeaturePrefixInput)}
                      onChange={(val) => set(profileFeaturePrefixInput, val)}
                    />
                    <Input
                      label="Bug Prefix"
                      placeholder="bugfix"
                      value={read(profileBugPrefixInput)}
                      onChange={(val) => set(profileBugPrefixInput, val)}
                    />
                    <Input
                      label="Chore Prefix"
                      placeholder="chore"
                      value={read(profileChorePrefixInput)}
                      onChange={(val) => set(profileChorePrefixInput, val)}
                    />
                  </Row>
                  <Input
                    label="Local Setup Files to Copy to New Worktrees (comma-separated)"
                    placeholder=".env.local, .claude/settings.local.json"
                    value={read(profileCopyFilesInput)}
                    onChange={(val) => set(profileCopyFilesInput, val)}
                  />
                  <Input
                    label="Auto-match Ticket Prefixes (comma-separated, e.g. LIN, ENG)"
                    placeholder="LIN, ENG"
                    value={read(profileTicketPrefixesInput)}
                    onChange={(val) => set(profileTicketPrefixesInput, val)}
                  />
                  {workbenchRepoCtx.repoId ? (
                    <Button
                      size="xs"
                      variant="outline"
                      icon="check"
                      onPress={handleSaveRepoProfile}
                    >
                      {`Save Profile for ${workbenchRepoCtx.repoName}`}
                    </Button>
                  ) : null}
                </Stack>
              </Collapsible>

              {selectedTask.linkedOrcaWorkspaceId || (selectedTask.comments?.length ?? 0) > 0 ? (
                <Collapsible
                  title={`Ticket Comments & Feedback Loop (${selectedTask.comments?.length ?? 0})`}
                  defaultOpen={(selectedTask.unreadCommentsCount ?? 0) > 0}
                >
                  <Stack gap="xs">
                    {(selectedTask.comments ?? []).length === 0 ? (
                      <Text muted size="xs">
                        No ticket comments synced yet. Press Sync or enter custom feedback below to forward to the agent.
                      </Text>
                    ) : (
                      (selectedTask.comments ?? []).slice(-5).map((c) => (
                        <Box key={c.id} padding="xs" border radius="sm">
                          <Stack gap="none">
                            <Text size="xs" weight="medium">
                              {c.author}
                            </Text>
                            <Text size="xs">{c.body}</Text>
                          </Stack>
                        </Box>
                      ))
                    )}
                    <Textarea
                      label="Feedback / Follow-up Instruction for Agent"
                      placeholder="Optional note or clarification to include alongside ticket comments..."
                      rows={2}
                      value={read(commentFeedbackInput)}
                      onChange={(val) => set(commentFeedbackInput, val)}
                    />
                    {selectedTask.linkedOrcaWorkspaceId ? (
                      <Button
                        size="xs"
                        variant="outline"
                        tone="accent"
                        icon="zap"
                        onPress={() => handleSendCommentFeedback(selectedTask.id)}
                      >
                        Send Comments & Feedback to Agent
                      </Button>
                    ) : null}
                  </Stack>
                </Collapsible>
              ) : null}

              {allChildren.length > 0 ? (
                <Collapsible
                  title={`Child Issues (${filteredChildren.length} of ${allChildren.length})`}
                  defaultOpen
                >
                  <Stack gap="xs">
                    <Row gap="xs">
                      <Input
                        label="Search child issues"
                        labelHidden
                        type="search"
                        placeholder="Filter children by key or title..."
                        value={read(childSearchQuery)}
                        onChange={(val) => set(childSearchQuery, val)}
                      />
                      <Select
                        label="Child Status Filter"
                        labelHidden
                        value={childStatus}
                        onChange={(val) => set(childStatusFilter, val)}
                        options={[
                          { value: 'all', label: 'All Statuses' },
                          ...childStatuses.map((s) => ({ value: s, label: s }))
                        ]}
                      />
                    </Row>
                    {pendingChildrenCount > 0 ? (
                      <Button
                        size="xs"
                        variant="outline"
                        tone="accent"
                        icon="zap"
                        onPress={() => handleDispatchChildren(selectedTask.id)}
                      >
                        {`Dispatch ${pendingChildrenCount} Pending Subtask(s) in Parallel`}
                      </Button>
                    ) : null}
                    {filteredChildren.map((child) => (
                      <Box
                        key={child.key}
                        direction="row"
                        justify="between"
                        align="center"
                        padding="xs"
                        border
                        radius="sm"
                      >
                        <Stack gap="none">
                          <Text size="xs" weight="medium">
                            <Code>{child.key}</Code> {child.title}
                          </Text>
                          <Text muted size="xs">
                            {child.assignee || 'Unassigned'}
                          </Text>
                        </Stack>
                        <Badge tone={statusTone(child.statusCategory)}>{child.status}</Badge>
                      </Box>
                    ))}
                  </Stack>
                </Collapsible>
              ) : null}

              <Collapsible title="Agent Prompt & Skill Preview" defaultOpen>
                <CodeView
                  label="Generated Agent Prompt"
                  language="markdown"
                  wrap
                  maxHeight="sm"
                  code={promptPreview}
                />
              </Collapsible>

              <Card
                title="Complete & Sync Status"
                description="Auto-detect PR, run Acceptance Criteria verification gate, and transition ticket."
              >
                <Stack gap="xs">
                  <Row gap="xs" wrap>
                    <Button
                      size="xs"
                      variant="outline"
                      icon="search"
                      onPress={() => handleDetectPr(selectedTask.id)}
                    >
                      Auto-Detect PR & Commits
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      icon="bot"
                      onPress={() => handleVerifyAc(selectedTask.id)}
                    >
                      Verify Acceptance Criteria
                    </Button>
                  </Row>

                  <Input
                    label="Pull Request URL"
                    placeholder="https://github.com/org/repo/pull/123"
                    value={read(prUrlInput)}
                    onChange={(val) => set(prUrlInput, val)}
                  />
                  <Textarea
                    label="Completion Summary Comment"
                    placeholder="Root cause and verification summary..."
                    rows={2}
                    value={read(completionCommentInput)}
                    onChange={(val) => set(completionCommentInput, val)}
                  />
                  <Row gap="xs" wrap>
                    <Button
                      size="xs"
                      variant="solid"
                      tone="success"
                      icon="check"
                      onPress={() => handleTransition(selectedTask.id, 'in_review')}
                    >
                      Move to In Review
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      icon="play"
                      onPress={() => handleTransition(selectedTask.id, 'in_progress')}
                    >
                      Move to In Progress
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onPress={() => handleTransition(selectedTask.id, 'done')}
                    >
                      Mark Done
                    </Button>
                    {selectedTask.linkedOrcaWorkspaceId ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onPress={() => handleCleanupWorktree(selectedTask.id)}
                      >
                        Archive Worktree
                      </Button>
                    ) : null}
                  </Row>
                </Stack>
              </Card>
            </Stack>
          )}
        </Tab>

        <Tab value="create" label="Add & Connect" icon="add">
          <Stack gap="sm">
            <Card
              title="Add Ticket to Queue"
              description="Import or create a Linear, Jira, or Notion task with acceptance criteria."
            >
              <Stack gap="xs">
                <Row gap="xs">
                  <Select
                    label="Provider"
                    value={read(newProvider)}
                    onChange={(val) => set(newProvider, val as TaskProvider)}
                    options={[
                      { value: 'linear', label: 'Linear' },
                      { value: 'jira', label: 'Jira' },
                      { value: 'notion', label: 'Notion' }
                    ]}
                  />
                  <Select
                    label="Task Type"
                    value={read(newKind)}
                    onChange={(val) => set(newKind, val as TaskKind)}
                    options={[
                      { value: 'feature', label: 'Feature (feat/)' },
                      { value: 'bug', label: 'Bug Fix (fix/)' },
                      { value: 'chore', label: 'Chore (chore/)' }
                    ]}
                  />
                </Row>

                <Select
                  label="Priority"
                  value={read(newPriority)}
                  onChange={(val) => set(newPriority, val as TaskPriority)}
                  options={[
                    { value: 'urgent', label: 'Urgent' },
                    { value: 'high', label: 'High' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'low', label: 'Low' }
                  ]}
                />

                <Input
                  label="Ticket Key"
                  placeholder="e.g. LIN-205, ENG-99, NOT-42"
                  value={read(newKey)}
                  onChange={(val) => set(newKey, val)}
                />

                <Input
                  label="Ticket Title"
                  placeholder="Short summary of the feature or bug"
                  value={read(newTitle)}
                  onChange={(val) => set(newTitle, val)}
                />

                <Textarea
                  label="Description"
                  placeholder="Context, problem statement, or technical notes..."
                  rows={3}
                  value={read(newDescription)}
                  onChange={(val) => set(newDescription, val)}
                />

                <Textarea
                  label="Acceptance Criteria (one per line)"
                  placeholder="Unit tests pass&#10;No regressions in auth flow"
                  rows={3}
                  value={read(newCriteria)}
                  onChange={(val) => set(newCriteria, val)}
                />

                <Button variant="solid" tone="accent" icon="add" onPress={handleAddManual}>
                  Add Ticket
                </Button>
              </Stack>
            </Card>

            <Card
              title="Provider Connections"
              description="Linear and Jira use Orca's native CLI connections. Store your Notion API token below."
            >
              <Stack gap="xs">
                <Row justify="between" align="center">
                  <Text size="xs">Linear CLI Connection</Text>
                  <Badge tone={state.linearConnected ? 'success' : 'neutral'}>
                    {state.linearConnected ? 'Connected' : 'Uses Orca Tasks'}
                  </Badge>
                </Row>

                <Row justify="between" align="center">
                  <Text size="xs">Jira CLI Connection</Text>
                  <Badge tone={state.jiraSites.length > 0 ? 'success' : 'neutral'}>
                    {state.jiraSites.length > 0
                      ? `${state.jiraSites.length} site(s)`
                      : 'Uses Orca Tasks'}
                  </Badge>
                </Row>

                <Row justify="between" align="center">
                  <Text size="xs">Notion Integration Status</Text>
                  <Badge tone={state.notionConfigured ? 'success' : 'neutral'}>
                    {state.notionConfigured ? 'Configured' : 'Not set'}
                  </Badge>
                </Row>

                <Input
                  label="Notion Integration Token"
                  type="password"
                  placeholder="ntn_..."
                  value={read(notionTokenInput)}
                  onChange={(val) => set(notionTokenInput, val)}
                />

                <Button
                  size="xs"
                  variant="outline"
                  icon="check"
                  onPress={handleSaveNotionToken}
                >
                  Save Notion Token
                </Button>
              </Stack>
            </Card>

            <Card
              title="Support & Diagnostics"
              description="Copy the sanitized summary below (no tokens, emails, URLs, or ticket content) when opening a GitHub issue."
            >
              <Stack gap="xs">
                <CodeView
                  label="Sanitized Diagnostics"
                  language="text"
                  wrap
                  maxHeight="sm"
                  code={state.diagnosticsReport || 'Sync or reload panel to generate diagnostics.'}
                />
                <Row justify="between" align="center" wrap>
                  <Link href="https://github.com/CarlosManuelDiaz/task-bridge/issues/new/choose">
                    Report Bug or Request Feature
                  </Link>
                  <Text muted size="xs">
                    Logs: <Code>orca plugin logs carlosmanueldiaz.task-bridge</Code>
                  </Text>
                </Row>
              </Stack>
            </Card>
          </Stack>
        </Tab>
      </Tabs>
    </Stack>
  )
}
