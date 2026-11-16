// Security boundary helpers for Task Bridge:
// - Strict allowlist validation for CLI parameters (keys, branches, agents, statuses, URLs, Notion IDs)
// - ANSI/OSC terminal escape sequence stripping
// - Automatic credential/token redaction to prevent accidental secret leakage

const ANSI_ESCAPE_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const INVISIBLE_CHARS_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g
const BOUNDARY_TAG_REGEX =
  /(?:<|&lt;|\uFF1C)\s*\/?\s*untrusted[\s_-]*ticket[\s_-]*data(?:[^<>\n\uFF1C\uFF1E]{0,80}?(?:>|&gt;|\uFF1E))?/gi

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bntn_[A-Za-z0-9]{12,}\b/g,
  /\bsecret_[A-Za-z0-9]{16,}\b/g,
  /\blin_api_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bATATT3x[A-Za-z0-9_\-=]{16,}/g,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/gi,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi
]

const ALLOWED_AGENTS = new Set(['antigravity', 'claude', 'codex', 'gemini', 'cursor'])
const TICKET_KEY_REGEX = /^[A-Z][A-Z0-9_]{0,11}-[A-Z0-9]{1,12}$/
const SAFE_BRANCH_REGEX = /^[A-Za-z0-9]+(?:[._/-][A-Za-z0-9]+)*$/
const SAFE_PREFIX_REGEX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,23}$/
const NOTION_ID_REGEX =
  /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/
const UNSAFE_URL_CHARS = /['"`$;&|<>\\\s\u0000-\u001F\u007F]/

/**
 * Strips ANSI/OSC terminal escape codes, control and zero-width/bidi invisible characters,
 * neutralizes fake boundary tags, and redacts any embedded API tokens.
 */
export function sanitizeUntrustedText(input: string, maxLength = 4000): string {
  if (!input) return ''
  const withoutAnsi = input.replace(ANSI_ESCAPE_REGEX, '')
  const withoutCtrl = withoutAnsi.replace(CONTROL_CHARS_REGEX, '')
  const withoutInvisible = withoutCtrl.replace(INVISIBLE_CHARS_REGEX, '')
  const neutralizedBoundary = withoutInvisible.replace(BOUNDARY_TAG_REGEX, '[removed boundary tag]')
  const redacted = redactSecrets(neutralizedBoundary)
  return redacted.trim().slice(0, maxLength)
}

/**
 * Redacts known API token and credential patterns from a string.
 */
export function redactSecrets(input: string): string {
  let result = input
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_SECRET]')
  }
  return result
}

/**
 * Validates and normalizes a ticket key (e.g. `LIN-142`, `ENG-408`).
 * Returns null if the key does not match the strict alphanumeric identifier format.
 */
export function validateTicketKey(rawKey: string): string | null {
  const normalized = rawKey.trim().toUpperCase()
  if (!TICKET_KEY_REGEX.test(normalized)) {
    return null
  }
  return normalized
}

/**
 * Validates that an agent CLI name is in the strict allowlist.
 */
export function validateAgentName(rawAgent: string | undefined, fallback = 'claude'): string {
  const candidate = (rawAgent ?? '').trim().toLowerCase()
  if (ALLOWED_AGENTS.has(candidate)) {
    return candidate
  }
  return ALLOWED_AGENTS.has(fallback) ? fallback : 'claude'
}

/**
 * Validates a Git branch name against strict ref safety rules (no `..`, flags, spaces, or shell metacharacters).
 * Preserves case so conventions like `feature/LIN-142-oauth-pkce` and `feat/lin-142-oauth` both work safely.
 */
export function validateBranchName(rawBranch: string): string | null {
  const trimmed = rawBranch.trim()
  if (
    !trimmed ||
    trimmed.length > 80 ||
    trimmed.includes('..') ||
    trimmed.includes('//') ||
    trimmed.includes('@{') ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.lock') ||
    !SAFE_BRANCH_REGEX.test(trimmed)
  ) {
    return null
  }
  return trimmed
}

/**
 * Validates a configurable branch prefix (e.g. `feature`, `bugfix`, `feat`, `hotfix`).
 */
export function sanitizeBranchPrefix(rawPrefix: string | undefined, fallback: string): string {
  const cleaned = (rawPrefix ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (
    !cleaned ||
    cleaned.includes('..') ||
    cleaned.includes('//') ||
    !SAFE_PREFIX_REGEX.test(cleaned)
  ) {
    return fallback
  }
  return cleaned
}

/**
 * Validates a relative file/directory path inside a repository (for copying local setup files
 * like `.env.local` or `.claude/settings.local.json` into new worktrees). Rejects absolute paths,
 * Windows drive letters, null bytes, and `..` traversal segments.
 */
export function validateRelativeRepoPath(rawPath: string | undefined): string | null {
  if (!rawPath) return null
  const normalized = rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (
    !normalized ||
    normalized.length > 160 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    /[\u0000-\u001F\u007F]/.test(normalized)
  ) {
    return null
  }
  const segments = normalized.split('/').filter(Boolean)
  if (
    segments.length === 0 ||
    segments.some((seg) => seg === '.' || seg === '..') ||
    segments[0].toLowerCase() === '.git'
  ) {
    return null
  }
  return segments.join('/')
}

/**
 * Validates an HTTPS URL and ensures it contains no shell metacharacters or control bytes.
 */
export function validateHttpsUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null
  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.length > 512 || UNSAFE_URL_CHARS.test(trimmed)) {
    return null
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:') {
      return null
    }
    if (parsed.username || parsed.password) {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * Validates a Notion Database ID or Page ID (32 hex chars / UUID) to prevent path traversal or SSRF.
 */
export function validateNotionId(rawId: string | undefined): string | null {
  if (!rawId) return null
  const trimmed = rawId.trim()
  if (!NOTION_ID_REGEX.test(trimmed)) {
    return null
  }
  return trimmed
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Matches a ticket key inside a Git branch name using non-alphanumeric left boundaries and
 * non-digit right boundaries so `ENG-6` never links to `feature/ENG-674_x` or `UI-1` to `feat/gui-12`.
 */
export function doesBranchMatchTicketKey(branch: string, key: string): boolean {
  const safeKey = validateTicketKey(key)
  if (!safeKey || !branch) return false
  const regex = new RegExp(`(?:^|[^a-z0-9])${escapeRegexLiteral(safeKey)}(?![0-9])`, 'i')
  return regex.test(branch)
}

const SHARED_READ_ONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'ls',
  'read_file',
  'list_dir',
  'list_directory',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'find_by_name',
  'grep_search',
  'search_file_content',
  'file_search',
  'codebase_search',
  'grep_files',
  'webfetch',
  'web_fetch',
  'websearch',
  'google_web_search',
  'todoread',
  'todowrite',
  'taskoutput',
  'tasklist',
  'taskget',
  'askuserquestion',
  'exitplanmode'
])

const READ_ONLY_TOOLS_BY_AGENT: Record<string, ReadonlySet<string>> = {
  claude: SHARED_READ_ONLY_TOOLS,
  gemini: SHARED_READ_ONLY_TOOLS,
  codex: SHARED_READ_ONLY_TOOLS,
  cursor: SHARED_READ_ONLY_TOOLS,
  antigravity: SHARED_READ_ONLY_TOOLS
}

const PLAN_LOCK_SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'execute_command',
  'run_command',
  'powershell',
  'run_shell_command',
  'run_terminal_cmd'
])

const ALLOWED_READ_ONLY_COMMANDS = new Set([
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'wc',
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ag',
  'fd',
  'pwd',
  'tree',
  'stat',
  'file',
  'which',
  'where',
  'where.exe',
  'type',
  'echo',
  'true',
  'false',
  'get-childitem',
  'gci',
  'get-content',
  'gc',
  'select-string',
  'sls',
  'get-location',
  'test-path',
  'resolve-path'
])

const ALLOWED_GIT_READ_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'grep',
  'describe',
  'shortlog',
  'branch'
])

const FIND_MUTATING_FLAGS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls'
])

const GIT_BRANCH_MUTATING_FLAGS = new Set([
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '--delete',
  '--move',
  '--copy',
  '--edit-description',
  '--set-upstream-to',
  '--unset-upstream'
])

function extractCommandTextForPlanLock(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const field of ['command', 'CommandLine', 'cmd', 'script', 'argv']) {
    const val = obj[field]
    if (typeof val === 'string') return val
    if (Array.isArray(val) && val.every((item) => typeof item === 'string')) {
      return val.join(' ')
    }
  }
  return ''
}

function splitShellSegmentsAndCheckUnquotedMeta(cmd: string): string[] | null {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]
    const nextCh = cmd[i + 1] ?? ''

    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) {
        current += ch + nextCh
        i += 1
        continue
      }
      if (ch === quote) {
        quote = null
      }
      current += ch
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }

    // Reject unquoted redirections, command substitutions, backticks, and process substitutions
    if (
      ch === '>' ||
      ch === '`' ||
      (ch === '$' && nextCh === '(') ||
      (ch === '<' && nextCh === '(')
    ) {
      return null
    }

    if (ch === ';' || ch === '\n' || ch === '\r') {
      if (current.trim()) segments.push(current.trim())
      current = ''
      continue
    }
    if ((ch === '&' && nextCh === '&') || (ch === '|' && nextCh === '|')) {
      if (current.trim()) segments.push(current.trim())
      current = ''
      i += 1
      continue
    }
    if (ch === '|') {
      if (nextCh === '&') return null
      if (current.trim()) segments.push(current.trim())
      current = ''
      continue
    }
    if (ch === '&') {
      return null
    }

    current += ch
  }

  if (quote) return null
  if (current.trim()) segments.push(current.trim())
  return segments
}

function tokenizeSimpleShellSegment(segment: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1]
        i += 1
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (quote) return null
  if (current) tokens.push(current)
  return tokens
}

function isAllowedGitReadSegment(tokens: string[]): boolean {
  let idx = 1
  while (idx < tokens.length) {
    const tok = tokens[idx]
    if (!tok.startsWith('-')) break
    if (tok === '-C' || tok === '--git-dir' || tok === '--work-tree' || tok === '-c') {
      idx += 2
      continue
    }
    idx += 1
  }
  const subcommand = tokens[idx]?.toLowerCase() ?? ''
  if (!ALLOWED_GIT_READ_SUBCOMMANDS.has(subcommand)) return false
  if (subcommand === 'branch') {
    for (let i = idx + 1; i < tokens.length; i += 1) {
      const arg = tokens[i]
      if (GIT_BRANCH_MUTATING_FLAGS.has(arg)) return false
      if (!arg.startsWith('-')) return false
    }
  }
  return true
}

function isAllowedFindReadSegment(tokens: string[]): boolean {
  for (let i = 1; i < tokens.length; i += 1) {
    const lower = tokens[i].toLowerCase()
    if (FIND_MUTATING_FLAGS.has(lower)) return false
  }
  return true
}

/**
 * Strictly allows only read-only inspection shell commands while Plan Lock is active.
 */
export function isReadOnlyShellCommand(cmd: string): boolean {
  if (!cmd.trim()) return false
  const segments = splitShellSegmentsAndCheckUnquotedMeta(cmd)
  if (!segments || segments.length === 0) return false

  for (const segment of segments) {
    const tokens = tokenizeSimpleShellSegment(segment)
    if (!tokens || tokens.length === 0) return false
    const bin = tokens[0].toLowerCase()
    if (bin === 'git') {
      if (!isAllowedGitReadSegment(tokens)) return false
      continue
    }
    if (bin === 'find') {
      if (!isAllowedFindReadSegment(tokens)) return false
      continue
    }
    if (!ALLOWED_READ_ONLY_COMMANDS.has(bin)) {
      return false
    }
  }

  return true
}

/**
 * Evaluates whether a tool call is permitted while Plan Lock is active (fail-closed for unknown tools).
 */
export function isPlanLockToolAllowed(agentName: string, toolName: string, input: unknown): boolean {
  const toolLower = toolName.trim().toLowerCase()
  const agentLower = (agentName || 'claude').trim().toLowerCase()
  const agentReadOnlySet = READ_ONLY_TOOLS_BY_AGENT[agentLower] ?? SHARED_READ_ONLY_TOOLS
  if (agentReadOnlySet.has(toolLower)) {
    return true
  }
  if (PLAN_LOCK_SHELL_TOOLS.has(toolLower)) {
    return isReadOnlyShellCommand(extractCommandTextForPlanLock(input))
  }
  return false
}

const AC_VERDICT_WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'write_to_file',
  'create_file'
])

/**
 * Allows an AC Reviewer session to write ONLY its `.orca/task-bridge/ac-<KEY>.json` verdict file.
 */
export function isAcReviewerVerdictWrite(
  toolName: string,
  input: unknown,
  expectedTicketKey: string
): boolean {
  if (!AC_VERDICT_WRITE_TOOLS.has(toolName.trim().toLowerCase())) return false
  if (!input || typeof input !== 'object') return false
  const obj = input as Record<string, unknown>
  const rawPath =
    typeof obj.file_path === 'string'
      ? obj.file_path
      : typeof obj.path === 'string'
        ? obj.path
        : typeof obj.TargetFile === 'string'
          ? obj.TargetFile
          : typeof obj.target_file === 'string'
            ? obj.target_file
            : ''
  const rel = validateRelativeRepoPath(rawPath)
  const safeKey = validateTicketKey(expectedTicketKey)
  if (!rel || !safeKey) return false
  return (
    rel.toLowerCase() === `.orca/task-bridge/ac-${safeKey.toLowerCase()}.json` ||
    rel.toLowerCase().endsWith(`/.orca/task-bridge/ac-${safeKey.toLowerCase()}.json`)
  )
}
