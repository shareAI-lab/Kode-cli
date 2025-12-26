/**
 * CheckpointManager - File state tracking with undo/redo support
 *
 * Migrated from AgentTool/12-CheckpointManagement
 *
 * Features:
 * - Track file states at specific timestamps
 * - Revert to any previous state
 * - Separate tracking for user vs agent edits
 * - Shard-based storage for scalability
 */

import * as crypto from 'crypto'

// ============================================================================
// Types
// ============================================================================

export interface QualifiedPathName {
  rootPath: string
  relPath: string
  readonly absPath: string
}

export function createQualifiedPathName(rootPath: string, relPath: string): QualifiedPathName {
  return {
    rootPath,
    relPath,
    get absPath() {
      return `${this.rootPath}/${this.relPath}`
    },
  }
}

export enum EditEventSource {
  UNSPECIFIED = 'unspecified',
  USER_EDIT = 'user_edit',
  AGENT_EDIT = 'agent_edit',
  CHECKPOINT_REVERT = 'checkpoint_revert',
}

export interface DiffViewDocument {
  filePath: QualifiedPathName
  originalCode: string | undefined
  modifiedCode: string | undefined
}

export function createDiffViewDocument(
  filePath: QualifiedPathName,
  originalCode: string | undefined,
  modifiedCode: string | undefined
): DiffViewDocument {
  return { filePath, originalCode, modifiedCode }
}

export interface HydratedCheckpoint {
  sourceToolCallRequestId: string
  timestamp: number
  document: DiffViewDocument
  conversationId: string
  editSource?: EditEventSource
  lastIncludedInRequestId?: string
  isDirty?: boolean
}

export interface FileChangeSummary {
  totalAddedLines: number
  totalRemovedLines: number
}

export interface AggregateCheckpointInfo {
  fromTimestamp: number
  toTimestamp: number
  conversationId: string
  files: Array<{
    changesSummary: FileChangeSummary
    changeDocument: DiffViewDocument
  }>
}

export interface CheckpointKey {
  conversationId: string
  path: QualifiedPathName
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a unique request ID
 */
export function createRequestId(): string {
  return crypto.randomUUID()
}

/**
 * Compute change summary for a document
 */
export function computeChangesSummary(doc: DiffViewDocument): FileChangeSummary {
  const originalLines = (doc.originalCode ?? '').split('\n')
  const modifiedLines = (doc.modifiedCode ?? '').split('\n')

  // Simple line diff calculation
  const originalSet = new Set(originalLines)
  const modifiedSet = new Set(modifiedLines)

  let addedLines = 0
  let removedLines = 0

  for (const line of modifiedLines) {
    if (!originalSet.has(line)) {
      addedLines++
    }
  }

  for (const line of originalLines) {
    if (!modifiedSet.has(line)) {
      removedLines++
    }
  }

  return { totalAddedLines: addedLines, totalRemovedLines: removedLines }
}

// ============================================================================
// In-Memory Checkpoint Storage
// ============================================================================

interface CheckpointStore {
  checkpoints: Map<string, HydratedCheckpoint[]> // key: conversationId#path
}

/**
 * Generate a storage key from checkpoint key
 */
function makeStorageKey(key: CheckpointKey): string {
  return `${key.conversationId}#${key.path.absPath}`
}

// ============================================================================
// CheckpointManager
// ============================================================================

/**
 * CheckpointManager - Manages file state checkpoints for conversations
 *
 * Features:
 * - Track file modifications during conversations
 * - Revert files to previous states
 * - Separate tracking of user vs agent edits
 * - Query file state at specific timestamps
 */
export class CheckpointManager {
  private _store: CheckpointStore = { checkpoints: new Map() }
  private _currentConversationId: string | undefined
  private _updateCallbacks = new Set<() => void>()

  get currentConversationId(): string | undefined {
    return this._currentConversationId
  }

  setCurrentConversation(conversationId: string): void {
    this._currentConversationId = conversationId
  }

  /**
   * Register a callback for checkpoint updates
   */
  onUpdate(callback: () => void): { dispose: () => void } {
    this._updateCallbacks.add(callback)
    return {
      dispose: () => {
        this._updateCallbacks.delete(callback)
      },
    }
  }

  private _notifyUpdate(): void {
    this._updateCallbacks.forEach((cb) => cb())
  }

  /**
   * Add a checkpoint for a file
   */
  async addCheckpoint(key: CheckpointKey, checkpoint: Omit<HydratedCheckpoint, 'isDirty'>): Promise<void> {
    const storageKey = makeStorageKey(key)
    const checkpoints = this._store.checkpoints.get(storageKey) ?? []
    checkpoints.push({ ...checkpoint, isDirty: false })
    this._store.checkpoints.set(storageKey, checkpoints)
    this._notifyUpdate()
  }

  /**
   * Get all checkpoints for a file
   */
  async getCheckpoints(
    key: CheckpointKey,
    options?: { minTimestamp?: number; maxTimestamp?: number }
  ): Promise<HydratedCheckpoint[]> {
    const storageKey = makeStorageKey(key)
    let checkpoints = this._store.checkpoints.get(storageKey) ?? []

    if (options?.minTimestamp !== undefined) {
      checkpoints = checkpoints.filter((cp) => cp.timestamp >= options.minTimestamp!)
    }
    if (options?.maxTimestamp !== undefined) {
      checkpoints = checkpoints.filter((cp) => cp.timestamp <= options.maxTimestamp!)
    }

    return checkpoints.sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * Get the latest checkpoint for a file
   */
  async getLatestCheckpoint(key: CheckpointKey): Promise<HydratedCheckpoint | undefined> {
    const checkpoints = await this.getCheckpoints(key)
    return checkpoints.at(-1)
  }

  /**
   * Update the latest checkpoint for a file
   */
  async updateLatestCheckpoint(
    filePath: QualifiedPathName,
    newContent: string | undefined,
    options?: { saveToWorkspace?: boolean; updateSource?: EditEventSource }
  ): Promise<void> {
    if (!this._currentConversationId) return

    const key: CheckpointKey = { conversationId: this._currentConversationId, path: filePath }
    const checkpoints = await this.getCheckpoints(key)
    const latestCheckpoint = checkpoints.at(-1)

    if (!latestCheckpoint) return

    const shouldCreateNew =
      (latestCheckpoint.editSource ?? EditEventSource.UNSPECIFIED) !==
        (options?.updateSource ?? EditEventSource.UNSPECIFIED) ||
      latestCheckpoint.lastIncludedInRequestId !== undefined

    if (shouldCreateNew) {
      await this.addCheckpoint(key, {
        sourceToolCallRequestId: createRequestId(),
        timestamp: Date.now(),
        document: createDiffViewDocument(
          filePath,
          latestCheckpoint.document.modifiedCode,
          newContent
        ),
        conversationId: this._currentConversationId,
        editSource: options?.updateSource ?? EditEventSource.UNSPECIFIED,
      })
    } else {
      // Update in place
      latestCheckpoint.document = createDiffViewDocument(
        filePath,
        latestCheckpoint.document.originalCode,
        newContent
      )
      this._notifyUpdate()
    }
  }

  /**
   * Get file state at a specific timestamp
   */
  async getFileStateAtTimestamp(
    conversationId: string,
    filePath: QualifiedPathName,
    timestamp: number
  ): Promise<string | undefined | null> {
    const key: CheckpointKey = { conversationId, path: filePath }
    const checkpoints = await this.getCheckpoints(key)

    if (checkpoints.length === 0) return null

    // Find checkpoint before or at timestamp
    const beforeCkpts = checkpoints.filter((cp) => cp.timestamp <= timestamp)
    const lastBefore = beforeCkpts.at(-1)

    if (lastBefore) {
      return lastBefore.document.modifiedCode
    }

    // Return original state from first checkpoint
    const firstAfter = checkpoints.find((cp) => cp.timestamp > timestamp)
    return firstAfter?.document.originalCode ?? null
  }

  /**
   * Get all tracked files for a conversation
   */
  async getTrackedFiles(conversationId: string): Promise<QualifiedPathName[]> {
    const files: QualifiedPathName[] = []
    const prefix = `${conversationId}#`

    for (const key of this._store.checkpoints.keys()) {
      if (key.startsWith(prefix)) {
        const checkpoints = this._store.checkpoints.get(key)
        if (checkpoints && checkpoints.length > 0) {
          files.push(checkpoints[0].document.filePath)
        }
      }
    }

    return files
  }

  /**
   * Get aggregate checkpoint for all tracked files
   */
  async getAggregateCheckpoint(options: {
    minTimestamp?: number
    maxTimestamp?: number
  }): Promise<AggregateCheckpointInfo> {
    const conversationId = this._currentConversationId
    if (!conversationId) {
      return {
        fromTimestamp: 0,
        toTimestamp: Infinity,
        conversationId: '',
        files: [],
      }
    }

    const minTimestamp = options.minTimestamp ?? 0
    const maxTimestamp = options.maxTimestamp ?? Infinity

    const trackedFiles = await this.getTrackedFiles(conversationId)
    const files: Array<{
      changesSummary: FileChangeSummary
      changeDocument: DiffViewDocument
    }> = []

    for (const filePath of trackedFiles) {
      const original = await this.getFileStateAtTimestamp(conversationId, filePath, minTimestamp)
      const modified = await this.getFileStateAtTimestamp(conversationId, filePath, maxTimestamp)

      if (original === null || modified === null) continue

      const doc = createDiffViewDocument(filePath, original, modified)
      files.push({
        changesSummary: computeChangesSummary(doc),
        changeDocument: doc,
      })
    }

    return {
      fromTimestamp: minTimestamp,
      toTimestamp: maxTimestamp,
      conversationId,
      files,
    }
  }

  /**
   * Get recent user edits (changes made by user, not agent)
   */
  async getRecentUserEdits(): Promise<AggregateCheckpointInfo> {
    const conversationId = this._currentConversationId
    if (!conversationId) {
      return { fromTimestamp: 0, toTimestamp: Infinity, conversationId: '', files: [] }
    }

    const trackedFiles = await this.getTrackedFiles(conversationId)
    const userModifiedFiles: Array<{
      changesSummary: FileChangeSummary
      changeDocument: DiffViewDocument
    }> = []

    for (const filePath of trackedFiles) {
      const key: CheckpointKey = { conversationId, path: filePath }
      const checkpoints = await this.getCheckpoints(key)
      const latest = checkpoints.at(-1)

      if (latest?.editSource === EditEventSource.USER_EDIT) {
        userModifiedFiles.push({
          changesSummary: computeChangesSummary(latest.document),
          changeDocument: latest.document,
        })
      }
    }

    return {
      fromTimestamp: 0,
      toTimestamp: Infinity,
      conversationId,
      files: userModifiedFiles,
    }
  }

  /**
   * Revert a file to a specific timestamp
   */
  async revertDocumentToTimestamp(
    filePath: QualifiedPathName,
    timestamp: number
  ): Promise<void> {
    if (!this._currentConversationId) return

    const original = await this.getFileStateAtTimestamp(
      this._currentConversationId,
      filePath,
      timestamp
    )
    const latest = await this.getFileStateAtTimestamp(
      this._currentConversationId,
      filePath,
      Number.MAX_SAFE_INTEGER
    )

    if (original === null || latest === null) return

    await this.addCheckpoint(
      { conversationId: this._currentConversationId, path: filePath },
      {
        sourceToolCallRequestId: createRequestId(),
        timestamp: Date.now(),
        document: createDiffViewDocument(filePath, latest ?? '', original),
        conversationId: this._currentConversationId,
        editSource: EditEventSource.CHECKPOINT_REVERT,
      }
    )
  }

  /**
   * Revert all tracked files to a specific timestamp
   */
  async revertToTimestamp(timestamp: number): Promise<void> {
    if (!this._currentConversationId) return

    const aggregate = await this.getAggregateCheckpoint({
      minTimestamp: timestamp,
      maxTimestamp: undefined,
    })

    for (const file of aggregate.files) {
      await this.revertDocumentToTimestamp(file.changeDocument.filePath, timestamp)
    }
  }

  /**
   * Clear all checkpoints for a conversation
   */
  async clearConversationCheckpoints(conversationId: string): Promise<void> {
    const prefix = `${conversationId}#`
    const keysToDelete: string[] = []

    for (const key of this._store.checkpoints.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key)
      }
    }

    for (const key of keysToDelete) {
      this._store.checkpoints.delete(key)
    }

    this._notifyUpdate()
  }

  /**
   * Migrate conversation ID (e.g., from temporary to permanent)
   */
  async migrateConversationId(
    oldConversationId: string,
    newConversationId: string
  ): Promise<void> {
    const prefix = `${oldConversationId}#`
    const updates: Array<[string, HydratedCheckpoint[]]> = []

    for (const [key, checkpoints] of this._store.checkpoints.entries()) {
      if (key.startsWith(prefix)) {
        const newKey = key.replace(prefix, `${newConversationId}#`)
        const updatedCheckpoints = checkpoints.map((cp) => ({
          ...cp,
          conversationId: newConversationId,
        }))
        updates.push([newKey, updatedCheckpoints])
        this._store.checkpoints.delete(key)
      }
    }

    for (const [key, checkpoints] of updates) {
      this._store.checkpoints.set(key, checkpoints)
    }

    this._notifyUpdate()
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let _checkpointManager: CheckpointManager | undefined

export function getCheckpointManager(): CheckpointManager {
  if (!_checkpointManager) {
    _checkpointManager = new CheckpointManager()
  }
  return _checkpointManager
}
