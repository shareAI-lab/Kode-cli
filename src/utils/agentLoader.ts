/**
 * Agent configuration loader
 * Loads agent configurations from markdown files with YAML frontmatter.
 * Maintains compatibility with Claude Code `.claude` agent directories while
 * prioritizing Kode-specific overrides.
 */

import { existsSync, readFileSync, readdirSync, statSync, watch, FSWatcher } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import matter from 'gray-matter'
import { getCwd } from './state'
import { memoize } from 'lodash-es'

// Track warned agents to avoid spam
const warnedAgents = new Set<string>()

export interface AgentConfig {
  agentType: string          // Agent identifier (matches subagent_type)
  whenToUse: string          // Description of when to use this agent
  tools: string[] | '*'      // Tool permissions
  systemPrompt: string       // System prompt content
  location: 'built-in' | 'user' | 'project'
  color?: string            // Optional UI color
  model_name?: string       // Optional model override
  temperature?: number      // Optional temperature override (0.0-1.0)
}

// Built-in general-purpose agent as fallback
const BUILTIN_GENERAL_PURPOSE: AgentConfig = {
  agentType: 'general-purpose',
  whenToUse: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks',
  tools: '*',
  systemPrompt: `You are a general-purpose agent. Given the user's task, use the tools available to complete it efficiently and thoroughly.

When to use your capabilities:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture  
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: Use Grep or Glob when you need to search broadly. Use FileRead when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- Complete tasks directly using your capabilities.`,
  location: 'built-in'
}

/**
 * Parse tools field from frontmatter
 */
function parseTools(tools: any): string[] | '*' {
  if (!tools) return '*'
  if (tools === '*') return '*'
  if (Array.isArray(tools)) {
    // Ensure all items are strings and filter out non-strings
    const filteredTools = tools.filter((t): t is string => typeof t === 'string')
    return filteredTools.length > 0 ? filteredTools : '*'
  }
  if (typeof tools === 'string') {
    return [tools]
  }
  return '*'
}

/**
 * Scan a directory for agent configuration files
 */
async function scanAgentDirectory(dirPath: string, location: 'user' | 'project'): Promise<AgentConfig[]> {
  if (!existsSync(dirPath)) {
    return []
  }

  const agents: AgentConfig[] = []
  
  try {
    const files = readdirSync(dirPath)
    
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      
      const filePath = join(dirPath, file)
      const stat = statSync(filePath)
      
      if (!stat.isFile()) continue
      
      try {
        const content = readFileSync(filePath, 'utf-8')
        const { data: frontmatter, content: body } = matter(content)
        
        // Validate required fields
        if (!frontmatter.name || !frontmatter.description) {
          console.warn(`Skipping ${filePath}: missing required fields (name, description)`)
          continue
        }
        
        // Silently ignore deprecated 'model' field - no warnings by default
        // Only warn if KODE_DEBUG_AGENTS environment variable is set
        if (frontmatter.model && !frontmatter.model_name && !warnedAgents.has(frontmatter.name) && process.env.KODE_DEBUG_AGENTS) {
          console.warn(`⚠️ Agent ${frontmatter.name}: 'model' field is deprecated and ignored. Use 'model_name' instead, or omit to use default 'task' model.`)
          warnedAgents.add(frontmatter.name)
        }
        
        // Parse and validate temperature
        let temperature: number | undefined
        if (frontmatter.temperature !== undefined) {
          const temp = parseFloat(frontmatter.temperature)
          if (!isNaN(temp) && temp >= 0.0 && temp <= 1.0) {
            temperature = temp
          } else if (process.env.KODE_DEBUG_AGENTS) {
            console.warn(`⚠️ Agent ${frontmatter.name}: Invalid temperature '${frontmatter.temperature}'. Must be 0.0-1.0.`)
          }
        }

        // Build agent config
        const agent: AgentConfig = {
          agentType: frontmatter.name,
          whenToUse: frontmatter.description.replace(/\\n/g, '\n'),
          tools: parseTools(frontmatter.tools),
          systemPrompt: body.trim(),
          location,
          ...(frontmatter.color && { color: frontmatter.color }),
          // Only use model_name field, ignore deprecated 'model' field
          ...(frontmatter.model_name && { model_name: frontmatter.model_name }),
          ...(temperature !== undefined && { temperature })
        }
        
        agents.push(agent)
      } catch (error) {
        console.warn(`Failed to parse agent file ${filePath}:`, error)
      }
    }
  } catch (error) {
    console.warn(`Failed to scan directory ${dirPath}:`, error)
  }
  
  return agents
}

/**
 * Load all agent configurations
 */
async function loadAllAgents(): Promise<{
  activeAgents: AgentConfig[]
  allAgents: AgentConfig[]
}> {
  try {
    // Scan both .claude and .kode directories in parallel
    // Claude Code compatibility: support both ~/.claude/agents and ~/.kode/agents
    const userClaudeDir = join(homedir(), '.claude', 'agents')
    const userKodeDir = join(homedir(), '.kode', 'agents')
    const projectClaudeDir = join(getCwd(), '.claude', 'agents')
    const projectKodeDir = join(getCwd(), '.kode', 'agents')
    
    const [userClaudeAgents, userKodeAgents, projectClaudeAgents, projectKodeAgents] = await Promise.all([
      scanAgentDirectory(userClaudeDir, 'user'),
      scanAgentDirectory(userKodeDir, 'user'),
      scanAgentDirectory(projectClaudeDir, 'project'),
      scanAgentDirectory(projectKodeDir, 'project')
    ])
    
    // Built-in agents (currently just general-purpose)
    const builtinAgents = [BUILTIN_GENERAL_PURPOSE]
    
    // Apply priority override: built-in < .claude (user) < .kode (user) < .claude (project) < .kode (project)
    const agentMap = new Map<string, AgentConfig>()
    
    // Add in priority order (later entries override earlier ones)
    for (const agent of builtinAgents) {
      agentMap.set(agent.agentType, agent)
    }
    for (const agent of userClaudeAgents) {
      agentMap.set(agent.agentType, agent)
    }
    for (const agent of userKodeAgents) {
      agentMap.set(agent.agentType, agent)
    }
    for (const agent of projectClaudeAgents) {
      agentMap.set(agent.agentType, agent)
    }
    for (const agent of projectKodeAgents) {
      agentMap.set(agent.agentType, agent)
    }
    
    const activeAgents = Array.from(agentMap.values())
    const allAgents = [...builtinAgents, ...userClaudeAgents, ...userKodeAgents, ...projectClaudeAgents, ...projectKodeAgents]
    
    return { activeAgents, allAgents }
  } catch (error) {
    console.error('Failed to load agents, falling back to built-in:', error)
    return {
      activeAgents: [BUILTIN_GENERAL_PURPOSE],
      allAgents: [BUILTIN_GENERAL_PURPOSE]
    }
  }
}

// Memoized version for performance
export const getActiveAgents = memoize(
  async (): Promise<AgentConfig[]> => {
    const { activeAgents } = await loadAllAgents()
    return activeAgents
  }
)

// Get all agents (both active and overridden)
export const getAllAgents = memoize(
  async (): Promise<AgentConfig[]> => {
    const { allAgents } = await loadAllAgents()
    return allAgents
  }
)

// Clear cache when needed
export function clearAgentCache() {
  getActiveAgents.cache?.clear?.()
  getAllAgents.cache?.clear?.()
  getAgentByType.cache?.clear?.()
  getAvailableAgentTypes.cache?.clear?.()
}

// Get a specific agent by type
export const getAgentByType = memoize(
  async (agentType: string): Promise<AgentConfig | undefined> => {
    const agents = await getActiveAgents()
    return agents.find(agent => agent.agentType === agentType)
  }
)

// Get all available agent types for validation
export const getAvailableAgentTypes = memoize(
  async (): Promise<string[]> => {
    const agents = await getActiveAgents()
    return agents.map(agent => agent.agentType)
  }
)

// File watcher for hot reload
let watchers: FSWatcher[] = []

/**
 * Start watching agent configuration directories for changes
 */
export async function startAgentWatcher(onChange?: () => void): Promise<void> {
  await stopAgentWatcher() // Clean up any existing watchers
  
  // Watch both Claude (.claude) and native (.kode) directories
  const userClaudeDir = join(homedir(), '.claude', 'agents')
  const userKodeDir = join(homedir(), '.kode', 'agents')
  const projectClaudeDir = join(getCwd(), '.claude', 'agents')
  const projectKodeDir = join(getCwd(), '.kode', 'agents')
  
  const watchDirectory = (dirPath: string, label: string) => {
    if (existsSync(dirPath)) {
      const watcher = watch(dirPath, { recursive: false }, async (eventType, filename) => {
        if (filename && filename.endsWith('.md')) {
          console.log(`🔄 Agent configuration changed in ${label}: ${filename}`)
          clearAgentCache()
          // Also clear any other related caches
          getAllAgents.cache?.clear?.()
          onChange?.()
        }
      })
      watchers.push(watcher)
    }
  }
  
  // Watch all directories
  watchDirectory(userClaudeDir, 'user/.claude')
  watchDirectory(userKodeDir, 'user/.kode')
  watchDirectory(projectClaudeDir, 'project/.claude')
  watchDirectory(projectKodeDir, 'project/.kode')
}

/**
 * Stop watching agent configuration directories
 */
export async function stopAgentWatcher(): Promise<void> {
  // FSWatcher.close() is synchronous and does not accept a callback on Node 18/20
  try {
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch (err) {
        console.error('Failed to close file watcher:', err)
      }
    }
  } finally {
    watchers = []
  }
}
