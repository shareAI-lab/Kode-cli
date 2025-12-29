/**
 * Memory System - Integrated from AgentTool
 * Provides snapshot management, pending memories store, and update notifications
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join, dirname } from 'path'
import throttle from 'lodash-es/throttle'
import { MEMORY_DIR } from '@utils/env'
import { debug } from '@utils/debugLogger'

// Helper for logging
const log = (msg: string) => debug.trace('memory', msg)

// ============================================================================
// Types
// ============================================================================

export interface MemoryEntry {
  id: string
  content: string
  version?: number
}

export interface PendingMemoryEntry extends MemoryEntry {
  requestId?: string
  timestamp: number
  scope?: string
}

export interface PendingMemoriesState {
  memories: PendingMemoryEntry[]
  lastProcessedTimestamp: number
}

export type MemoryState = 'pending' | 'accepted' | 'rejected'

export interface MemoryInfoWithState extends MemoryEntry {
  state: MemoryState
  blobName?: string
  timestamp?: number
  requestId?: string
}

// ============================================================================
// Memory Snapshot Manager
// ============================================================================

/**
 * MemorySnapshotManager manages in-memory snapshots of agent memories.
 * It creates a snapshot when a user sends a message and maintains
 * that snapshot until 5 minutes of inactivity or conversation switch.
 */
export class MemorySnapshotManager {
  private _currentSnapshot: string | undefined
  private _currentConversationId: string | undefined
  private _lastActivityTime: number = 0
  private _inactivityThresholdMs = 5 * 60 * 1000 // 5 minutes
  private _disposed = false

  constructor(private _getMemoriesContent: () => Promise<string | undefined>) {
    log('MemorySnapshotManager initialized')
  }

  /**
   * Get the current memory snapshot or create one if needed.
   */
  public async getMemorySnapshot(conversationId: string): Promise<string | undefined> {
    if (this._disposed) return undefined

    const now = Date.now()

    if (this._shouldUpdateSnapshot(conversationId, now)) {
      await this._updateSnapshot(conversationId)
    }

    this._lastActivityTime = now
    return this._currentSnapshot
  }

  /**
   * Force an update of the memory snapshot.
   */
  public async forceUpdateSnapshot(): Promise<void> {
    if (this._disposed) return
    await this._updateSnapshot(this._currentConversationId)
  }

  private _shouldUpdateSnapshot(conversationId: string, now: number): boolean {
    if (!this._currentSnapshot) return true
    if (conversationId !== this._currentConversationId) return true
    if (now - this._lastActivityTime > this._inactivityThresholdMs) return true
    return false
  }

  private async _updateSnapshot(conversationId?: string): Promise<void> {
    try {
      const content = await this._getMemoriesContent()
      this._currentSnapshot = content
      this._currentConversationId = conversationId
      log(`Snapshot updated for conversation: ${conversationId}`)
    } catch (error) {
      log( `Failed to update snapshot: ${error}`)
      this._currentSnapshot = undefined
    }
  }

  public dispose(): void {
    this._disposed = true
    this._currentSnapshot = undefined
    this._currentConversationId = undefined
  }
}

// ============================================================================
// Pending Memories Store
// ============================================================================

/**
 * PendingMemoriesStore manages pending memories in a JSON state file.
 */
export class PendingMemoriesStore {
  private _state: PendingMemoriesState
  private _writeLock = Promise.resolve()
  private readonly _pendingPath: string

  constructor(agentId: string) {
    this._pendingPath = join(MEMORY_DIR, 'agents', agentId, 'pending-memories.json')
    this._state = {
      memories: [],
      lastProcessedTimestamp: 0,
    }

    // Load existing state
    void this._loadState()
    log( `PendingMemoriesStore initialized: ${this._pendingPath}`)
  }

  private async _loadState(): Promise<void> {
    try {
      if (existsSync(this._pendingPath)) {
        const content = readFileSync(this._pendingPath, 'utf-8')
        this._state = JSON.parse(content) as PendingMemoriesState
        log( `Loaded ${this._state.memories.length} pending memories`)
      }
    } catch (error) {
      log( `Failed to load pending memories: ${error}`)
    }
  }

  private async _saveState(): Promise<void> {
    try {
      const dir = dirname(this._pendingPath)
      mkdirSync(dir, { recursive: true })
      writeFileSync(this._pendingPath, JSON.stringify(this._state, null, 2), 'utf-8')
    } catch (error) {
      log( `Failed to save pending memories: ${error}`)
    }
  }

  /**
   * Append a memory entry to the pending store
   */
  async append(memory: MemoryEntry, requestId?: string, timestamp?: number): Promise<void> {
    const pendingEntry: PendingMemoryEntry = {
      ...memory,
      requestId,
      timestamp: timestamp || Date.now(),
    }

    this._writeLock = this._writeLock.then(async () => {
      this._state.memories.push(pendingEntry)
      this._state.lastProcessedTimestamp = pendingEntry.timestamp
      await this._saveState()
      log( `Appended memory ${memory.id} to pending store`)
    })

    await this._writeLock
  }

  /**
   * List all pending memory entries sorted by timestamp (newest first)
   */
  listPending(): PendingMemoryEntry[] {
    return [...this._state.memories].sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * Remove pending memories matching the predicate
   */
  async removePending(predicate: (entry: PendingMemoryEntry) => boolean): Promise<number> {
    let removedCount = 0

    this._writeLock = this._writeLock.then(async () => {
      const originalLength = this._state.memories.length
      this._state.memories = this._state.memories.filter(entry => !predicate(entry))
      removedCount = originalLength - this._state.memories.length
      await this._saveState()
      log( `Removed ${removedCount} pending memories`)
    })

    await this._writeLock
    return removedCount
  }

  /**
   * Clear all pending memories
   */
  async clearAll(): Promise<void> {
    this._writeLock = this._writeLock.then(async () => {
      this._state.memories = []
      this._state.lastProcessedTimestamp = 0
      await this._saveState()
      log( 'Cleared all pending memories')
    })

    await this._writeLock
  }

  /**
   * Get count of pending memories
   */
  get pendingCount(): number {
    return this._state.memories.length
  }
}

// ============================================================================
// Memory Update Manager
// ============================================================================

/**
 * MemoryUpdateManager provides a way to notify listeners when agent memories are updated.
 */
export class MemoryUpdateManager {
  private static THROTTLE_DELAY_MS = 500
  private _callbacks = new Set<() => void>()
  private _throttledNotify: () => void
  private _disposed = false

  constructor() {
    this._throttledNotify = throttle(
      () => this._notifyImmediate(),
      MemoryUpdateManager.THROTTLE_DELAY_MS,
      { trailing: true }
    )
  }

  /**
   * Register a callback to be called when memories are updated.
   */
  public onMemoryHasUpdates(cb: () => void): { dispose: () => void } {
    this._callbacks.add(cb)
    return {
      dispose: () => {
        this._callbacks.delete(cb)
      },
    }
  }

  /**
   * Notify all registered callbacks (throttled)
   */
  public notifyMemoryHasUpdates(): void {
    if (this._disposed) return
    this._throttledNotify()
  }

  private _notifyImmediate(): void {
    this._callbacks.forEach(cb => cb())
  }

  public dispose(): void {
    this._disposed = true
    this._callbacks.clear()
  }
}

// ============================================================================
// Memory System Singleton
// ============================================================================

let _snapshotManager: MemorySnapshotManager | null = null
let _updateManager: MemoryUpdateManager | null = null
const _pendingStores = new Map<string, PendingMemoriesStore>()

/**
 * Get or create a MemorySnapshotManager
 */
export function getMemorySnapshotManager(
  getMemoriesContent: () => Promise<string | undefined>
): MemorySnapshotManager {
  if (!_snapshotManager) {
    _snapshotManager = new MemorySnapshotManager(getMemoriesContent)
  }
  return _snapshotManager
}

/**
 * Get or create a MemoryUpdateManager
 */
export function getMemoryUpdateManager(): MemoryUpdateManager {
  if (!_updateManager) {
    _updateManager = new MemoryUpdateManager()
  }
  return _updateManager
}

/**
 * Get or create a PendingMemoriesStore for an agent
 */
export function getPendingMemoriesStore(agentId: string): PendingMemoriesStore {
  if (!_pendingStores.has(agentId)) {
    _pendingStores.set(agentId, new PendingMemoriesStore(agentId))
  }
  return _pendingStores.get(agentId)!
}

/**
 * Dispose all memory system resources
 */
export function disposeMemorySystem(): void {
  _snapshotManager?.dispose()
  _snapshotManager = null
  _updateManager?.dispose()
  _updateManager = null
  _pendingStores.clear()
}
