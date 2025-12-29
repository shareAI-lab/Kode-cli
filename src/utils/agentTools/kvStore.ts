/**
 * KV Store - File-based key-value storage system
 *
 * Migrated from AgentTool/17-StorageSystem (simplified without LevelDB/gRPC)
 *
 * Features:
 * - Simple file-based JSON storage
 * - In-memory caching with write-through
 * - Batch operations for consistency
 * - Range queries and iteration
 * - Conversation and exchange management
 */

import * as fs from 'fs/promises'
import * as path from 'path'

// ============================================================================
// Types
// ============================================================================

/**
 * Iterator options for range queries
 */
export interface KvIteratorOptions {
  /** Greater than or equal to */
  gte?: string
  /** Greater than */
  gt?: string
  /** Less than or equal to */
  lte?: string
  /** Less than */
  lt?: string
  /** Maximum number of results */
  limit?: number
  /** Reverse order */
  reverse?: boolean
}

/**
 * Batch operation type
 */
export type KvBatchOperation =
  | { type: 'put'; key: string; value: string }
  | { type: 'del'; key: string }

/**
 * KV Store interface
 */
export interface IKvStore {
  get(key: string): Promise<string | undefined>
  getMany(keys: string[]): Promise<(string | undefined)[]>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  batch(operations: KvBatchOperation[]): Promise<void>
  keys(options?: KvIteratorOptions): AsyncIterable<string>
  iterator(options?: KvIteratorOptions): AsyncIterable<[string, string]>
  close(): Promise<void>
}

// ============================================================================
// In-Memory KV Store
// ============================================================================

/**
 * In-memory key-value store
 * Useful for testing and temporary storage
 */
export class InMemoryKvStore implements IKvStore {
  private _data = new Map<string, string>()

  async get(key: string): Promise<string | undefined> {
    return this._data.get(key)
  }

  async getMany(keys: string[]): Promise<(string | undefined)[]> {
    return keys.map((key) => this._data.get(key))
  }

  async put(key: string, value: string): Promise<void> {
    this._data.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this._data.delete(key)
  }

  async batch(operations: KvBatchOperation[]): Promise<void> {
    for (const op of operations) {
      if (op.type === 'put') {
        this._data.set(op.key, op.value)
      } else if (op.type === 'del') {
        this._data.delete(op.key)
      }
    }
  }

  async *keys(options?: KvIteratorOptions): AsyncIterable<string> {
    for (const key of this._getSortedKeys(options)) {
      yield key
    }
  }

  async *iterator(options?: KvIteratorOptions): AsyncIterable<[string, string]> {
    for (const key of this._getSortedKeys(options)) {
      const value = this._data.get(key)
      if (value !== undefined) {
        yield [key, value]
      }
    }
  }

  async close(): Promise<void> {
    // No-op for in-memory store
  }

  private _getSortedKeys(options?: KvIteratorOptions): string[] {
    let keys = Array.from(this._data.keys()).sort()

    if (options?.reverse) {
      keys = keys.reverse()
    }

    keys = keys.filter((key) => {
      if (options?.gte && key < options.gte) return false
      if (options?.gt && key <= options.gt) return false
      if (options?.lte && key > options.lte) return false
      if (options?.lt && key >= options.lt) return false
      return true
    })

    if (options?.limit) {
      keys = keys.slice(0, options.limit)
    }

    return keys
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this._data.clear()
  }

  /**
   * Get current size
   */
  get size(): number {
    return this._data.size
  }
}

// ============================================================================
// File-based KV Store
// ============================================================================

/**
 * File-based key-value store
 * Uses JSON file for persistence with in-memory caching
 */
export class FileKvStore implements IKvStore {
  private _data = new Map<string, string>()
  private _loaded = false
  private _filePath: string
  private _saveDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private _saveDebounceMs: number
  private _dirty = false

  constructor(filePath: string, options?: { saveDebounceMs?: number }) {
    this._filePath = filePath
    this._saveDebounceMs = options?.saveDebounceMs ?? 100
  }

  private async _ensureLoaded(): Promise<void> {
    if (this._loaded) return

    try {
      const content = await fs.readFile(this._filePath, 'utf-8')
      const data = JSON.parse(content) as Record<string, string>
      this._data = new Map(Object.entries(data))
    } catch (error) {
      // File doesn't exist or is invalid, start with empty store
      this._data = new Map()
    }

    this._loaded = true
  }

  private _scheduleSave(): void {
    this._dirty = true

    if (this._saveDebounceTimer) {
      clearTimeout(this._saveDebounceTimer)
    }

    this._saveDebounceTimer = setTimeout(() => {
      void this._save()
    }, this._saveDebounceMs)
  }

  private async _save(): Promise<void> {
    if (!this._dirty) return

    const dir = path.dirname(this._filePath)
    await fs.mkdir(dir, { recursive: true })

    const data = Object.fromEntries(this._data)
    await fs.writeFile(this._filePath, JSON.stringify(data, null, 2), 'utf-8')

    this._dirty = false
  }

  async get(key: string): Promise<string | undefined> {
    await this._ensureLoaded()
    return this._data.get(key)
  }

  async getMany(keys: string[]): Promise<(string | undefined)[]> {
    await this._ensureLoaded()
    return keys.map((key) => this._data.get(key))
  }

  async put(key: string, value: string): Promise<void> {
    await this._ensureLoaded()
    this._data.set(key, value)
    this._scheduleSave()
  }

  async delete(key: string): Promise<void> {
    await this._ensureLoaded()
    this._data.delete(key)
    this._scheduleSave()
  }

  async batch(operations: KvBatchOperation[]): Promise<void> {
    await this._ensureLoaded()

    for (const op of operations) {
      if (op.type === 'put') {
        this._data.set(op.key, op.value)
      } else if (op.type === 'del') {
        this._data.delete(op.key)
      }
    }

    this._scheduleSave()
  }

  async *keys(options?: KvIteratorOptions): AsyncIterable<string> {
    await this._ensureLoaded()

    for (const key of this._getSortedKeys(options)) {
      yield key
    }
  }

  async *iterator(options?: KvIteratorOptions): AsyncIterable<[string, string]> {
    await this._ensureLoaded()

    for (const key of this._getSortedKeys(options)) {
      const value = this._data.get(key)
      if (value !== undefined) {
        yield [key, value]
      }
    }
  }

  async close(): Promise<void> {
    if (this._saveDebounceTimer) {
      clearTimeout(this._saveDebounceTimer)
      this._saveDebounceTimer = null
    }

    await this._save()
  }

  private _getSortedKeys(options?: KvIteratorOptions): string[] {
    let keys = Array.from(this._data.keys()).sort()

    if (options?.reverse) {
      keys = keys.reverse()
    }

    keys = keys.filter((key) => {
      if (options?.gte && key < options.gte) return false
      if (options?.gt && key <= options.gt) return false
      if (options?.lte && key > options.lte) return false
      if (options?.lt && key >= options.lt) return false
      return true
    })

    if (options?.limit) {
      keys = keys.slice(0, options.limit)
    }

    return keys
  }

  /**
   * Force save immediately
   */
  async flush(): Promise<void> {
    if (this._saveDebounceTimer) {
      clearTimeout(this._saveDebounceTimer)
      this._saveDebounceTimer = null
    }
    await this._save()
  }

  /**
   * Get current size
   */
  get size(): number {
    return this._data.size
  }
}

// ============================================================================
// Exchange Manager
// ============================================================================

/**
 * Stored exchange type
 */
export interface StoredExchange {
  uuid: string
  conversationId: string
  timestamp: number
  data: unknown
}

/**
 * Conversation metadata
 */
export interface ConversationMetadata {
  conversationId: string
  totalExchanges: number
  lastUpdated: number
}

/**
 * Exchange Manager - High-level API for exchange storage
 *
 * Features:
 * - Conversation-based storage
 * - Efficient prefix scanning
 * - Atomic batch operations
 */
export class ExchangeManager {
  private _kvStore: IKvStore
  private static readonly RANGE_SUFFIX = '\xFF'

  constructor(kvStore: IKvStore) {
    this._kvStore = kvStore
  }

  private _getExchangeKey(conversationId: string, exchangeUuid: string): string {
    return `exchange:${conversationId}:${exchangeUuid}`
  }

  private _getExchangePrefix(conversationId: string): string {
    return `exchange:${conversationId}:`
  }

  private _getMetadataKey(conversationId: string): string {
    return `metadata:${conversationId}`
  }

  /**
   * Load metadata for a conversation
   */
  async loadMetadata(conversationId: string): Promise<ConversationMetadata | undefined> {
    const key = this._getMetadataKey(conversationId)
    const data = await this._kvStore.get(key)

    if (!data) return undefined

    try {
      return JSON.parse(data) as ConversationMetadata
    } catch {
      return undefined
    }
  }

  /**
   * Load exchanges by UUIDs
   */
  async loadExchangesByUuids(
    conversationId: string,
    uuids: string[]
  ): Promise<StoredExchange[]> {
    if (uuids.length === 0) return []

    const keys = uuids.map((uuid) => this._getExchangeKey(conversationId, uuid))
    const values = await this._kvStore.getMany(keys)

    const exchanges: StoredExchange[] = []
    for (const value of values) {
      if (value) {
        try {
          exchanges.push(JSON.parse(value) as StoredExchange)
        } catch {
          // Skip invalid entries
        }
      }
    }

    return exchanges
  }

  /**
   * Save exchanges with upsert semantics
   */
  async saveExchanges(conversationId: string, exchanges: StoredExchange[]): Promise<void> {
    if (exchanges.length === 0) return

    // Get existing metadata
    const existingMetadata = await this.loadMetadata(conversationId)
    const currentCount = existingMetadata?.totalExchanges || 0

    // Check which exchanges already exist
    const existingKeys = new Set<string>()
    const prefix = this._getExchangePrefix(conversationId)

    for await (const key of this._kvStore.keys({
      gte: prefix,
      lt: prefix + ExchangeManager.RANGE_SUFFIX,
    })) {
      existingKeys.add(key)
    }

    // Count new exchanges
    let newCount = 0
    for (const exchange of exchanges) {
      const key = this._getExchangeKey(conversationId, exchange.uuid)
      if (!existingKeys.has(key)) {
        newCount++
      }
    }

    // Build batch operations
    const operations: KvBatchOperation[] = [
      ...exchanges.map((exchange) => ({
        type: 'put' as const,
        key: this._getExchangeKey(conversationId, exchange.uuid),
        value: JSON.stringify({ ...exchange, conversationId }),
      })),
      {
        type: 'put' as const,
        key: this._getMetadataKey(conversationId),
        value: JSON.stringify({
          conversationId,
          totalExchanges: currentCount + newCount,
          lastUpdated: Date.now(),
        }),
      },
    ]

    await this._kvStore.batch(operations)
  }

  /**
   * Delete exchanges
   */
  async deleteExchanges(conversationId: string, uuids: string[]): Promise<void> {
    if (uuids.length === 0) return

    const existingMetadata = await this.loadMetadata(conversationId)
    const currentCount = existingMetadata?.totalExchanges || 0

    const operations: KvBatchOperation[] = [
      ...uuids.map((uuid) => ({
        type: 'del' as const,
        key: this._getExchangeKey(conversationId, uuid),
      })),
      {
        type: 'put' as const,
        key: this._getMetadataKey(conversationId),
        value: JSON.stringify({
          conversationId,
          totalExchanges: Math.max(0, currentCount - uuids.length),
          lastUpdated: Date.now(),
        }),
      },
    ]

    await this._kvStore.batch(operations)
  }

  /**
   * Delete all exchanges for a conversation
   */
  async deleteConversationExchanges(conversationId: string): Promise<void> {
    const prefix = this._getExchangePrefix(conversationId)
    const keysToDelete: string[] = []

    for await (const key of this._kvStore.keys({
      gte: prefix,
      lt: prefix + ExchangeManager.RANGE_SUFFIX,
    })) {
      keysToDelete.push(key)
    }

    if (keysToDelete.length === 0) return

    const operations: KvBatchOperation[] = [
      ...keysToDelete.map((key) => ({
        type: 'del' as const,
        key,
      })),
      {
        type: 'del' as const,
        key: this._getMetadataKey(conversationId),
      },
    ]

    await this._kvStore.batch(operations)
  }

  /**
   * Load all exchanges for a conversation
   */
  async loadConversationExchanges(conversationId: string): Promise<StoredExchange[]> {
    const prefix = this._getExchangePrefix(conversationId)
    const exchanges: StoredExchange[] = []

    for await (const [_, value] of this._kvStore.iterator({
      gte: prefix,
      lt: prefix + ExchangeManager.RANGE_SUFFIX,
    })) {
      try {
        exchanges.push(JSON.parse(value) as StoredExchange)
      } catch {
        // Skip invalid entries
      }
    }

    return exchanges
  }

  /**
   * Count exchanges in a conversation
   */
  async countExchanges(conversationId: string): Promise<number> {
    const metadata = await this.loadMetadata(conversationId)
    return metadata?.totalExchanges || 0
  }

  /**
   * Close the store
   */
  async close(): Promise<void> {
    await this._kvStore.close()
  }
}

// ============================================================================
// History Manager
// ============================================================================

/**
 * Stored conversation history
 */
export interface StoredConversationHistory {
  conversationId: string
  chatHistoryJson: string
  timestamp: number
  itemCount: number
  hasExchanges: boolean
}

/**
 * Conversation history metadata
 */
export interface ConversationHistoryMetadata {
  conversationId: string
  lastUpdated: number
  itemCount: number
  hasExchanges: boolean
}

/**
 * History Manager - API for conversation history storage
 */
export class HistoryManager {
  private _kvStore: IKvStore

  constructor(kvStore: IKvStore) {
    this._kvStore = kvStore
  }

  private _getHistoryKey(conversationId: string): string {
    return `history:${conversationId}`
  }

  private _getHistoryMetadataKey(conversationId: string): string {
    return `history-metadata:${conversationId}`
  }

  /**
   * Load conversation history
   */
  async loadConversationHistory<T>(conversationId: string): Promise<T[]> {
    const key = this._getHistoryKey(conversationId)
    const data = await this._kvStore.get(key)

    if (!data) return []

    try {
      const stored = JSON.parse(data) as StoredConversationHistory
      return JSON.parse(stored.chatHistoryJson) as T[]
    } catch {
      return []
    }
  }

  /**
   * Save conversation history
   */
  async saveConversationHistory<T>(conversationId: string, chatHistory: T[]): Promise<void> {
    const itemCount = chatHistory.length
    const chatHistoryJson = JSON.stringify(chatHistory)
    const timestamp = Date.now()

    const storedHistory: StoredConversationHistory = {
      conversationId,
      chatHistoryJson,
      timestamp,
      itemCount,
      hasExchanges: itemCount > 0,
    }

    const metadata: ConversationHistoryMetadata = {
      conversationId,
      lastUpdated: timestamp,
      itemCount,
      hasExchanges: itemCount > 0,
    }

    const operations: KvBatchOperation[] = [
      {
        type: 'put',
        key: this._getHistoryKey(conversationId),
        value: JSON.stringify(storedHistory),
      },
      {
        type: 'put',
        key: this._getHistoryMetadataKey(conversationId),
        value: JSON.stringify(metadata),
      },
    ]

    await this._kvStore.batch(operations)
  }

  /**
   * Delete conversation history
   */
  async deleteConversationHistory(conversationId: string): Promise<void> {
    const operations: KvBatchOperation[] = [
      {
        type: 'del',
        key: this._getHistoryKey(conversationId),
      },
      {
        type: 'del',
        key: this._getHistoryMetadataKey(conversationId),
      },
    ]

    await this._kvStore.batch(operations)
  }

  /**
   * Get conversation history metadata
   */
  async getConversationHistoryMetadata(
    conversationId: string
  ): Promise<ConversationHistoryMetadata | null> {
    const key = this._getHistoryMetadataKey(conversationId)
    const data = await this._kvStore.get(key)

    if (!data) return null

    try {
      return JSON.parse(data) as ConversationHistoryMetadata
    } catch {
      return null
    }
  }

  /**
   * Close the store
   */
  async close(): Promise<void> {
    await this._kvStore.close()
  }
}

// ============================================================================
// Singleton Exports
// ============================================================================

let _kvStore: IKvStore | undefined
let _exchangeManager: ExchangeManager | undefined
let _historyManager: HistoryManager | undefined

/**
 * Get or create the default KV store
 */
export function getKvStore(filePath?: string): IKvStore {
  if (!_kvStore) {
    if (filePath) {
      _kvStore = new FileKvStore(filePath)
    } else {
      _kvStore = new InMemoryKvStore()
    }
  }
  return _kvStore
}

/**
 * Get or create the exchange manager
 */
export function getExchangeManager(kvStore?: IKvStore): ExchangeManager {
  if (!_exchangeManager) {
    _exchangeManager = new ExchangeManager(kvStore ?? getKvStore())
  }
  return _exchangeManager
}

/**
 * Get or create the history manager
 */
export function getHistoryManager(kvStore?: IKvStore): HistoryManager {
  if (!_historyManager) {
    _historyManager = new HistoryManager(kvStore ?? getKvStore())
  }
  return _historyManager
}

/**
 * Reset all singletons (for testing)
 */
export function resetKvStoreSingletons(): void {
  _kvStore = undefined
  _exchangeManager = undefined
  _historyManager = undefined
}
