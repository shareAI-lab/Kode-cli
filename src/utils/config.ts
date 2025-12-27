import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'
import { cloneDeep, memoize, pick } from 'lodash-es'
import { homedir } from 'os'
import { GLOBAL_CLAUDE_FILE } from './env'
import { getCwd } from './state'
import { randomBytes } from 'crypto'
import { safeParseJSON } from './json'
import { ConfigParseError } from './errors'
import type { ThemeNames } from './theme'
import { debug as debugLogger } from './debugLogger'
import { getSessionState, setSessionState } from './sessionState'

export type McpStdioServerConfig = {
  type?: 'stdio' // Optional for backwards compatibility
  command: string
  args: string[]
  env?: Record<string, string>
}

export type McpSSEServerConfig = {
  type: 'sse'
  url: string
}

export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig

export type ProjectConfig = {
  allowedTools: string[]
  context: Record<string, string>
  contextFiles?: string[]
  history: string[]
  dontCrawlDirectory?: boolean
  enableArchitectTool?: boolean
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  approvedMcprcServers?: string[]
  rejectedMcprcServers?: string[]
  lastAPIDuration?: number
  lastCost?: number
  lastDuration?: number
  lastSessionId?: string
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number
  hasTrustDialogAccepted?: boolean
  hasCompletedProjectOnboarding?: boolean
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  context: {},
  history: [],
  dontCrawlDirectory: false,
  enableArchitectTool: false,
  mcpContextUris: [],
  mcpServers: {},
  approvedMcprcServers: [],
  rejectedMcprcServers: [],
  hasTrustDialogAccepted: false,
}

function defaultConfigForProject(projectPath: string): ProjectConfig {
  const config = { ...DEFAULT_PROJECT_CONFIG }
  if (projectPath === homedir()) {
    config.dontCrawlDirectory = true
  }
  return config
}

export type AutoUpdaterStatus =
  | 'disabled'
  | 'enabled'
  | 'no_permissions'
  | 'not_configured'

export function isAutoUpdaterStatus(value: string): value is AutoUpdaterStatus {
  return ['disabled', 'enabled', 'no_permissions', 'not_configured'].includes(
    value as AutoUpdaterStatus,
  )
}

export type NotificationChannel =
  | 'iterm2'
  | 'terminal_bell'
  | 'iterm2_with_bell'
  | 'notifications_disabled'

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'mistral'
  | 'deepseek'
  | 'kimi'
  | 'qwen'
  | 'glm'
  | 'minimax'
  | 'baidu-qianfan'
  | 'siliconflow'
  | 'bigdream'
  | 'opendev'
  | 'xai'
  | 'groq'
  | 'gemini'
  | 'ollama'
  | 'azure'
  | 'custom'
  | 'custom-openai'

// New model system types
export type ModelProfile = {
  name: string // User-friendly name
  provider: ProviderType // Provider type
  modelName: string // Primary key - actual model identifier
  baseURL?: string // Custom endpoint
  apiKey: string
  maxTokens: number // Output token limit (for GPT-5, this maps to max_completion_tokens)
  contextLength: number // Context window size
  reasoningEffort?: 'low' | 'medium' | 'high' | 'minimal' | 'medium'
  isActive: boolean // Whether profile is enabled
  createdAt: number // Creation timestamp
  lastUsed?: number // Last usage timestamp
  // 🔥 GPT-5 specific metadata
  isGPT5?: boolean // Auto-detected GPT-5 model flag
  validationStatus?: 'valid' | 'needs_repair' | 'auto_repaired' // Configuration status
  lastValidation?: number // Last validation timestamp
}

export type ModelPointerType = 'main' | 'task' | 'reasoning' | 'quick'

export type ModelPointers = {
  main: string // Main dialog model ID
  task: string // Task tool model ID
  reasoning: string // Reasoning model ID
  quick: string // Quick model ID
}

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
}

export type GlobalConfig = {
  projects?: Record<string, ProjectConfig>
  numStartups: number
  autoUpdaterStatus?: AutoUpdaterStatus
  userID?: string
  theme: ThemeNames
  hasCompletedOnboarding?: boolean
  // Tracks the last version that reset onboarding, used with MIN_VERSION_REQUIRING_ONBOARDING_RESET
  lastOnboardingVersion?: string
  // Tracks the last version for which release notes were seen, used for managing release notes
  lastReleaseNotesSeen?: string
  mcpServers?: Record<string, McpServerConfig>
  preferredNotifChannel: NotificationChannel
  verbose: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryProvider?: ProviderType
  maxTokens?: number
  hasAcknowledgedCostThreshold?: boolean
  oauthAccount?: AccountInfo
  iterm2KeyBindingInstalled?: boolean // Legacy - keeping for backward compatibility
  shiftEnterKeyBindingInstalled?: boolean
  proxy?: string
  stream?: boolean

  // New model system
  modelProfiles?: ModelProfile[] // Model configuration list
  modelPointers?: ModelPointers // Model pointer system
  defaultModelName?: string // Default model
  // Update notifications
  lastDismissedUpdateVersion?: string
  // Auto-compact threshold ratio (0-1), triggers when context usage exceeds this ratio
  autoCompactThreshold?: number
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  numStartups: 0,
  autoUpdaterStatus: 'not_configured',
  theme: 'dark' as ThemeNames,
  preferredNotifChannel: 'iterm2',
  verbose: false,
  primaryProvider: 'anthropic' as ProviderType,
  customApiKeyResponses: {
    approved: [],
    rejected: [],
  },
  stream: true,

  // New model system defaults
  modelProfiles: [],
  modelPointers: {
    main: '',
    task: '',
    reasoning: '',
    quick: '',
  },
  lastDismissedUpdateVersion: undefined,
}

export const GLOBAL_CONFIG_KEYS = [
  'autoUpdaterStatus',
  'autoCompactThreshold',
  'theme',
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'lastReleaseNotesSeen',
  'verbose',
  'customApiKeyResponses',
  'primaryProvider',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'maxTokens',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'dontCrawlDirectory',
  'enableArchitectTool',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

export function checkHasTrustDialogAccepted(): boolean {
  let currentPath = getCwd()
  const config = getConfig(GLOBAL_CLAUDE_FILE, DEFAULT_GLOBAL_CONFIG)

  while (true) {
    const projectConfig = config.projects?.[currentPath]
    if (projectConfig?.hasTrustDialogAccepted) {
      return true
    }
    const parentPath = resolve(currentPath, '..')
    // Stop if we've reached the root (when parent is same as current)
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

// We have to put this test code here because Jest doesn't support mocking ES modules :O
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdaterStatus: 'disabled',
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

export function saveGlobalConfig(config: GlobalConfig): void {
  if (process.env.NODE_ENV === 'test') {
    for (const key in config) {
      TEST_GLOBAL_CONFIG_FOR_TESTING[key] = config[key]
    }
    return
  }

  // 直接保存配置（无需清除缓存，因为已移除缓存）
  saveConfig(
    GLOBAL_CLAUDE_FILE,
    {
      ...config,
      projects: getConfig(GLOBAL_CLAUDE_FILE, DEFAULT_GLOBAL_CONFIG).projects,
    },
    DEFAULT_GLOBAL_CONFIG,
  )
}

// 临时移除缓存，确保总是获取最新配置
export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }
  const config = getConfig(GLOBAL_CLAUDE_FILE, DEFAULT_GLOBAL_CONFIG)
  return migrateModelProfilesRemoveId(config)
}

export function normalizeApiKeyForConfig(apiKey: string): string {
  return apiKey?.slice(-20) ?? ''
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  // Filter out any values that match the defaults
  const filteredConfig = Object.fromEntries(
    Object.entries(config).filter(
      ([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(defaultConfig[key as keyof A]),
    ),
  )
  try {
    writeFileSync(file, JSON.stringify(filteredConfig, null, 2), 'utf-8')
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'EACCES' || err?.code === 'EPERM' || err?.code === 'EROFS') {
      debugLogger.state('CONFIG_SAVE_SKIPPED', {
        file,
        reason: String(err.code),
      })
      return
    }
    throw error
  }
}

// Flag to track if config reading is allowed
let configReadingAllowed = false

export function enableConfigs(): void {
  // Any reads to configuration before this flag is set show an console warning
  // to prevent us from adding config reading during module initialization
  configReadingAllowed = true
  // We only check the global config because currently all the configs share a file
  getConfig(
    GLOBAL_CLAUDE_FILE,
    DEFAULT_GLOBAL_CONFIG,
    true /* throw on invalid */,
  )
}

function getConfig<A>(
  file: string,
  defaultConfig: A,
  throwOnInvalid?: boolean,
): A {
  // 简化配置访问逻辑，移除复杂的时序检查

  debugLogger.state('CONFIG_LOAD_START', {
    file,
    fileExists: String(existsSync(file)),
    throwOnInvalid: String(!!throwOnInvalid),
  })

  if (!existsSync(file)) {
    debugLogger.state('CONFIG_LOAD_DEFAULT', {
      file,
      reason: 'file_not_exists',
      defaultConfigKeys: Object.keys(defaultConfig as object).join(', '),
    })
    return cloneDeep(defaultConfig)
  }

  try {
    const fileContent = readFileSync(file, 'utf-8')
    debugLogger.state('CONFIG_FILE_READ', {
      file,
      contentLength: String(fileContent.length),
      contentPreview:
        fileContent.substring(0, 100) + (fileContent.length > 100 ? '...' : ''),
    })

    try {
      const parsedConfig = JSON.parse(fileContent)
      debugLogger.state('CONFIG_JSON_PARSED', {
        file,
        parsedKeys: Object.keys(parsedConfig).join(', '),
      })

      // Handle backward compatibility - remove logic for deleted fields
      const finalConfig = {
        ...cloneDeep(defaultConfig),
        ...parsedConfig,
      }

      debugLogger.state('CONFIG_LOAD_SUCCESS', {
        file,
        finalConfigKeys: Object.keys(finalConfig as object).join(', '),
      })

      return finalConfig
    } catch (error) {
      // Throw a ConfigParseError with the file path and default config
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      debugLogger.error('CONFIG_JSON_PARSE_ERROR', {
        file,
        errorMessage,
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
        contentLength: String(fileContent.length),
      })

      throw new ConfigParseError(errorMessage, file, defaultConfig)
    }
  } catch (error: unknown) {
    // Re-throw ConfigParseError if throwOnInvalid is true
    if (error instanceof ConfigParseError && throwOnInvalid) {
      debugLogger.error('CONFIG_PARSE_ERROR_RETHROWN', {
        file,
        throwOnInvalid: String(throwOnInvalid),
        errorMessage: error.message,
      })
      throw error
    }

    debugLogger.warn('CONFIG_FALLBACK_TO_DEFAULT', {
      file,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      action: 'using_default_config',
    })

    return cloneDeep(defaultConfig)
  }
}

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = resolve(getCwd())
  const config = getConfig(GLOBAL_CLAUDE_FILE, DEFAULT_GLOBAL_CONFIG)

  if (!config.projects) {
    return defaultConfigForProject(absolutePath)
  }

  const projectConfig =
    config.projects[absolutePath] ?? defaultConfigForProject(absolutePath)
  // Not sure how this became a string
  // TODO: Fix upstream
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools =
      (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }
  return projectConfig
}

export function saveCurrentProjectConfig(projectConfig: ProjectConfig): void {
  if (process.env.NODE_ENV === 'test') {
    for (const key in projectConfig) {
      TEST_PROJECT_CONFIG_FOR_TESTING[key] = projectConfig[key]
    }
    return
  }
  const config = getConfig(GLOBAL_CLAUDE_FILE, DEFAULT_GLOBAL_CONFIG)
  saveConfig(
    GLOBAL_CLAUDE_FILE,
    {
      ...config,
      projects: {
        ...config.projects,
        [resolve(getCwd())]: projectConfig,
      },
    },
    DEFAULT_GLOBAL_CONFIG,
  )
}

export async function isAutoUpdaterDisabled(): Promise<boolean> {
  return getGlobalConfig().autoUpdaterStatus === 'disabled'
}

export const TEST_MCPRC_CONFIG_FOR_TESTING: Record<string, McpServerConfig> = {}

export function clearMcprcConfigForTesting(): void {
  if (process.env.NODE_ENV === 'test') {
    Object.keys(TEST_MCPRC_CONFIG_FOR_TESTING).forEach(key => {
      delete TEST_MCPRC_CONFIG_FOR_TESTING[key]
    })
  }
}

export function addMcprcServerForTesting(
  name: string,
  server: McpServerConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    TEST_MCPRC_CONFIG_FOR_TESTING[name] = server
  }
}

export function removeMcprcServerForTesting(name: string): void {
  if (process.env.NODE_ENV === 'test') {
    if (!TEST_MCPRC_CONFIG_FOR_TESTING[name]) {
      throw new Error(`No MCP server found with name: ${name} in .mcprc`)
    }
    delete TEST_MCPRC_CONFIG_FOR_TESTING[name]
  }
}

export const getMcprcConfig = memoize(
  (): Record<string, McpServerConfig> => {
    if (process.env.NODE_ENV === 'test') {
      return TEST_MCPRC_CONFIG_FOR_TESTING
    }

    const mcprcPath = join(getCwd(), '.mcprc')
    if (!existsSync(mcprcPath)) {
      return {}
    }

    try {
      const mcprcContent = readFileSync(mcprcPath, 'utf-8')
      const config = safeParseJSON(mcprcContent)
      if (config && typeof config === 'object') {
        // Logging removed
        return config as Record<string, McpServerConfig>
      }
    } catch {
      // Ignore errors reading/parsing .mcprc (they're logged in safeParseJSON)
    }
    return {}
  },
  // This function returns the same value as long as the cwd and mcprc file content remain the same
  () => {
    const cwd = getCwd()
    const mcprcPath = join(cwd, '.mcprc')
    if (existsSync(mcprcPath)) {
      try {
        const stat = readFileSync(mcprcPath, 'utf-8')
        return `${cwd}:${stat}`
      } catch {
        return cwd
      }
    }
    return cwd
  },
)

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig({ ...config, userID })
  return userID
}

export function getConfigForCLI(key: string, global: boolean): unknown {
  
  if (global) {
    if (!isGlobalConfigKey(key)) {
      console.error(
        `Error: '${key}' is not a valid config key. Valid keys are: ${GLOBAL_CONFIG_KEYS.join(', ')}`,
      )
      process.exit(1)
    }
    return getGlobalConfig()[key]
  } else {
    if (!isProjectConfigKey(key)) {
      console.error(
        `Error: '${key}' is not a valid config key. Valid keys are: ${PROJECT_CONFIG_KEYS.join(', ')}`,
      )
      process.exit(1)
    }
    return getCurrentProjectConfig()[key]
  }
}

export function setConfigForCLI(
  key: string,
  value: unknown,
  global: boolean,
): void {
  
  if (global) {
    if (!isGlobalConfigKey(key)) {
      console.error(
        `Error: Cannot set '${key}'. Only these keys can be modified: ${GLOBAL_CONFIG_KEYS.join(', ')}`,
      )
      process.exit(1)
    }

    if (key === 'autoUpdaterStatus' && !isAutoUpdaterStatus(value as string)) {
      console.error(
        `Error: Invalid value for autoUpdaterStatus. Must be one of: disabled, enabled, no_permissions, not_configured`,
      )
      process.exit(1)
    }

    const currentConfig = getGlobalConfig()
    saveGlobalConfig({
      ...currentConfig,
      [key]: value,
    })
  } else {
    if (!isProjectConfigKey(key)) {
      console.error(
        `Error: Cannot set '${key}'. Only these keys can be modified: ${PROJECT_CONFIG_KEYS.join(', ')}. Did you mean --global?`,
      )
      process.exit(1)
    }
    const currentConfig = getCurrentProjectConfig()
    saveCurrentProjectConfig({
      ...currentConfig,
      [key]: value,
    })
  }
  // Wait for the output to be flushed, to avoid clearing the screen.
  setTimeout(() => {
    // Without this we hang indefinitely.
    process.exit(0)
  }, 100)
}

export function deleteConfigForCLI(key: string, global: boolean): void {
  
  if (global) {
    if (!isGlobalConfigKey(key)) {
      console.error(
        `Error: Cannot delete '${key}'. Only these keys can be modified: ${GLOBAL_CONFIG_KEYS.join(', ')}`,
      )
      process.exit(1)
    }
    const currentConfig = getGlobalConfig()
    delete currentConfig[key]
    saveGlobalConfig(currentConfig)
  } else {
    if (!isProjectConfigKey(key)) {
      console.error(
        `Error: Cannot delete '${key}'. Only these keys can be modified: ${PROJECT_CONFIG_KEYS.join(', ')}. Did you mean --global?`,
      )
      process.exit(1)
    }
    const currentConfig = getCurrentProjectConfig()
    delete currentConfig[key]
    saveCurrentProjectConfig(currentConfig)
  }
}

export function listConfigForCLI(global: true): GlobalConfig
export function listConfigForCLI(global: false): ProjectConfig
export function listConfigForCLI(global: boolean): object {
  
  if (global) {
    const currentConfig = pick(getGlobalConfig(), GLOBAL_CONFIG_KEYS)
    return currentConfig
  } else {
    return pick(getCurrentProjectConfig(), PROJECT_CONFIG_KEYS)
  }
}

export function getOpenAIApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY
}

export function getAnthropicApiKey(): string {
  return process.env.ANTHROPIC_API_KEY || ''
}

// Configuration migration utility functions
function migrateModelProfilesRemoveId(config: GlobalConfig): GlobalConfig {
  if (!config.modelProfiles) return config

  // 1. Remove id field from ModelProfile objects and build ID to modelName mapping
  const idToModelNameMap = new Map<string, string>()
  const migratedProfiles = config.modelProfiles.map(profile => {
    // Build mapping before removing id field
    if ((profile as any).id && profile.modelName) {
      idToModelNameMap.set((profile as any).id, profile.modelName)
    }

    // Remove id field, keep everything else
    const { id, ...profileWithoutId } = profile as any
    return profileWithoutId as ModelProfile
  })

  // 2. Migrate ModelPointers from IDs to modelNames
  const migratedPointers: ModelPointers = {
    main: '',
    task: '',
    reasoning: '',
    quick: '',
  }

  if (config.modelPointers) {
    Object.entries(config.modelPointers).forEach(([pointer, value]) => {
      if (value) {
        // If value looks like an old ID (model_xxx), map it to modelName
        const modelName = idToModelNameMap.get(value) || value
        migratedPointers[pointer as ModelPointerType] = modelName
      }
    })
  }

  // 3. Migrate legacy config fields
  let defaultModelName: string | undefined
  if ((config as any).defaultModelId) {
    defaultModelName =
      idToModelNameMap.get((config as any).defaultModelId) ||
      (config as any).defaultModelId
  } else if ((config as any).defaultModelName) {
    defaultModelName = (config as any).defaultModelName
  }

  // 4. Remove legacy fields and return migrated config
  const migratedConfig = { ...config }
  delete (migratedConfig as any).defaultModelId
  delete (migratedConfig as any).currentSelectedModelId
  delete (migratedConfig as any).mainAgentModelId
  delete (migratedConfig as any).taskToolModelId

  return {
    ...migratedConfig,
    modelProfiles: migratedProfiles,
    modelPointers: migratedPointers,
    defaultModelName,
  }
}

// New model system utility functions

export function setAllPointersToModel(modelName: string): void {
  const config = getGlobalConfig()
  const updatedConfig = {
    ...config,
    modelPointers: {
      main: modelName,
      task: modelName,
      reasoning: modelName,
      quick: modelName,
    },
    defaultModelName: modelName,
  }
  saveGlobalConfig(updatedConfig)
}

export function setModelPointer(
  pointer: ModelPointerType,
  modelName: string,
): void {
  const config = getGlobalConfig()
  const updatedConfig = {
    ...config,
    modelPointers: {
      ...config.modelPointers,
      [pointer]: modelName,
    },
  }
  saveGlobalConfig(updatedConfig)

  // 🔧 Fix: Force ModelManager reload after config change
  // Import here to avoid circular dependency
  import('./model').then(({ reloadModelManager }) => {
    reloadModelManager()
  })
}

// 🔥 GPT-5 Configuration Validation and Auto-Repair Functions

/**
 * Check if a model name represents a GPT-5 model
 */
export function isGPT5ModelName(modelName: string): boolean {
  if (!modelName || typeof modelName !== 'string') return false
  const lowerName = modelName.toLowerCase()
  return lowerName.startsWith('gpt-5') || lowerName.includes('gpt-5')
}

/**
 * Validate and auto-repair GPT-5 model configuration
 */
export function validateAndRepairGPT5Profile(profile: ModelProfile): ModelProfile {
  const isGPT5 = isGPT5ModelName(profile.modelName)
  const now = Date.now()
  
  // Create a working copy
  const repairedProfile: ModelProfile = { ...profile }
  let wasRepaired = false
  
  // 🔧 Set GPT-5 detection flag
  if (isGPT5 !== profile.isGPT5) {
    repairedProfile.isGPT5 = isGPT5
    wasRepaired = true
  }
  
  if (isGPT5) {
    // 🔧 GPT-5 Parameter Validation and Repair
    
    // 1. Reasoning effort validation
    const validReasoningEfforts = ['minimal', 'low', 'medium', 'high']
    if (!profile.reasoningEffort || !validReasoningEfforts.includes(profile.reasoningEffort)) {
      repairedProfile.reasoningEffort = 'medium' // Default for coding tasks
      wasRepaired = true
      console.log(`🔧 GPT-5 Config: Set reasoning effort to 'medium' for ${profile.modelName}`)
    }
    
    // 2. Context length validation (GPT-5 models typically have 128k context)
    if (profile.contextLength < 128000) {
      repairedProfile.contextLength = 128000
      wasRepaired = true
      console.log(`🔧 GPT-5 Config: Updated context length to 128k for ${profile.modelName}`)
    }
    
    // 3. Output tokens validation (reasonable defaults for GPT-5)
    if (profile.maxTokens < 4000) {
      repairedProfile.maxTokens = 8192 // Good default for coding tasks
      wasRepaired = true
      console.log(`🔧 GPT-5 Config: Updated max tokens to 8192 for ${profile.modelName}`)
    }
    
    // 4. Provider validation
    if (profile.provider !== 'openai' && profile.provider !== 'custom-openai' && profile.provider !== 'azure') {
      console.warn(`⚠️  GPT-5 Config: Unexpected provider '${profile.provider}' for GPT-5 model ${profile.modelName}. Consider using 'openai' or 'custom-openai'.`)
    }
    
    // 5. Base URL validation for official models
    if (profile.modelName.includes('gpt-5') && !profile.baseURL) {
      repairedProfile.baseURL = 'https://api.openai.com/v1'
      wasRepaired = true
      console.log(`🔧 GPT-5 Config: Set default base URL for ${profile.modelName}`)
    }
  }
  
  // Update validation metadata
  repairedProfile.validationStatus = wasRepaired ? 'auto_repaired' : 'valid'
  repairedProfile.lastValidation = now
  
  if (wasRepaired) {
    console.log(`✅ GPT-5 Config: Auto-repaired configuration for ${profile.modelName}`)
  }
  
  return repairedProfile
}

/**
 * Validate and repair all GPT-5 profiles in the global configuration
 */
export function validateAndRepairAllGPT5Profiles(): { repaired: number; total: number } {
  const config = getGlobalConfig()
  if (!config.modelProfiles) {
    return { repaired: 0, total: 0 }
  }
  
  let repairCount = 0
  const repairedProfiles = config.modelProfiles.map(profile => {
    const repairedProfile = validateAndRepairGPT5Profile(profile)
    if (repairedProfile.validationStatus === 'auto_repaired') {
      repairCount++
    }
    return repairedProfile
  })
  
  // Save the repaired configuration
  if (repairCount > 0) {
    const updatedConfig = {
      ...config,
      modelProfiles: repairedProfiles,
    }
    saveGlobalConfig(updatedConfig)
    console.log(`🔧 GPT-5 Config: Auto-repaired ${repairCount} model profiles`)
  }
  
  return { repaired: repairCount, total: config.modelProfiles.length }
}

/**
 * Get GPT-5 configuration recommendations for a specific model
 */
export function getGPT5ConfigRecommendations(modelName: string): Partial<ModelProfile> {
  if (!isGPT5ModelName(modelName)) {
    return {}
  }
  
  const recommendations: Partial<ModelProfile> = {
    contextLength: 128000, // GPT-5 standard context length
    maxTokens: 8192, // Good default for coding tasks
    reasoningEffort: 'medium', // Balanced for most coding tasks
    isGPT5: true,
  }
  
  // Model-specific optimizations
  if (modelName.includes('gpt-5-mini')) {
    recommendations.maxTokens = 4096 // Smaller default for mini
    recommendations.reasoningEffort = 'low' // Faster for simple tasks
  } else if (modelName.includes('gpt-5-nano')) {
    recommendations.maxTokens = 2048 // Even smaller for nano
    recommendations.reasoningEffort = 'minimal' // Fastest option
  }
  
  return recommendations
}

/**
 * Create a properly configured GPT-5 model profile
 */
export function createGPT5ModelProfile(
  name: string,
  modelName: string,
  apiKey: string,
  baseURL?: string,
  provider: ProviderType = 'openai'
): ModelProfile {
  const recommendations = getGPT5ConfigRecommendations(modelName)
  
  const profile: ModelProfile = {
    name,
    provider,
    modelName,
    baseURL: baseURL || 'https://api.openai.com/v1',
    apiKey,
    maxTokens: recommendations.maxTokens || 8192,
    contextLength: recommendations.contextLength || 128000,
    reasoningEffort: recommendations.reasoningEffort || 'medium',
    isActive: true,
    createdAt: Date.now(),
    isGPT5: true,
    validationStatus: 'valid',
    lastValidation: Date.now(),
  }
  
  console.log(`✅ Created GPT-5 model profile: ${name} (${modelName})`)
  return profile
}
