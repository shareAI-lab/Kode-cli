/**
 * Shell Allowlist - Auto-approval rules for safe shell commands
 *
 * Migrated from AgentTool/04-ShellTools/shell-allowlist.ts
 *
 * Features:
 * - Comprehensive allowlist for common tools (git, docker, npm, kubectl, etc.)
 * - Multiple rule types: prefix, exact, any, not_contains
 * - Shell-specific rules for bash/zsh/fish and PowerShell
 * - Easy extensibility for custom rules
 */

// ============================================================================
// Types
// ============================================================================

export type AllowlistRuleType = 'prefix' | 'exact' | 'any' | 'not_contains'

export interface ShellAllowlistEntry {
  type: AllowlistRuleType
  args?: string[]
}

export interface ShellAllowlist {
  auto_approval: Record<string, ShellAllowlistEntry | ShellAllowlistEntry[]>
}

export type ShellType = 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd'

// ============================================================================
// Command Parsing
// ============================================================================

/**
 * Naive command parser that splits a command into parts
 * Handles basic quoting but not all edge cases
 */
export function parseCommandNaive(command: string, _shellType: ShellType): string[] | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  const parts: string[] = []
  let current = ''
  let inQuote: string | null = null
  let escaped = false

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      inQuote = char
      continue
    }

    if (char === ' ' || char === '\t') {
      if (current) {
        parts.push(current)
        current = ''
      }
      continue
    }

    // Stop at pipe, redirect, or command separator
    if (char === '|' || char === '>' || char === '<' || char === ';' || char === '&') {
      break
    }

    current += char
  }

  if (current) {
    parts.push(current)
  }

  return parts.length > 0 ? parts : null
}

// ============================================================================
// Tool Allowlist (cross-platform)
// ============================================================================

const toolsAllowlist: ShellAllowlist = {
  auto_approval: {
    // Git commands
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

    // Kubernetes
    kubectl: [
      { type: 'prefix', args: ['get'] },
      { type: 'prefix', args: ['describe'] },
      { type: 'prefix', args: ['explain'] },
      { type: 'prefix', args: ['logs'] },
      { type: 'prefix', args: ['top'] },
      { type: 'prefix', args: ['api-resources'] },
      { type: 'prefix', args: ['api-versions'] },
      { type: 'prefix', args: ['version'] },
      { type: 'prefix', args: ['wait'] },
      { type: 'prefix', args: ['auth', 'can-i'] },
      { type: 'prefix', args: ['config', 'get-contexts'] },
      { type: 'prefix', args: ['config', 'view'] },
    ],

    // Bazel
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
      { type: 'prefix', args: ['coverage', '--nobuild'] },
      { type: 'prefix', args: ['mobile-install', '--nobuild'] },
      { type: 'prefix', args: ['run', '--nobuild'] },
      { type: 'prefix', args: ['test', '--nobuild'] },
      { type: 'prefix', args: ['clean', '--expunge', '--dry-run'] },
    ],

    // Docker
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

    // npm
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

    // Terraform
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
      { type: 'prefix', args: ['refresh', '--dry-run'] },
      { type: 'prefix', args: ['plan'] },
    ],

    // Gradle
    gradle: [
      { type: 'prefix', args: ['dependencies'] },
      { type: 'prefix', args: ['projects'] },
      { type: 'prefix', args: ['properties'] },
      { type: 'prefix', args: ['tasks'] },
      { type: 'prefix', args: ['components'] },
      { type: 'prefix', args: ['model'] },
      { type: 'prefix', args: ['buildEnvironment'] },
      { type: 'prefix', args: ['projectsEvaluated'] },
      { type: 'prefix', args: ['projects', '--dry-run'] },
      { type: 'prefix', args: ['dependencies', '--dry-run'] },
      { type: 'prefix', args: ['help'] },
      { type: 'prefix', args: ['version'] },
    ],

    // Helm
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

    // AWS CLI
    aws: [
      { type: 'prefix', args: ['s3', 'ls'] },
      { type: 'prefix', args: ['ec2', 'describe-instances'] },
      { type: 'prefix', args: ['rds', 'describe-db-instances'] },
      { type: 'prefix', args: ['iam', 'list-users'] },
      { type: 'prefix', args: ['iam', 'list-roles'] },
      { type: 'prefix', args: ['lambda', 'list-functions'] },
      { type: 'prefix', args: ['eks', 'list-clusters'] },
      { type: 'prefix', args: ['ecr', 'describe-repositories'] },
      { type: 'prefix', args: ['cloudformation', 'list-stacks'] },
      { type: 'prefix', args: ['configure', 'list'] },
    ],

    // Google Cloud CLI
    gcloud: [
      { type: 'prefix', args: ['projects', 'list'] },
      { type: 'prefix', args: ['compute', 'instances', 'list'] },
      { type: 'prefix', args: ['compute', 'zones', 'list'] },
      { type: 'prefix', args: ['compute', 'regions', 'list'] },
      { type: 'prefix', args: ['container', 'clusters', 'list'] },
      { type: 'prefix', args: ['services', 'list'] },
      { type: 'prefix', args: ['iam', 'roles', 'list'] },
      { type: 'prefix', args: ['config', 'list'] },
      { type: 'prefix', args: ['components', 'list'] },
      { type: 'prefix', args: ['version'] },
    ],

    // PostgreSQL
    psql: [{ type: 'prefix', args: ['-l'] }],
    pg_dump: [
      { type: 'prefix', args: ['--schema-only'] },
      { type: 'prefix', args: ['--schema', 'public', '--dry-run'] },
      { type: 'prefix', args: ['-s', '-t'] },
    ],
    pg_controldata: [{ type: 'any' }],
    pg_isready: [{ type: 'any' }],
    pg_lsclusters: [{ type: 'any' }],
    pg_activity: [{ type: 'any' }],
    pgbench: [{ type: 'prefix', args: ['-i', '--dry-run'] }],

    // Maven
    mvn: [
      { type: 'prefix', args: ['dependency:tree'] },
      { type: 'prefix', args: ['dependency:analyze'] },
      { type: 'prefix', args: ['help:effective-pom'] },
      { type: 'prefix', args: ['help:describe'] },
      { type: 'prefix', args: ['help:evaluate'] },
      { type: 'prefix', args: ['dependency:list'] },
      { type: 'prefix', args: ['dependency:build-classpath'] },
      { type: 'prefix', args: ['help:active-profiles'] },
      { type: 'prefix', args: ['help:effective-settings'] },
      { type: 'prefix', args: ['-version'] },
    ],

    // Redis CLI
    'redis-cli': [
      { type: 'prefix', args: ['info'] },
      { type: 'prefix', args: ['monitor'] },
      { type: 'prefix', args: ['memory', 'stats'] },
      { type: 'prefix', args: ['memory', 'doctor'] },
      { type: 'prefix', args: ['latency', 'doctor'] },
      { type: 'prefix', args: ['cluster', 'info'] },
      { type: 'prefix', args: ['client', 'list'] },
      { type: 'prefix', args: ['slowlog', 'get'] },
      { type: 'prefix', args: ['config', 'get'] },
      { type: 'prefix', args: ['info', 'keyspace'] },
    ],

    // Yarn
    yarn: [
      { type: 'prefix', args: ['list'] },
      { type: 'prefix', args: ['info'] },
      { type: 'prefix', args: ['why'] },
      { type: 'prefix', args: ['licenses', 'list'] },
      { type: 'prefix', args: ['outdated'] },
      { type: 'prefix', args: ['check'] },
      { type: 'prefix', args: ['audit'] },
      { type: 'prefix', args: ['workspaces', 'info'] },
      { type: 'prefix', args: ['--version'] },
      { type: 'prefix', args: ['config', 'list'] },
    ],

    // pnpm
    pnpm: [
      { type: 'prefix', args: ['list'] },
      { type: 'prefix', args: ['why'] },
      { type: 'prefix', args: ['outdated'] },
      { type: 'prefix', args: ['audit'] },
      { type: 'prefix', args: ['--version'] },
      { type: 'prefix', args: ['config', 'list'] },
    ],

    // Bun
    bun: [
      { type: 'prefix', args: ['pm', 'ls'] },
      { type: 'prefix', args: ['--version'] },
      { type: 'exact', args: ['--help'] },
    ],

    // Azure CLI
    az: [
      { type: 'prefix', args: ['account', 'list'] },
      { type: 'prefix', args: ['group', 'list'] },
      { type: 'prefix', args: ['vm', 'list'] },
      { type: 'prefix', args: ['aks', 'list'] },
      { type: 'prefix', args: ['acr', 'list'] },
      { type: 'prefix', args: ['storage', 'account', 'list'] },
      { type: 'prefix', args: ['network', 'vnet', 'list'] },
      { type: 'prefix', args: ['webapp', 'list'] },
      { type: 'prefix', args: ['functionapp', 'list'] },
      { type: 'prefix', args: ['version'] },
    ],

    // HashiCorp Vault
    vault: [
      { type: 'prefix', args: ['list'] },
      { type: 'prefix', args: ['policy', 'list'] },
      { type: 'prefix', args: ['auth', 'list'] },
      { type: 'prefix', args: ['secrets', 'list'] },
      { type: 'prefix', args: ['audit', 'list'] },
      { type: 'prefix', args: ['status'] },
      { type: 'prefix', args: ['token', 'lookup'] },
      { type: 'prefix', args: ['read'] },
      { type: 'prefix', args: ['version'] },
    ],

    // Podman
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

    // Deno
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
      { type: 'prefix', args: ['--version'] },
    ],

    // Rust toolchain
    rustup: [
      { type: 'prefix', args: ['show'] },
      { type: 'prefix', args: ['toolchain', 'list'] },
      { type: 'prefix', args: ['target', 'list'] },
      { type: 'prefix', args: ['component', 'list'] },
      { type: 'prefix', args: ['override', 'list'] },
      { type: 'prefix', args: ['which'] },
      { type: 'prefix', args: ['doc'] },
      { type: 'prefix', args: ['man'] },
      { type: 'prefix', args: ['--version'] },
    ],

    cargo: [
      { type: 'prefix', args: ['tree'] },
      { type: 'prefix', args: ['metadata'] },
      { type: 'prefix', args: ['--list'] },
      { type: 'prefix', args: ['verify'] },
      { type: 'prefix', args: ['search'] },
      { type: 'prefix', args: ['vendor', '--dry-run'] },
      { type: 'prefix', args: ['outdated'] },
      { type: 'prefix', args: ['doc'] },
      { type: 'prefix', args: ['config', 'get'] },
      { type: 'prefix', args: ['--version'] },
    ],

    // Python
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
      { type: 'prefix', args: ['--version'] },
    ],

    python: [{ type: 'exact', args: ['--version'] }, { type: 'exact', args: ['-V'] }],
    python3: [{ type: 'exact', args: ['--version'] }, { type: 'exact', args: ['-V'] }],

    // Go
    go: [
      { type: 'prefix', args: ['version'] },
      { type: 'prefix', args: ['env'] },
      { type: 'prefix', args: ['list'] },
      { type: 'prefix', args: ['mod', 'graph'] },
      { type: 'prefix', args: ['mod', 'why'] },
      { type: 'prefix', args: ['doc'] },
    ],
  },
}

// ============================================================================
// Shell-Specific Allowlists
// ============================================================================

const bashZshAllowlist: ShellAllowlist = {
  auto_approval: {
    cd: [{ type: 'any' }],
    date: [{ type: 'any' }],
    cal: [{ type: 'any' }],
    uname: [{ type: 'prefix', args: ['-a'] }],
    hostname: [{ type: 'any' }],
    whoami: [{ type: 'any' }],
    id: [{ type: 'any' }],
    ps: [{ type: 'any' }],
    free: [{ type: 'any' }],
    w: [{ type: 'any' }],
    who: [{ type: 'any' }],
    ping: [{ type: 'not_contains', args: ['-f'] }], // Disallow flood ping
    netstat: [{ type: 'any' }],
    ss: [{ type: 'any' }],
    ip: [{ type: 'prefix', args: ['addr'] }],
    dig: [{ type: 'any' }],
    nslookup: [{ type: 'any' }],
    pwd: [{ type: 'any' }],
    ls: [{ type: 'any' }],
    file: [{ type: 'any' }],
    stat: [{ type: 'any' }],
    du: [{ type: 'any' }],
    df: [{ type: 'any' }],
    cat: [{ type: 'any' }],
    less: [{ type: 'any' }],
    more: [{ type: 'any' }],
    head: [{ type: 'any' }],
    tail: [{ type: 'not_contains', args: ['-f'] }], // Disallow follow mode
    wc: [{ type: 'any' }],
    which: [{ type: 'any' }],
    whereis: [{ type: 'any' }],
    type: [{ type: 'any' }],
    echo: [{ type: 'any' }],
    printf: [{ type: 'any' }],
    env: [{ type: 'any' }],
    printenv: [{ type: 'any' }],
    uptime: [{ type: 'any' }],
    top: [{ type: 'exact', args: ['-bn1'] }], // Single snapshot only
    htop: [{ type: 'exact', args: [] }],
    find: [{ type: 'any' }],
    locate: [{ type: 'any' }],
    grep: [{ type: 'any' }],
    egrep: [{ type: 'any' }],
    fgrep: [{ type: 'any' }],
    rg: [{ type: 'any' }], // ripgrep
    ag: [{ type: 'any' }], // silver searcher
    awk: [{ type: 'any' }],
    sed: [{ type: 'any' }],
    sort: [{ type: 'any' }],
    uniq: [{ type: 'any' }],
    cut: [{ type: 'any' }],
    tr: [{ type: 'any' }],
    diff: [{ type: 'any' }],
    tree: [{ type: 'any' }],
    realpath: [{ type: 'any' }],
    readlink: [{ type: 'any' }],
    basename: [{ type: 'any' }],
    dirname: [{ type: 'any' }],
    md5sum: [{ type: 'any' }],
    sha256sum: [{ type: 'any' }],
    sha1sum: [{ type: 'any' }],
  },
}

const powershellAllowlist: ShellAllowlist = {
  auto_approval: {
    cd: [{ type: 'any' }],
    'Get-Date': [{ type: 'any' }],
    date: [{ type: 'any' }],
    'Get-ComputerInfo': [{ type: 'any' }],
    'Get-Host': [{ type: 'any' }],
    '$env:USERNAME': [{ type: 'any' }],
    whoami: [{ type: 'any' }],
    'Get-Process': [{ type: 'any' }],
    ps: [{ type: 'any' }],
    gps: [{ type: 'any' }],
    'Get-Service': [{ type: 'any' }],
    gsv: [{ type: 'any' }],
    'Get-NetIPAddress': [{ type: 'any' }],
    ipconfig: [{ type: 'any' }],
    'Get-NetTCPConnection': [{ type: 'any' }],
    netstat: [{ type: 'any' }],
    'Resolve-DnsName': [{ type: 'any' }],
    nslookup: [{ type: 'any' }],
    'Get-DnsClientServerAddress': [{ type: 'any' }],
    'Get-Location': [{ type: 'any' }],
    pwd: [{ type: 'any' }],
    gl: [{ type: 'any' }],
    'Get-ChildItem': [{ type: 'any' }],
    dir: [{ type: 'any' }],
    ls: [{ type: 'any' }],
    gci: [{ type: 'any' }],
    'Get-Item': [{ type: 'any' }],
    gi: [{ type: 'any' }],
    'Get-ItemProperty': [{ type: 'any' }],
    gp: [{ type: 'any' }],
    'Get-Content': [{ type: 'not_contains', args: ['-Wait'] }],
    cat: [{ type: 'any' }],
    gc: [{ type: 'any' }],
    type: [{ type: 'any' }],
    'Select-String': [{ type: 'any' }],
    sls: [{ type: 'any' }],
    findstr: [{ type: 'any' }],
    'Get-PSDrive': [{ type: 'any' }],
    gdr: [{ type: 'any' }],
    'Get-Volume': [{ type: 'any' }],
    'Measure-Object': [{ type: 'any' }],
    measure: [{ type: 'any' }],
    'Select-Object': [{ type: 'any' }],
    select: [{ type: 'any' }],
  },
}

// ============================================================================
// Allowlist API
// ============================================================================

/**
 * Get the combined allowlist for a specific shell
 */
export function getShellAllowlist(shell: ShellType): ShellAllowlist {
  let shellAllowlist: ShellAllowlist

  if (shell === 'bash' || shell === 'zsh' || shell === 'fish') {
    shellAllowlist = bashZshAllowlist
  } else if (shell === 'powershell') {
    shellAllowlist = powershellAllowlist
  } else {
    // For unknown shells, only use tool allowlist
    shellAllowlist = { auto_approval: {} }
  }

  // Combine shell allowlist with tools allowlist
  return {
    auto_approval: {
      ...shellAllowlist.auto_approval,
      ...toolsAllowlist.auto_approval,
    },
  }
}

/**
 * Check if a command matches the allowlist
 */
export function checkShellAllowlist(
  allowlist: ShellAllowlist,
  command: string,
  shell: ShellType
): boolean {
  const parsedCommand = parseCommandNaive(command, shell)
  if (!parsedCommand || parsedCommand.length === 0) {
    return false
  }

  const cmd = parsedCommand[0]
  const cmdArgs = parsedCommand.slice(1)
  const cmdRule = allowlist.auto_approval[cmd]

  if (!cmdRule) {
    // Tool not found in allowlist
    return false
  }

  const rules = Array.isArray(cmdRule) ? cmdRule : [cmdRule]

  for (const rule of rules) {
    const ruleArgs = rule.args ?? []

    switch (rule.type) {
      case 'prefix':
        // Check if command args start with rule args
        if (ruleArgs.length <= cmdArgs.length && ruleArgs.every((arg, i) => cmdArgs[i] === arg)) {
          return true
        }
        break

      case 'exact':
        // Check if command args exactly match rule args
        if (ruleArgs.length === cmdArgs.length && ruleArgs.every((arg, i) => cmdArgs[i] === arg)) {
          return true
        }
        break

      case 'any':
        // Any args are allowed
        return true

      case 'not_contains':
        // Check that command args don't contain any of the rule args
        if (!ruleArgs.some((arg) => cmdArgs.includes(arg))) {
          return true
        }
        break
    }
  }

  return false
}

/**
 * Check if a command is safe to auto-approve
 */
export function isCommandAutoApproved(command: string, shell: ShellType): boolean {
  const allowlist = getShellAllowlist(shell)
  return checkShellAllowlist(allowlist, command, shell)
}

/**
 * Add custom rules to the allowlist (returns new merged allowlist)
 */
export function extendAllowlist(
  base: ShellAllowlist,
  extensions: ShellAllowlist
): ShellAllowlist {
  const merged: ShellAllowlist = {
    auto_approval: { ...base.auto_approval },
  }

  for (const [cmd, rules] of Object.entries(extensions.auto_approval)) {
    const existing = merged.auto_approval[cmd]
    if (existing) {
      // Merge rules
      const existingArray = Array.isArray(existing) ? existing : [existing]
      const newArray = Array.isArray(rules) ? rules : [rules]
      merged.auto_approval[cmd] = [...existingArray, ...newArray]
    } else {
      merged.auto_approval[cmd] = rules
    }
  }

  return merged
}
