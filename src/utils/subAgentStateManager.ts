/**
 * SubAgentStateManager
 * Manages state and results for sub-agents, enabling multi-agent collaboration
 * and result sharing across task executions.
 *
 * Based on AgentTool's ISubAgentStateManager pattern.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Valid color options for sub-agent visual representation
 * Matches AgentTool's VALID_SUB_AGENT_COLORS
 */
export const VALID_SUB_AGENT_COLORS = [
  'red',
  'blue',
  'green',
  'yellow',
  'orange',
  'purple',
  'pink',
  'cyan',
] as const

export type ValidSubAgentColor = (typeof VALID_SUB_AGENT_COLORS)[number]

/**
 * Result interface for sub-agent execution
 */
export interface SubAgentResult {
  /** Name/identifier of the sub-agent */
  name: string
  /** Agent type used for execution */
  agentType: string
  /** Final result message from the sub-agent */
  result: string
  /** Diff of changes made (if applicable) */
  diff?: string
  /** The request ID of the sub-agent's execution */
  requestId?: string
  /** Total number of tool calls made by the sub-agent */
  toolCallCount: number
  /** Total number of tool errors encountered */
  errorCount: number
  /** Execution start time */
  startedAt: number
  /** Execution end time */
  completedAt: number
  /** Duration in milliseconds */
  durationMs: number
  /** Model used for execution */
  model?: string
  /** Color configuration */
  color?: ValidSubAgentColor
  /** Status of the execution */
  status: 'running' | 'completed' | 'failed' | 'interrupted'
}

/**
 * Analytics event types for sub-agent tracking
 */
export enum SubAgentAnalyticsEvent {
  STARTED = 'sub_agent_started',
  COMPLETED = 'sub_agent_completed',
  FAILED = 'sub_agent_failed',
  INTERRUPTED = 'sub_agent_interrupted',
  TOOL_CALLED = 'sub_agent_tool_called',
}

/**
 * Analytics event data
 */
export interface SubAgentAnalyticsData {
  event: SubAgentAnalyticsEvent
  subAgentId: string
  subAgentName: string
  agentType: string
  model?: string
  color?: ValidSubAgentColor
  durationMs?: number
  toolCallCount?: number
  errorCount?: number
  errorMessage?: string
  timestamp: number
}

/**
 * Interface for sub-agent state management
 * Matches AgentTool's ISubAgentStateManager
 */
export interface ISubAgentStateManager {
  /** Get a sub-agent stored result by ID */
  getSubAgentStoredResult(subAgentId: string): SubAgentResult | undefined

  /** Set a sub-agent stored result by ID */
  setSubAgentStoredResult(subAgentId: string, result: SubAgentResult): void

  /** Get all sub-agent stored results */
  getAllSubAgentStoredResults(): Record<string, SubAgentResult>

  /** Clear all sub-agent stored results */
  clearSubAgentStoredResults(): void

  /** Remove a specific sub-agent stored result by ID */
  removeSubAgentStoredResult(subAgentId: string): void

  /** Find sub-agent ID by name */
  findSubAgentIdByName(name: string): string | undefined

  /** Get results for a specific agent type */
  getResultsByAgentType(agentType: string): SubAgentResult[]
}

/**
 * In-memory implementation of SubAgentStateManager
 * Suitable for single-session use
 */
export class InMemorySubAgentStateManager implements ISubAgentStateManager {
  private _store: Record<string, SubAgentResult> = {}
  private _analyticsCallbacks: ((data: SubAgentAnalyticsData) => void)[] = []

  getSubAgentStoredResult(subAgentId: string): SubAgentResult | undefined {
    return this._store[subAgentId]
  }

  setSubAgentStoredResult(subAgentId: string, result: SubAgentResult): void {
    this._store[subAgentId] = result
  }

  getAllSubAgentStoredResults(): Record<string, SubAgentResult> {
    return { ...this._store }
  }

  clearSubAgentStoredResults(): void {
    this._store = {}
  }

  removeSubAgentStoredResult(subAgentId: string): void {
    delete this._store[subAgentId]
  }

  findSubAgentIdByName(name: string): string | undefined {
    return Object.keys(this._store).find(
      (subAgentId) => this._store[subAgentId].name === name
    )
  }

  getResultsByAgentType(agentType: string): SubAgentResult[] {
    return Object.values(this._store).filter(
      (result) => result.agentType === agentType
    )
  }

  /** Register analytics callback */
  onAnalyticsEvent(callback: (data: SubAgentAnalyticsData) => void): void {
    this._analyticsCallbacks.push(callback)
  }

  /** Emit analytics event */
  emitAnalyticsEvent(data: SubAgentAnalyticsData): void {
    for (const callback of this._analyticsCallbacks) {
      try {
        callback(data)
      } catch (error) {
        console.error('Analytics callback error:', error)
      }
    }
  }
}

/**
 * File-based implementation of SubAgentStateManager
 * Persists state and analytics across sessions
 */
export class FileBasedSubAgentStateManager implements ISubAgentStateManager {
  private _memoryManager: InMemorySubAgentStateManager
  private _filePath: string
  private _analyticsPath: string
  private _analyticsEnabled: boolean

  constructor(sessionId: string = 'default', enableAnalytics: boolean = true) {
    this._memoryManager = new InMemorySubAgentStateManager()
    this._analyticsEnabled = enableAnalytics

    const configDir = process.env.KODE_CONFIG_DIR ?? join(homedir(), '.kode')
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true })
    }

    this._filePath = join(configDir, `${sessionId}-subagent-state.json`)
    this._analyticsPath = join(configDir, `${sessionId}-subagent-analytics.jsonl`)
    this._loadFromFile()

    // Register analytics persistence callback
    if (this._analyticsEnabled) {
      this._memoryManager.onAnalyticsEvent((data) => {
        this._appendAnalyticsEvent(data)
      })
    }
  }

  private _appendAnalyticsEvent(data: SubAgentAnalyticsData): void {
    try {
      const line = JSON.stringify(data) + '\n'
      const { appendFileSync } = require('fs')
      appendFileSync(this._analyticsPath, line, 'utf-8')
    } catch (error) {
      // Silently fail analytics persistence
    }
  }

  private _loadFromFile(): void {
    if (existsSync(this._filePath)) {
      try {
        const content = readFileSync(this._filePath, 'utf-8')
        const data = JSON.parse(content)
        for (const [id, result] of Object.entries(data)) {
          this._memoryManager.setSubAgentStoredResult(id, result as SubAgentResult)
        }
      } catch (error) {
        console.error('Failed to load sub-agent state:', error)
      }
    }
  }

  private _saveToFile(): void {
    try {
      const data = this._memoryManager.getAllSubAgentStoredResults()
      writeFileSync(this._filePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save sub-agent state:', error)
    }
  }

  getSubAgentStoredResult(subAgentId: string): SubAgentResult | undefined {
    return this._memoryManager.getSubAgentStoredResult(subAgentId)
  }

  setSubAgentStoredResult(subAgentId: string, result: SubAgentResult): void {
    this._memoryManager.setSubAgentStoredResult(subAgentId, result)
    this._saveToFile()
  }

  getAllSubAgentStoredResults(): Record<string, SubAgentResult> {
    return this._memoryManager.getAllSubAgentStoredResults()
  }

  clearSubAgentStoredResults(): void {
    this._memoryManager.clearSubAgentStoredResults()
    this._saveToFile()
  }

  removeSubAgentStoredResult(subAgentId: string): void {
    this._memoryManager.removeSubAgentStoredResult(subAgentId)
    this._saveToFile()
  }

  findSubAgentIdByName(name: string): string | undefined {
    return this._memoryManager.findSubAgentIdByName(name)
  }

  getResultsByAgentType(agentType: string): SubAgentResult[] {
    return this._memoryManager.getResultsByAgentType(agentType)
  }

  /** Forward analytics registration */
  onAnalyticsEvent(callback: (data: SubAgentAnalyticsData) => void): void {
    this._memoryManager.onAnalyticsEvent(callback)
  }

  /** Forward analytics emission */
  emitAnalyticsEvent(data: SubAgentAnalyticsData): void {
    this._memoryManager.emitAnalyticsEvent(data)
  }

  /** Get analytics history from file */
  getAnalyticsHistory(): SubAgentAnalyticsData[] {
    if (!existsSync(this._analyticsPath)) {
      return []
    }

    try {
      const content = readFileSync(this._analyticsPath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      return lines.map(line => JSON.parse(line) as SubAgentAnalyticsData)
    } catch (error) {
      return []
    }
  }

  /** Clear analytics history */
  clearAnalyticsHistory(): void {
    try {
      if (existsSync(this._analyticsPath)) {
        writeFileSync(this._analyticsPath, '', 'utf-8')
      }
    } catch (error) {
      // Silently fail
    }
  }

  /** Get analytics summary */
  getAnalyticsSummary(): {
    totalAgents: number
    completedCount: number
    failedCount: number
    interruptedCount: number
    totalToolCalls: number
    totalDurationMs: number
    agentsByType: Record<string, number>
  } {
    const history = this.getAnalyticsHistory()
    const completedEvents = history.filter(e => e.event === SubAgentAnalyticsEvent.COMPLETED)
    const failedEvents = history.filter(e => e.event === SubAgentAnalyticsEvent.FAILED)
    const interruptedEvents = history.filter(e => e.event === SubAgentAnalyticsEvent.INTERRUPTED)
    const toolCallEvents = history.filter(e => e.event === SubAgentAnalyticsEvent.TOOL_CALLED)

    const agentsByType: Record<string, number> = {}
    for (const event of [...completedEvents, ...failedEvents, ...interruptedEvents]) {
      agentsByType[event.agentType] = (agentsByType[event.agentType] || 0) + 1
    }

    return {
      totalAgents: completedEvents.length + failedEvents.length + interruptedEvents.length,
      completedCount: completedEvents.length,
      failedCount: failedEvents.length,
      interruptedCount: interruptedEvents.length,
      totalToolCalls: toolCallEvents.length,
      totalDurationMs: completedEvents.reduce((sum, e) => sum + (e.durationMs || 0), 0),
      agentsByType,
    }
  }
}

// Singleton instance for global state management
let _globalStateManager: InMemorySubAgentStateManager | null = null
let _fileBasedStateManager: FileBasedSubAgentStateManager | null = null

/**
 * Get the global sub-agent state manager instance (in-memory)
 */
export function getSubAgentStateManager(): InMemorySubAgentStateManager {
  if (!_globalStateManager) {
    _globalStateManager = new InMemorySubAgentStateManager()
  }
  return _globalStateManager
}

/**
 * Get a file-based state manager with persistent analytics
 * Use this when you need state and analytics to persist across sessions
 */
export function getFileBasedStateManager(
  sessionId: string = 'default',
  enableAnalytics: boolean = true
): FileBasedSubAgentStateManager {
  if (!_fileBasedStateManager) {
    _fileBasedStateManager = new FileBasedSubAgentStateManager(sessionId, enableAnalytics)
  }
  return _fileBasedStateManager
}

/**
 * Reset the global state manager (useful for testing)
 */
export function resetSubAgentStateManager(): void {
  _globalStateManager = null
  _fileBasedStateManager = null
}

/**
 * Helper function to track sub-agent analytics
 */
export function trackSubAgentEvent(
  event: SubAgentAnalyticsEvent,
  subAgentId: string,
  subAgentName: string,
  agentType: string,
  additionalData?: Partial<SubAgentAnalyticsData>
): void {
  const manager = getSubAgentStateManager()
  manager.emitAnalyticsEvent({
    event,
    subAgentId,
    subAgentName,
    agentType,
    timestamp: Date.now(),
    ...additionalData,
  })
}

/**
 * Validate color value
 */
export function isValidSubAgentColor(color: string): color is ValidSubAgentColor {
  return VALID_SUB_AGENT_COLORS.includes(color as ValidSubAgentColor)
}
