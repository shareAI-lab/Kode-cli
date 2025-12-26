/**
 * CommandTimeoutPredictor - Smart timeout prediction based on command history
 *
 * Migrated from AgentTool/04-ShellTools/command-timeout-predictor.ts
 *
 * Features:
 * - Learn from command execution history
 * - Predict optimal timeouts based on past executions
 * - Auto-adjust timeouts for commands that previously timed out
 * - LRU cache for efficient memory usage
 */

import * as fs from 'fs/promises'
import * as path from 'path'

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a single command execution record
 */
export interface CommandExecutionRecord {
  /** Original command as executed */
  originalCommand: string
  /** Execution time in seconds (null if timed out) */
  executionTimeSeconds: number | null
  /** Timeout value that was used */
  timeoutUsed: number
  /** Timestamp when the command was executed */
  timestamp: number
}

/**
 * Aggregated statistics for a command
 */
export interface CommandStats {
  /** Number of successful executions */
  successCount: number
  /** Number of timeouts */
  timeoutCount: number
  /** Average execution time for successful runs (seconds) */
  avgExecutionTime: number
  /** Maximum execution time observed (seconds) */
  maxExecutionTime: number
  /** Last timeout value that failed */
  lastTimeoutThatFailed?: number
  /** Last successful execution time */
  lastSuccessfulTime?: number
  /** Timestamp of last execution */
  lastExecuted: number
}

/**
 * Storage structure for command execution history
 */
interface CommandExecutionHistory {
  /** Individual execution records (limited to recent entries) */
  records: CommandExecutionRecord[]
  /** Aggregated statistics by exact command */
  commandStats: Record<string, CommandStats>
  /** Version for future migration compatibility */
  version: number
}

// ============================================================================
// Simple LRU Cache
// ============================================================================

class LRUCache<K, V> {
  private _cache = new Map<K, V>()
  private _maxSize: number

  constructor(maxSize: number) {
    this._maxSize = maxSize
  }

  get(key: K): V | undefined {
    const value = this._cache.get(key)
    if (value !== undefined) {
      // Move to end (most recently used)
      this._cache.delete(key)
      this._cache.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    // Delete first to update position
    this._cache.delete(key)
    this._cache.set(key, value)

    // Evict oldest entries if over capacity
    while (this._cache.size > this._maxSize) {
      const firstKey = this._cache.keys().next().value
      if (firstKey !== undefined) {
        this._cache.delete(firstKey)
      }
    }
  }

  values(): IterableIterator<V> {
    return this._cache.values()
  }

  entries(): IterableIterator<[K, V]> {
    return this._cache.entries()
  }

  clear(): void {
    this._cache.clear()
  }
}

// ============================================================================
// Storage Interface
// ============================================================================

export interface TimeoutPredictorStorage {
  load(): Promise<Uint8Array | null>
  save(data: Uint8Array): Promise<void>
}

/**
 * File-based storage for timeout predictor
 */
export class FileTimeoutPredictorStorage implements TimeoutPredictorStorage {
  constructor(private _filePath: string) {}

  async load(): Promise<Uint8Array | null> {
    try {
      const data = await fs.readFile(this._filePath)
      return new Uint8Array(data)
    } catch {
      return null
    }
  }

  async save(data: Uint8Array): Promise<void> {
    const dir = path.dirname(this._filePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(this._filePath, data)
  }
}

/**
 * In-memory storage for testing
 */
export class InMemoryTimeoutPredictorStorage implements TimeoutPredictorStorage {
  private _data: Uint8Array | null = null

  async load(): Promise<Uint8Array | null> {
    return this._data
  }

  async save(data: Uint8Array): Promise<void> {
    this._data = data
  }
}

// ============================================================================
// CommandTimeoutPredictor
// ============================================================================

/**
 * Smart timeout predictor that learns from command execution history
 *
 * Features:
 * - Predicts optimal timeouts based on past executions
 * - Auto-increases timeout for commands that previously timed out
 * - Uses LRU cache for efficient memory usage
 * - Persists history to storage
 */
export class CommandTimeoutPredictor {
  private readonly _maxRecords = 1000 // Keep last 1000 command records
  private readonly _maxCommands = 500 // Keep stats for up to 500 unique commands
  private readonly _currentVersion = 2

  private readonly _recordsCache: LRUCache<string, CommandExecutionRecord>
  private readonly _commandStatsCache: LRUCache<string, CommandStats>

  private _isHistoryLoaded = false
  private _loadingPromise: Promise<void> | null = null
  private _storage: TimeoutPredictorStorage | null

  constructor(storage?: TimeoutPredictorStorage) {
    this._storage = storage ?? null
    this._recordsCache = new LRUCache<string, CommandExecutionRecord>(this._maxRecords)
    this._commandStatsCache = new LRUCache<string, CommandStats>(this._maxCommands)

    // Start loading immediately if storage is available
    if (this._storage) {
      this._loadingPromise = this._loadHistoryFromStorage()
    }
  }

  /**
   * Predict timeout for a command based on historical data
   * Returns null if no historical data is available
   */
  async predictTimeout(command: string): Promise<number | null> {
    try {
      await this._ensureHistoryLoaded()

      // Check if we have statistics for this exact command
      const stats = this._commandStatsCache.get(command)
      if (stats) {
        return this._calculateTimeoutFromStats(stats)
      }

      // No historical data available
      return null
    } catch {
      // If there's an error loading history, no prediction available
      return null
    }
  }

  /**
   * Get the optimal timeout for a command, choosing between predicted and requested timeout
   * Returns the larger of the two values, or the requested timeout if no prediction is available
   */
  async getOptimalTimeout(command: string, requestedTimeout: number): Promise<number> {
    const predictedTimeout = await this.predictTimeout(command)

    if (predictedTimeout !== null) {
      return Math.max(requestedTimeout, predictedTimeout)
    }

    return requestedTimeout
  }

  /**
   * Record the execution of a command and its outcome
   */
  async recordExecution(
    command: string,
    executionTimeSeconds: number | null,
    timeoutUsed: number
  ): Promise<void> {
    try {
      await this._ensureHistoryLoaded()
      const timestamp = Date.now()

      // Add new record
      const record: CommandExecutionRecord = {
        originalCommand: command,
        executionTimeSeconds,
        timeoutUsed,
        timestamp,
      }

      const recordKey = `${command}-${timestamp}`
      this._recordsCache.set(recordKey, record)

      // Update command statistics
      this._updateCommandStats(command, record)

      // Save updated history
      await this._saveHistory()
    } catch {
      // Silently fail - don't break execution flow
    }
  }

  /**
   * Calculate timeout based on historical statistics
   */
  private _calculateTimeoutFromStats(stats: CommandStats): number | null {
    // If we have successful executions, use actual measured performance
    if (stats.successCount > 0) {
      // Add 20% buffer or at least 10 seconds
      const bufferTime = Math.max(stats.maxExecutionTime * 1.2, stats.maxExecutionTime + 10)
      return Math.ceil(bufferTime)
    }

    // If we only have timeout history (no successful runs), double the last failed timeout
    if (stats.timeoutCount > 0 && stats.lastTimeoutThatFailed) {
      return Math.ceil(stats.lastTimeoutThatFailed * 2)
    }

    // No historical data to base prediction on
    return null
  }

  /**
   * Update command statistics with new execution record
   */
  private _updateCommandStats(command: string, record: CommandExecutionRecord): void {
    let stats = this._commandStatsCache.get(command)

    if (!stats) {
      stats = {
        successCount: 0,
        timeoutCount: 0,
        avgExecutionTime: 0,
        maxExecutionTime: 0,
        lastExecuted: record.timestamp,
      }
    }

    // Update counts and timing
    if (record.executionTimeSeconds === null) {
      stats.timeoutCount++
      stats.lastTimeoutThatFailed = Math.max(stats.lastTimeoutThatFailed || 0, record.timeoutUsed)
    } else {
      stats.successCount++
      stats.lastSuccessfulTime = record.executionTimeSeconds

      // Update average execution time
      const totalTime =
        stats.avgExecutionTime * (stats.successCount - 1) + record.executionTimeSeconds
      stats.avgExecutionTime = totalTime / stats.successCount

      // Update max execution time
      stats.maxExecutionTime = Math.max(stats.maxExecutionTime, record.executionTimeSeconds)
    }

    stats.lastExecuted = record.timestamp
    this._commandStatsCache.set(command, stats)
  }

  /**
   * Load command execution history from storage
   */
  private async _loadHistoryFromStorage(): Promise<void> {
    if (!this._storage) {
      this._isHistoryLoaded = true
      return
    }

    try {
      const storedBytes = await this._storage.load()

      if (storedBytes) {
        const storedText = new TextDecoder().decode(storedBytes)
        const stored = JSON.parse(storedText) as CommandExecutionHistory

        if (stored && stored.version === this._currentVersion) {
          // Load records into cache
          stored.records.forEach((record: CommandExecutionRecord) => {
            const recordKey = `${record.originalCommand}-${record.timestamp}`
            this._recordsCache.set(recordKey, record)
          })

          // Load command stats into cache
          Object.entries(stored.commandStats || {}).forEach(([command, stats]) => {
            this._commandStatsCache.set(command, stats)
          })
        }
      }

      this._isHistoryLoaded = true
    } catch {
      // Mark as loaded even on error to avoid repeated attempts
      this._isHistoryLoaded = true
    }
  }

  /**
   * Ensure command execution history is loaded from storage
   */
  private async _ensureHistoryLoaded(): Promise<void> {
    if (this._isHistoryLoaded) {
      return
    }

    if (this._loadingPromise) {
      await this._loadingPromise
    }
  }

  /**
   * Save command execution history to storage
   */
  private async _saveHistory(): Promise<void> {
    if (!this._storage) {
      return
    }

    const history: CommandExecutionHistory = {
      records: Array.from(this._recordsCache.values()),
      commandStats: Object.fromEntries(this._commandStatsCache.entries()),
      version: this._currentVersion,
    }
    const historyText = JSON.stringify(history)
    const historyBytes = new TextEncoder().encode(historyText)
    await this._storage.save(historyBytes)
  }

  /**
   * Clear all history
   */
  clear(): void {
    this._recordsCache.clear()
    this._commandStatsCache.clear()
  }

  /**
   * Get statistics for a specific command
   */
  getCommandStats(command: string): CommandStats | undefined {
    return this._commandStatsCache.get(command)
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let _timeoutPredictor: CommandTimeoutPredictor | undefined

export function getTimeoutPredictor(storage?: TimeoutPredictorStorage): CommandTimeoutPredictor {
  if (!_timeoutPredictor) {
    _timeoutPredictor = new CommandTimeoutPredictor(storage)
  }
  return _timeoutPredictor
}
