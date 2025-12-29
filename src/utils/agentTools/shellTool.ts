/**
 * Shell Tool - Integrated from AgentTool
 * Provides simple shell execution with YAML-based allowlist and timeout prediction
 */

import { exec, ChildProcess } from 'child_process'
import { platform } from 'os'
import { debug } from '@utils/debugLogger'
import { getCwd } from '@utils/state'

// Helper for logging
const log = (msg: string) => debug.trace('shell', msg)

// ============================================================================
// Types
// ============================================================================

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  interrupted: boolean
  durationMs: number
}

export interface ShellOptions {
  /** Working directory */
  cwd?: string
  /** Timeout in ms (default: 120000) */
  timeout?: number
  /** Shell to use */
  shell?: string
  /** Environment variables */
  env?: Record<string, string>
  /** Abort signal */
  abortSignal?: AbortSignal
}

export type ShellAllowlistEntry = {
  type: 'prefix' | 'exact' | 'any' | 'not_contains'
  args?: string[]
}

export type ShellAllowlist = {
  [tool: string]: ShellAllowlistEntry | ShellAllowlistEntry[]
}

export type ShellType = 'bash' | 'zsh' | 'fish' | 'powershell'

// ============================================================================
// Shell Allowlist - YAML-based comprehensive list from AgentTool
// ============================================================================

/**
 * Tools allowlist - common DevOps and development tools
 */
const TOOLS_ALLOWLIST: ShellAllowlist = {
  // Git - read-only operations
  git: [
    { type: 'prefix', args: ['status'] },
    { type: 'prefix', args: ['log'] },
    { type: 'prefix', args: ['diff'] },
    { type: 'prefix', args: ['show'] },
    { type: 'exact', args: ['branch'] },
    { type: 'prefix', args: ['ls-files'] },
    { type: 'prefix', args: ['blame'] },
    { type: 'prefix', args: ['rev-parse'] },
    { type: 'prefix', args: ['remote', '-v'] },
    { type: 'prefix', args: ['config', '--list'] },
    { type: 'exact', args: ['config', 'user.name'] },
    { type: 'exact', args: ['config', 'user.email'] },
    { type: 'exact', args: ['branch', '--show-current'] },
  ],
  // kubectl - read operations
  kubectl: [
    { type: 'prefix', args: ['get'] },
    { type: 'prefix', args: ['describe'] },
    { type: 'prefix', args: ['explain'] },
    { type: 'prefix', args: ['logs'] },
    { type: 'prefix', args: ['top'] },
    { type: 'prefix', args: ['api-resources'] },
    { type: 'prefix', args: ['api-versions'] },
    { type: 'prefix', args: ['version'] },
    { type: 'prefix', args: ['auth', 'can-i'] },
    { type: 'prefix', args: ['config', 'get-contexts'] },
    { type: 'prefix', args: ['config', 'view'] },
  ],
  // Docker - read operations
  docker: [
    { type: 'prefix', args: ['ps'] },
    { type: 'prefix', args: ['images'] },
    { type: 'prefix', args: ['network', 'ls'] },
    { type: 'prefix', args: ['volume', 'ls'] },
    { type: 'prefix', args: ['port'] },
    { type: 'prefix', args: ['stats'] },
    { type: 'prefix', args: ['events'] },
    { type: 'prefix', args: ['diff'] },
    { type: 'prefix', args: ['history'] },
    { type: 'prefix', args: ['system', 'df'] },
    { type: 'prefix', args: ['top'] },
    { type: 'prefix', args: ['version'] },
    { type: 'prefix', args: ['inspect'] },
  ],
  // npm - read operations
  npm: [
    { type: 'prefix', args: ['list'] },
    { type: 'prefix', args: ['outdated'] },
    { type: 'prefix', args: ['doctor'] },
    { type: 'prefix', args: ['audit'] },
    { type: 'prefix', args: ['token', 'list'] },
    { type: 'prefix', args: ['ping'] },
    { type: 'prefix', args: ['view'] },
    { type: 'prefix', args: ['owner', 'ls'] },
    { type: 'prefix', args: ['fund'] },
    { type: 'prefix', args: ['explain'] },
    { type: 'prefix', args: ['ls'] },
    { type: 'prefix', args: ['why'] },
    { type: 'prefix', args: ['prefix'] },
  ],
  // yarn - read operations
  yarn: [
    { type: 'prefix', args: ['list'] },
    { type: 'prefix', args: ['info'] },
    { type: 'prefix', args: ['why'] },
    { type: 'prefix', args: ['licenses', 'list'] },
    { type: 'prefix', args: ['outdated'] },
    { type: 'prefix', args: ['check'] },
    { type: 'prefix', args: ['audit'] },
    { type: 'prefix', args: ['workspaces', 'info'] },
    { type: 'prefix', args: ['version'] },
    { type: 'prefix', args: ['config', 'list'] },
  ],
  // pip - read operations
  pip: [
    { type: 'prefix', args: ['list'] },
    { type: 'prefix', args: ['show'] },
    { type: 'prefix', args: ['check'] },
    { type: 'prefix', args: ['debug'] },
    { type: 'prefix', args: ['config', 'list'] },
    { type: 'prefix', args: ['index'] },
    { type: 'prefix', args: ['hash'] },
    { type: 'prefix', args: ['cache', 'list'] },
    { type: 'prefix', args: ['freeze'] },
    { type: 'prefix', args: ['version'] },
  ],
  // cargo - read operations
  cargo: [
    { type: 'prefix', args: ['tree'] },
    { type: 'prefix', args: ['metadata'] },
    { type: 'prefix', args: ['list'] },
    { type: 'prefix', args: ['verify'] },
    { type: 'prefix', args: ['search'] },
    { type: 'prefix', args: ['vendor', '--dry-run'] },
    { type: 'prefix', args: ['outdated'] },
    { type: 'prefix', args: ['doc'] },
    { type: 'prefix', args: ['config', 'get'] },
    { type: 'prefix', args: ['version'] },
  ],
  // bazel - read operations
  bazel: [
    { type: 'prefix', args: ['query'] },
    { type: 'prefix', args: ['cquery'] },
    { type: 'prefix', args: ['config'] },
    { type: 'prefix', args: ['info'] },
    { type: 'prefix', args: ['version'] },
    { type: 'prefix', args: ['help'] },
    { type: 'prefix', args: ['analyze-profile'] },
    { type: 'prefix', args: ['aquery'] },
    { type: 'prefix', args: ['dump'] },
    { type: 'prefix', args: ['license'] },
    { type: 'prefix', args: ['print'] },
    { type: 'prefix', args: ['build', '--nobuild'] },
    { type: 'prefix', args: ['test', '--nobuild'] },
    { type: 'prefix', args: ['run', '--nobuild'] },
  ],
  // terraform - read/plan operations
  terraform: [
    { type: 'prefix', args: ['show'] },
    { type: 'prefix', args: ['providers'] },
    { type: 'prefix', args: ['state', 'list'] },
    { type: 'prefix', args: ['state', 'show'] },
    { type: 'prefix', args: ['version'] },
    { type: 'prefix', args: ['fmt', '--check'] },
    { type: 'prefix', args: ['validate'] },
    { type: 'prefix', args: ['graph'] },
    { type: 'prefix', args: ['console'] },
    { type: 'prefix', args: ['output'] },
    { type: 'prefix', args: ['plan'] },
  ],
  // gradle - read operations
  gradle: [
    { type: 'prefix', args: ['dependencies'] },
    { type: 'prefix', args: ['projects'] },
    { type: 'prefix', args: ['properties'] },
    { type: 'prefix', args: ['tasks'] },
    { type: 'prefix', args: ['components'] },
    { type: 'prefix', args: ['model'] },
    { type: 'prefix', args: ['buildEnvironment'] },
    { type: 'prefix', args: ['help'] },
    { type: 'prefix', args: ['version'] },
  ],
  // helm - read operations
  helm: [
    { type: 'prefix', args: ['list'] },
    { type: 'prefix', args: ['get', 'values'] },
    { type: 'prefix', args: ['get', 'manifest'] },
    { type: 'prefix', args: ['get', 'hooks'] },
    { type: 'prefix', args: ['get', 'notes'] },
    { type: 'prefix', args: ['status'] },
    { type: 'prefix', args: ['dependency', 'list'] },
    { type: 'prefix', args: ['show', 'chart'] },
    { type: 'prefix', args: ['show', 'values'] },
    { type: 'prefix', args: ['verify'] },
    { type: 'prefix', args: ['version'] },
    { type: 'prefix', args: ['env'] },
  ],
  // rustup - read operations
  rustup: [
    { type: 'prefix', args: ['show'] },
    { type: 'prefix', args: ['toolchain', 'list'] },
    { type: 'prefix', args: ['target', 'list'] },
    { type: 'prefix', args: ['component', 'list'] },
    { type: 'prefix', args: ['override', 'list'] },
    { type: 'prefix', args: ['which'] },
    { type: 'prefix', args: ['doc'] },
    { type: 'prefix', args: ['man'] },
    { type: 'prefix', args: ['version'] },
  ],
  // deno - read operations
  deno: [
    { type: 'prefix', args: ['info'] },
    { type: 'prefix', args: ['list'] },
    { type: 'prefix', args: ['doc'] },
    { type: 'prefix', args: ['lint'] },
    { type: 'prefix', args: ['types'] },
    { type: 'prefix', args: ['check'] },
    { type: 'prefix', args: ['compile', '--dry-run'] },
    { type: 'prefix', args: ['task', '--list'] },
    { type: 'prefix', args: ['test', '--dry-run'] },
    { type: 'prefix', args: ['version'] },
  ],
  // podman - read operations
  podman: [
    { type: 'prefix', args: ['ps'] },
    { type: 'prefix', args: ['images'] },
    { type: 'prefix', args: ['pod', 'ps'] },
    { type: 'prefix', args: ['volume', 'ls'] },
    { type: 'prefix', args: ['network', 'ls'] },
    { type: 'prefix', args: ['stats'] },
    { type: 'prefix', args: ['top'] },
    { type: 'prefix', args: ['logs'] },
    { type: 'prefix', args: ['inspect'] },
    { type: 'prefix', args: ['port'] },
  ],
}

/**
 * Unix shell commands allowlist (bash, zsh, fish)
 */
const UNIX_SHELL_ALLOWLIST: ShellAllowlist = {
  cd: { type: 'any' },
  date: { type: 'any' },
  cal: { type: 'any' },
  uname: { type: 'prefix', args: ['-a'] },
  hostname: { type: 'any' },
  whoami: { type: 'any' },
  id: { type: 'any' },
  ps: { type: 'any' },
  free: { type: 'any' },
  w: { type: 'any' },
  who: { type: 'any' },
  ping: { type: 'not_contains', args: ['-f'] },
  netstat: { type: 'any' },
  ss: { type: 'any' },
  ip: { type: 'prefix', args: ['addr'] },
  dig: { type: 'any' },
  nslookup: { type: 'any' },
  pwd: { type: 'any' },
  ls: { type: 'any' },
  file: { type: 'any' },
  stat: { type: 'any' },
  du: { type: 'any' },
  df: { type: 'any' },
  cat: { type: 'any' },
  less: { type: 'any' },
  more: { type: 'any' },
  head: { type: 'any' },
  tail: { type: 'not_contains', args: ['-f'] },
  wc: { type: 'any' },
  which: { type: 'any' },
  whereis: { type: 'any' },
  echo: { type: 'any' },
  printf: { type: 'any' },
  env: { type: 'any' },
  printenv: { type: 'any' },
  grep: { type: 'any' },
  egrep: { type: 'any' },
  fgrep: { type: 'any' },
  rg: { type: 'any' },
  ag: { type: 'any' },
  ack: { type: 'any' },
  find: { type: 'any' },
  locate: { type: 'any' },
  sort: { type: 'any' },
  uniq: { type: 'any' },
  cut: { type: 'any' },
  tr: { type: 'any' },
  diff: { type: 'any' },
  uptime: { type: 'any' },
  lsof: { type: 'any' },
  pgrep: { type: 'any' },
  test: { type: 'any' },
  '[': { type: 'any' },
  true: { type: 'any' },
  false: { type: 'any' },
}

/**
 * PowerShell commands allowlist
 */
const POWERSHELL_ALLOWLIST: ShellAllowlist = {
  cd: { type: 'any' },
  'Get-Date': { type: 'any' },
  'Get-ComputerInfo': { type: 'any' },
  'Get-Host': { type: 'any' },
  '$env:USERNAME': { type: 'any' },
  whoami: { type: 'any' },
  'Get-Process': { type: 'any' },
  ps: { type: 'any' },
  gps: { type: 'any' },
  'Get-Service': { type: 'any' },
  gsv: { type: 'any' },
  'Get-NetIPAddress': { type: 'any' },
  ipconfig: { type: 'any' },
  'Get-NetTCPConnection': { type: 'any' },
  netstat: { type: 'any' },
  'Resolve-DnsName': { type: 'any' },
  nslookup: { type: 'any' },
  'Get-Location': { type: 'any' },
  pwd: { type: 'any' },
  gl: { type: 'any' },
  'Get-ChildItem': { type: 'any' },
  dir: { type: 'any' },
  ls: { type: 'any' },
  gci: { type: 'any' },
  'Get-Item': { type: 'any' },
  gi: { type: 'any' },
  'Get-ItemProperty': { type: 'any' },
  gp: { type: 'any' },
  'Get-Content': { type: 'not_contains', args: ['-Wait'] },
  cat: { type: 'any' },
  gc: { type: 'any' },
  type: { type: 'any' },
  'Select-String': { type: 'any' },
  sls: { type: 'any' },
  findstr: { type: 'any' },
  'Get-PSDrive': { type: 'any' },
  gdr: { type: 'any' },
  'Get-Volume': { type: 'any' },
  'Measure-Object': { type: 'any' },
  measure: { type: 'any' },
  'Select-Object': { type: 'any' },
  select: { type: 'any' },
}

/**
 * Commands that should never be executed
 */
const BANNED_PATTERNS = new Set([
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf ~/*',
  ':(){:|:&};:',  // Fork bomb
  'dd if=/dev/zero',
  'mkfs',
  'fdisk',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init 0',
  'init 6',
])

// ============================================================================
// Allowlist Checking Functions
// ============================================================================

/**
 * Parse command into base command and arguments
 */
function parseCommandParts(command: string): { base: string; args: string[] } {
  const trimmed = command.trim()

  // Parse into parts respecting quotes
  const parts: string[] = []
  let current = ''
  let inQuote = ''

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]

    if (inQuote) {
      if (char === inQuote) {
        inQuote = ''
      } else {
        current += char
      }
    } else if (char === '"' || char === "'") {
      inQuote = char
    } else if (char === ' ' || char === '\t') {
      if (current) {
        parts.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) {
    parts.push(current)
  }

  return {
    base: parts[0] || '',
    args: parts.slice(1),
  }
}

/**
 * Check if command args match an allowlist entry
 */
function matchesAllowlistEntry(
  args: string[],
  entry: ShellAllowlistEntry
): boolean {
  switch (entry.type) {
    case 'any':
      return true

    case 'exact':
      if (!entry.args) return true
      if (args.length !== entry.args.length) return false
      return entry.args.every((expected, i) => args[i] === expected)

    case 'prefix':
      if (!entry.args) return true
      if (args.length < entry.args.length) return false
      return entry.args.every((expected, i) => args[i] === expected)

    case 'not_contains':
      if (!entry.args) return true
      return !entry.args.some(forbidden => args.includes(forbidden))

    default:
      return false
  }
}

/**
 * Check if command matches the allowlist
 */
function checkAllowlist(command: string, allowlist: ShellAllowlist): boolean {
  const { base, args } = parseCommandParts(command)
  const lowercaseBase = base.toLowerCase()

  const entry = allowlist[base] || allowlist[lowercaseBase]
  if (!entry) return false

  const entries = Array.isArray(entry) ? entry : [entry]
  return entries.some(e => matchesAllowlistEntry(args, e))
}

/**
 * Get the combined allowlist based on shell type
 */
export function getShellAllowlist(shellName?: string): ShellAllowlist {
  const currentPlatform = platform()
  const isWindows = currentPlatform === 'win32'
  const shell = shellName?.toLowerCase() || ''

  // Start with tools allowlist (available on all platforms)
  const combined: ShellAllowlist = { ...TOOLS_ALLOWLIST }

  // Add shell-specific allowlist
  if (isWindows || shell.includes('powershell') || shell.includes('pwsh')) {
    Object.assign(combined, POWERSHELL_ALLOWLIST)
  } else {
    Object.assign(combined, UNIX_SHELL_ALLOWLIST)
  }

  return combined
}

/**
 * Check if a command is in the safe allowlist
 */
export function isCommandSafe(command: string, shellName?: string): boolean {
  const trimmedCommand = command.trim()

  // Check banned patterns first
  if (isCommandBanned(trimmedCommand)) {
    return false
  }

  // Get the allowlist for the current shell
  const allowlist = getShellAllowlist(shellName)

  // Check command against allowlist
  return checkAllowlist(trimmedCommand, allowlist)
}

/**
 * Check if a command contains banned patterns
 */
export function isCommandBanned(command: string): boolean {
  const trimmedCommand = command.trim().toLowerCase()

  for (const banned of BANNED_PATTERNS) {
    if (trimmedCommand.includes(banned)) {
      return true
    }
  }

  return false
}

// ============================================================================
// Command Timeout Prediction
// ============================================================================

/**
 * Predict appropriate timeout for a command
 */
export function predictCommandTimeout(command: string): number {
  const trimmed = command.trim().toLowerCase()

  // Long-running commands
  if (
    trimmed.includes('npm install') ||
    trimmed.includes('yarn install') ||
    trimmed.includes('pip install') ||
    trimmed.includes('cargo build') ||
    trimmed.includes('go build') ||
    trimmed.includes('make') ||
    trimmed.includes('gradle') ||
    trimmed.includes('maven') ||
    trimmed.includes('mvn')
  ) {
    return 600000 // 10 minutes
  }

  // Test commands
  if (
    trimmed.includes('npm test') ||
    trimmed.includes('yarn test') ||
    trimmed.includes('pytest') ||
    trimmed.includes('jest') ||
    trimmed.includes('mocha') ||
    trimmed.includes('cargo test') ||
    trimmed.includes('go test')
  ) {
    return 300000 // 5 minutes
  }

  // Network commands
  if (
    trimmed.includes('curl') ||
    trimmed.includes('wget') ||
    trimmed.includes('git clone') ||
    trimmed.includes('git pull') ||
    trimmed.includes('git fetch')
  ) {
    return 180000 // 3 minutes
  }

  // Quick commands
  if (
    trimmed.startsWith('ls') ||
    trimmed.startsWith('cat') ||
    trimmed.startsWith('echo') ||
    trimmed.startsWith('pwd') ||
    trimmed.startsWith('which') ||
    trimmed.startsWith('git status') ||
    trimmed.startsWith('git branch')
  ) {
    return 30000 // 30 seconds
  }

  // Default
  return 120000 // 2 minutes
}

// ============================================================================
// Shell Execution
// ============================================================================

/**
 * Quote command for shell execution
 */
export function quoteCommand(command: string, shell: string = 'bash'): string {
  if (shell === 'bash' || shell === 'sh' || shell === 'zsh') {
    // Escape single quotes by ending the string, adding escaped quote, starting new string
    const escaped = command.replace(/'/g, "'\"'\"'")
    return `'${escaped}'`
  }
  return command
}

/**
 * Get the default shell for the current platform
 */
export function getDefaultShell(): string {
  if (platform() === 'win32') {
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/**
 * Execute a shell command with enhanced options
 */
export async function executeShell(
  command: string,
  options: ShellOptions = {}
): Promise<ShellResult> {
  const startTime = Date.now()
  const {
    cwd = getCwd(),
    timeout = predictCommandTimeout(command),
    shell = getDefaultShell(),
    env,
    abortSignal,
  } = options

  log( `Executing: ${command}`)
  log( `Options: cwd=${cwd}, timeout=${timeout}, shell=${shell}`)

  // Check for banned commands
  if (isCommandBanned(command)) {
    return {
      stdout: '',
      stderr: 'Error: This command is blocked for security reasons.',
      exitCode: 1,
      timedOut: false,
      interrupted: false,
      durationMs: Date.now() - startTime,
    }
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let interrupted = false
    let childProcess: ChildProcess | null = null

    const timeoutId = setTimeout(() => {
      timedOut = true
      if (childProcess && !childProcess.killed) {
        childProcess.kill('SIGTERM')
        // Force kill after 5 seconds if still running
        setTimeout(() => {
          if (childProcess && !childProcess.killed) {
            childProcess.kill('SIGKILL')
          }
        }, 5000)
      }
    }, timeout)

    // Handle abort signal
    if (abortSignal) {
      const abortHandler = () => {
        interrupted = true
        clearTimeout(timeoutId)
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGTERM')
        }
      }

      if (abortSignal.aborted) {
        resolve({
          stdout: '',
          stderr: 'Command was cancelled before execution.',
          exitCode: 130,
          timedOut: false,
          interrupted: true,
          durationMs: Date.now() - startTime,
        })
        return
      }

      abortSignal.addEventListener('abort', abortHandler, { once: true })
    }

    // Build exec command
    let execCommand = command
    if (shell.includes('bash') || shell.includes('zsh')) {
      execCommand = `${shell} -l -c ${quoteCommand(command, shell)}`
    }

    // Merge environment
    const mergedEnv = env ? { ...process.env, ...env } : process.env

    childProcess = exec(
      execCommand,
      {
        cwd,
        env: mergedEnv as NodeJS.ProcessEnv,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        timeout: 0, // We handle timeout ourselves
      },
      (error, stdoutData, stderrData) => {
        clearTimeout(timeoutId)

        stdout = stdoutData || ''
        stderr = stderrData || ''

        let exitCode = 0
        if (error) {
          exitCode = (error as any).code || 1
        }

        if (timedOut) {
          stderr += `\nCommand timed out after ${timeout / 1000}s`
        }

        if (interrupted) {
          stderr += '\nCommand was interrupted'
        }

        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode,
          timedOut,
          interrupted,
          durationMs: Date.now() - startTime,
        })
      }
    )
  })
}

/**
 * Simple shell execution (returns stdout/stderr combined)
 */
export async function simpleShell(
  command: string,
  options: ShellOptions = {}
): Promise<string> {
  const result = await executeShell(command, options)
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  return output
}

/**
 * Execute multiple commands sequentially
 */
export async function executeShellSequence(
  commands: string[],
  options: ShellOptions = {}
): Promise<ShellResult[]> {
  const results: ShellResult[] = []

  for (const command of commands) {
    const result = await executeShell(command, options)
    results.push(result)

    // Stop on error unless the command is expected to potentially fail
    if (result.exitCode !== 0 && !result.timedOut && !result.interrupted) {
      break
    }
  }

  return results
}

// ============================================================================
// Shell Utilities
// ============================================================================

/**
 * Parse a command string into parts
 */
export function parseCommand(command: string): {
  base: string
  args: string[]
  pipes: string[]
} {
  // Split by pipes first
  const pipes = command.split('|').map(s => s.trim())
  const firstCommand = pipes[0] || ''

  // Parse first command for base and args
  const parts = firstCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  const base = parts[0] || ''
  const args = parts.slice(1)

  return { base, args, pipes }
}

/**
 * Check if command is a directory change
 */
export function isDirectoryChange(command: string): string | null {
  const trimmed = command.trim()
  const match = trimmed.match(/^cd\s+(.+)$/)
  return match ? match[1].replace(/^['"]|['"]$/g, '') : null
}

/**
 * Get shell type for platform
 */
export function getShellType(): 'unix' | 'windows' {
  return platform() === 'win32' ? 'windows' : 'unix'
}
