// Security boundary helpers for Task Bridge:
// - Strict allowlist validation for CLI parameters (keys, branches, agents, statuses, URLs, Notion IDs)
// - ANSI/OSC terminal escape sequence stripping
// - Automatic credential/token redaction to prevent accidental secret leakage

const ANSI_ESCAPE_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bntn_[A-Za-z0-9]{12,}\b/g,
  /\bsecret_[A-Za-z0-9]{16,}\b/g,
  /\blin_api_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bATATT3x[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi
]

const ALLOWED_AGENTS = new Set(['antigravity', 'claude', 'codex', 'gemini', 'cursor'])
const TICKET_KEY_REGEX = /^[A-Z0-9]{1,12}-[A-Z0-9]{1,12}$/
const SAFE_BRANCH_REGEX = /^[A-Za-z0-9]+(?:[._/-][A-Za-z0-9]+)*$/
const SAFE_PREFIX_REGEX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,23}$/
const NOTION_ID_REGEX =
  /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/
const UNSAFE_URL_CHARS = /['"`$;&|<>\\\s\u0000-\u001F\u007F]/

/**
 * Strips ANSI/OSC terminal escape codes, control characters, and redacts any embedded API tokens.
 */
export function sanitizeUntrustedText(input: string, maxLength = 4000): string {
  if (!input) return ''
  const withoutAnsi = input.replace(ANSI_ESCAPE_REGEX, '')
  const withoutCtrl = withoutAnsi.replace(CONTROL_CHARS_REGEX, '')
  const redacted = redactSecrets(withoutCtrl)
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
