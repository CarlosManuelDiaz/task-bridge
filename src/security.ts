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
  /\blin_oauth_[A-Za-z0-9]{16,}\b/g,
  // JSON Web Tokens (OAuth access/ID tokens): header.payload.signature, header always starts with `eyJ`
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
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
// URLs only ever reach `execFile` argument arrays (never a shell), so query separators such as `&`, `;`
// and `$` are allowed (Notion/Jira links use them). Quotes, angle brackets, backticks, pipes, backslashes,
// whitespace and control bytes stay rejected so a URL can never break out of prompt or Markdown text.
const UNSAFE_URL_CHARS = /['"`|<>\\\s\u0000-\u001F\u007F]/

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
  // Windows silently drops trailing dots/spaces (`.git.` is `.git`, `.. ` is `..`) and `:` opens an
  // alternate data stream, so compare segments the way the filesystem will resolve them.
  const resolvedSegment = (seg: string) => seg.replace(/[. ]+$/, '').toLowerCase()
  if (
    segments.length === 0 ||
    normalized.includes(':') ||
    segments.some((seg) => seg === '.' || seg === '..' || /^[. ]+$/.test(seg)) ||
    segments.some((seg) => resolvedSegment(seg) === '.git')
  ) {
    return null
  }
  return segments.join('/')
}

/**
 * Validates an HTTPS URL and ensures it contains no shell metacharacters or control bytes.
 */
export function validateHttpsUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || !rawUrl) return null
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

// `git branch` is only allowed in listing mode: every argument must be one of these flags (values via `=` only)
const GIT_BRANCH_LIST_FLAGS = new Set([
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--verbose',
  '-l',
  '--list',
  '--show-current',
  '--color',
  '--no-color',
  '--column',
  '--no-column',
  '-i',
  '--ignore-case',
  '--omit-empty',
  '--no-abbrev'
])

const GIT_BRANCH_LIST_FLAG_PREFIXES = [
  '--sort=',
  '--format=',
  '--color=',
  '--column=',
  '--contains=',
  '--no-contains=',
  '--merged=',
  '--no-merged=',
  '--points-at=',
  '--abbrev='
]

// Git global options that can run arbitrary programs (`-c core.fsmonitor=...`, `-c diff.external=...`)
function isDangerousGitGlobalOption(tok: string): boolean {
  return tok === '-c' || tok.startsWith('--config-env') || tok.startsWith('--exec-path')
}

// Subcommand arguments that write files (`--output`) or spawn external programs (`--ext-diff`, `-O<pager>`)
function isDangerousGitSubcommandArg(tok: string): boolean {
  return (
    tok === '--output' ||
    tok.startsWith('--output=') ||
    tok === '--ext-diff' ||
    tok.startsWith('--open-files-in-pager') ||
    /^-O/.test(tok)
  )
}

// Per-binary arguments that run commands or write files even though the binary itself is read-only
function hasDangerousReadOnlyCommandArg(bin: string, args: readonly string[]): boolean {
  for (const arg of args) {
    const isShortCluster = /^-[A-Za-z]+$/.test(arg)
    switch (bin) {
      case 'rg':
        // `--pre <cmd>` runs an arbitrary preprocessor for every searched file
        if (arg.startsWith('--pre')) return true
        break
      case 'ag':
        if (arg.startsWith('--pager')) return true
        break
      case 'fd':
        // `-x/--exec` and `-X/--exec-batch` run a command for each match
        if (arg.startsWith('--exec') || (isShortCluster && /[xX]/.test(arg))) return true
        break
      case 'tree':
        // `-o <file>` writes its output, `-R` writes 00Tree.html into every directory
        if (isShortCluster && /[oR]/.test(arg)) return true
        break
      case 'file':
        // `-C` compiles a magic file into the current directory
        if (arg === '--compile' || (isShortCluster && arg.includes('C'))) return true
        break
      default:
        break
    }
  }
  return false
}

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
      // Bash and PowerShell still expand `$(...)` and backticks inside double quotes
      if (quote === '"' && (ch === '`' || (ch === '$' && nextCh === '('))) {
        return null
      }
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

    // Reject unquoted subshells, PowerShell subexpressions `(...)` / `@(...)` and script blocks `{...}`
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
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
    if (isDangerousGitGlobalOption(tok)) return false
    if (tok === '-C' || tok === '--git-dir' || tok === '--work-tree') {
      idx += 2
      continue
    }
    idx += 1
  }
  const subcommand = tokens[idx]?.toLowerCase() ?? ''
  if (!ALLOWED_GIT_READ_SUBCOMMANDS.has(subcommand)) return false
  const args = tokens.slice(idx + 1)
  if (args.some(isDangerousGitSubcommandArg)) return false
  if (subcommand === 'branch') {
    for (const arg of args) {
      if (
        !GIT_BRANCH_LIST_FLAGS.has(arg) &&
        !GIT_BRANCH_LIST_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))
      ) {
        return false
      }
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
    if (hasDangerousReadOnlyCommandArg(bin, tokens.slice(1))) {
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

export interface WorktreeSetupCommandSpec {
  executable: string
  args: string[]
  display: string
}

const ALLOWED_SETUP_EXACT: Record<string, { executable: string; args: string[] }> = {
  'composer install': { executable: 'composer', args: ['install'] },
  'npm ci': { executable: 'npm', args: ['ci'] },
  'npm install': { executable: 'npm', args: ['install'] },
  'pnpm install': { executable: 'pnpm', args: ['install'] },
  'pnpm install --frozen-lockfile': {
    executable: 'pnpm',
    args: ['install', '--frozen-lockfile']
  },
  'yarn install': { executable: 'yarn', args: ['install'] },
  'yarn install --frozen-lockfile': {
    executable: 'yarn',
    args: ['install', '--frozen-lockfile']
  },
  'uv sync': { executable: 'uv', args: ['sync'] }
}

/**
 * Validates a `.task-bridge.json` `worktreeSetupCommands` entry against the strict allowlist (A5).
 * Returns null for unrecognized binaries, flags, or shell metacharacters.
 */
export function parseWorktreeSetupCommand(raw: unknown): WorktreeSetupCommandSpec | null {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().replace(/\s+/g, ' ').toLowerCase()
  const matched = ALLOWED_SETUP_EXACT[normalized]
  if (!matched) return null
  return {
    executable: matched.executable,
    args: [...matched.args],
    display: normalized
  }
}

/**
 * Detects whether a shell tool invocation runs any disallowed `git <subcommand>` configured
 * under `guard.denyGitWrites` (N2), reusing S2's quote-aware command segment splitter.
 */
export function findDeniedGitWriteInToolCall(
  toolName: string,
  input: unknown,
  deniedGitSubcommands: readonly string[]
): string | null {
  if (deniedGitSubcommands.length === 0) return null
  if (!PLAN_LOCK_SHELL_TOOLS.has(toolName.trim().toLowerCase())) return null
  const cmd = extractCommandTextForPlanLock(input)
  if (!cmd.trim()) return null

  const deniedSet = new Set(deniedGitSubcommands.map((s) => s.trim().toLowerCase()).filter(Boolean))

  // Backstop scan over the raw command text: catches git invoked through paths (`/usr/bin/git`),
  // `git.exe`, wrappers (`env`, `command`, `xargs`), nested shells (`sh -c "git push"`) and subshells.
  const rawGitInvocation =
    /(?:^|[\s;&|('"`/\\=])git(?:\.exe)?['"]?\s+((?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+|-\S+\s+)*)([A-Za-z][\w-]*)/gi
  for (const match of cmd.matchAll(rawGitInvocation)) {
    const sub = match[2]?.toLowerCase()
    if (sub && deniedSet.has(sub)) return sub
  }

  const segments = splitShellSegmentsAndCheckUnquotedMeta(cmd)
  if (!segments) return null

  for (const segment of segments) {
    const tokens = tokenizeSimpleShellSegment(segment)
    if (!tokens || tokens.length === 0) continue
    const bin = tokens[0].replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
    if (bin !== 'git' && bin !== 'git.exe') continue
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
    const sub = tokens[idx]?.toLowerCase() ?? ''
    if (sub && deniedSet.has(sub)) {
      return sub
    }
  }
  return null
}

function extractWriteTargetPath(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const field of ['file_path', 'path', 'TargetFile', 'target_file']) {
    const val = obj[field]
    if (typeof val === 'string') return val
  }
  return ''
}

function normalizeSlashPath(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Checks that a write targets exactly `.orca/task-bridge/<fileName>` inside the agent's worktree.
 * Accepts repo-relative paths and absolute paths (Claude Code's `Write` always sends absolute paths).
 * When `workspaceRoot` is known, absolute paths must resolve to `<workspaceRoot>/.orca/task-bridge/<fileName>`.
 */
function isTaskBridgeArtifactWrite(
  rawPath: string,
  fileName: string,
  workspaceRoot?: string | null
): boolean {
  if (!rawPath || /[\u0000-\u001F\u007F]/.test(rawPath)) return false
  const suffix = `.orca/task-bridge/${fileName}`.toLowerCase()
  const normalized = normalizeSlashPath(rawPath)
  const isAbsolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)

  if (!isAbsolute) {
    const rel = validateRelativeRepoPath(rawPath)
    if (!rel) return false
    const lower = rel.toLowerCase()
    return lower === suffix || lower.endsWith(`/${suffix}`)
  }

  const segments = normalized.split('/')
  if (segments.some((seg, i) => (seg === '.' || seg === '..') && i > 0)) return false
  const lower = normalized.toLowerCase()
  if (!lower.endsWith(`/${suffix}`)) return false
  if (!workspaceRoot) return true
  const root = normalizeSlashPath(workspaceRoot)
  if (!root || root === '.') return true
  return lower === `${root.toLowerCase()}/${suffix}`
}

/**
 * Allows an AC Reviewer session to write ONLY its `.orca/task-bridge/ac-<KEY>.json` verdict file.
 */
export function isAcReviewerVerdictWrite(
  toolName: string,
  input: unknown,
  expectedTicketKey: string,
  workspaceRoot?: string | null
): boolean {
  if (!AC_VERDICT_WRITE_TOOLS.has(toolName.trim().toLowerCase())) return false
  const safeKey = validateTicketKey(expectedTicketKey)
  if (!safeKey) return false
  return isTaskBridgeArtifactWrite(
    extractWriteTargetPath(input),
    `ac-${safeKey.toLowerCase()}.json`,
    workspaceRoot
  )
}

/**
 * Allows a read-only AC Proposer session to write ONLY its `.orca/task-bridge/proposed-ac-<KEY>.json` file.
 */
export function isProposedAcFileWrite(
  toolName: string,
  input: unknown,
  expectedTicketKey: string,
  workspaceRoot?: string | null
): boolean {
  if (!AC_VERDICT_WRITE_TOOLS.has(toolName.trim().toLowerCase())) return false
  const safeKey = validateTicketKey(expectedTicketKey)
  if (!safeKey) return false
  return isTaskBridgeArtifactWrite(
    extractWriteTargetPath(input),
    `proposed-ac-${safeKey.toLowerCase()}.json`,
    workspaceRoot
  )
}
