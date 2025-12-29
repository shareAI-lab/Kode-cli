/**
 * TaskManager - Hierarchical task management system
 *
 * Migrated from AgentTool/13-TaskManagement
 *
 * Features:
 * - Task creation with parent/child relationships
 * - Task state tracking (pending, in_progress, completed, cancelled)
 * - Tree diffing for batch updates
 * - Manifest-based persistence
 */

import * as crypto from 'crypto'

// ============================================================================
// Types
// ============================================================================

export enum TaskState {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  BLOCKED = 'blocked',
}

export enum TaskUpdatedBy {
  USER = 'user',
  AGENT = 'agent',
  SYSTEM = 'system',
}

export interface SerializedTask {
  uuid: string
  name: string
  description: string
  state: TaskState
  subTasks: string[] // UUIDs of child tasks
  lastUpdated: number
  lastUpdatedBy?: TaskUpdatedBy
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface HydratedTask extends SerializedTask {
  subTasksData?: HydratedTask[]
}

export interface TaskMetadata {
  uuid: string
  name: string
  lastUpdated: number
  state: TaskState
  parentTask?: string
}

export interface TaskManifest {
  version: number
  lastUpdated: number
  tasks: Record<string, TaskMetadata>
}

export interface TaskStorage {
  loadManifest(): Promise<TaskManifest | null>
  saveManifest(manifest: TaskManifest): Promise<void>
  loadTask(uuid: string): Promise<HydratedTask | undefined>
  saveTask(uuid: string, task: SerializedTask): Promise<void>
}

// ============================================================================
// Task Factory
// ============================================================================

export class TaskFactory {
  /**
   * Create a new task with default values
   */
  static createTask(name: string, description: string): SerializedTask {
    const now = Date.now()
    return {
      uuid: crypto.randomUUID(),
      name,
      description,
      state: TaskState.PENDING,
      subTasks: [],
      lastUpdated: now,
      createdAt: now,
    }
  }
}

// ============================================================================
// Task Utilities
// ============================================================================

interface TaskTreeDiff {
  created: SerializedTask[]
  updated: SerializedTask[]
  deleted: SerializedTask[]
}

/**
 * Compare two task trees and identify differences
 */
export function diffTaskTrees(existing: HydratedTask, updated: HydratedTask): TaskTreeDiff {
  const created: SerializedTask[] = []
  const updatedTasks: SerializedTask[] = []
  const deleted: SerializedTask[] = []

  const existingMap = new Map<string, HydratedTask>()
  const updatedMap = new Map<string, HydratedTask>()

  // Build maps for O(1) lookup
  function buildMap(task: HydratedTask, map: Map<string, HydratedTask>): void {
    map.set(task.uuid, task)
    for (const subTask of task.subTasksData ?? []) {
      buildMap(subTask, map)
    }
  }

  buildMap(existing, existingMap)
  buildMap(updated, updatedMap)

  // Find created and updated tasks
  for (const [uuid, task] of updatedMap) {
    const existingTask = existingMap.get(uuid)
    if (!existingTask) {
      created.push(task)
    } else if (hasTaskChanged(existingTask, task)) {
      updatedTasks.push(task)
    }
  }

  // Find deleted tasks
  for (const [uuid, task] of existingMap) {
    if (!updatedMap.has(uuid)) {
      deleted.push(task)
    }
  }

  return { created, updated: updatedTasks, deleted }
}

function hasTaskChanged(existing: SerializedTask, updated: SerializedTask): boolean {
  return (
    existing.name !== updated.name ||
    existing.description !== updated.description ||
    existing.state !== updated.state ||
    JSON.stringify(existing.subTasks) !== JSON.stringify(updated.subTasks)
  )
}

// ============================================================================
// In-Memory Task Storage
// ============================================================================

export class InMemoryTaskStorage implements TaskStorage {
  private _manifest: TaskManifest | null = null
  private _tasks = new Map<string, SerializedTask>()

  async loadManifest(): Promise<TaskManifest | null> {
    return this._manifest
  }

  async saveManifest(manifest: TaskManifest): Promise<void> {
    this._manifest = manifest
  }

  async loadTask(uuid: string): Promise<HydratedTask | undefined> {
    return this._tasks.get(uuid)
  }

  async saveTask(uuid: string, task: SerializedTask): Promise<void> {
    this._tasks.set(uuid, task)
  }
}

// ============================================================================
// TaskManager
// ============================================================================

/**
 * TaskManager - High-level API for managing tasks
 *
 * Features:
 * - Create tasks with parent/child relationships
 * - Update task states
 * - Track task hierarchy
 * - Batch updates with tree diffing
 */
export class TaskManager {
  private _initialized = false
  private _manifest: TaskManifest = {
    version: 1,
    lastUpdated: Date.now(),
    tasks: {},
  }
  private _currentRootTaskUuid: string | undefined

  constructor(private _storage: TaskStorage) {}

  /**
   * Initialize the task manager
   */
  async initialize(): Promise<void> {
    if (this._initialized) return

    const manifest = await this._storage.loadManifest()
    if (manifest) {
      this._manifest = manifest
    }

    this._initialized = true
  }

  private async _ensureInitialized(): Promise<void> {
    if (!this._initialized) {
      await this.initialize()
    }
  }

  private async _updateManifest(task: SerializedTask, parentTaskUuid?: string): Promise<void> {
    await this._ensureInitialized()

    this._manifest.tasks[task.uuid] = {
      uuid: task.uuid,
      name: task.name,
      lastUpdated: task.lastUpdated,
      state: task.state,
      parentTask: parentTaskUuid,
    }
    this._manifest.lastUpdated = Date.now()

    await this._storage.saveManifest(this._manifest)
  }

  /**
   * Create a new task
   */
  async createTask(
    name: string,
    description: string,
    parentTaskUuid?: string,
    insertAfterUuid?: string
  ): Promise<string> {
    await this._ensureInitialized()

    const task = TaskFactory.createTask(name, description)
    const effectiveParentUuid = parentTaskUuid || this._currentRootTaskUuid

    if (effectiveParentUuid) {
      const parentTask = await this.getTask(effectiveParentUuid)
      if (parentTask) {
        if (insertAfterUuid) {
          const targetIndex = parentTask.subTasks.indexOf(insertAfterUuid)
          if (targetIndex !== -1) {
            const subTasks = [...parentTask.subTasks]
            subTasks.splice(targetIndex + 1, 0, task.uuid)
            await this.updateTask(effectiveParentUuid, { subTasks }, TaskUpdatedBy.USER)
          } else {
            await this.updateTask(
              effectiveParentUuid,
              { subTasks: [...parentTask.subTasks, task.uuid] },
              TaskUpdatedBy.USER
            )
          }
        } else {
          await this.updateTask(
            effectiveParentUuid,
            { subTasks: [...parentTask.subTasks, task.uuid] },
            TaskUpdatedBy.USER
          )
        }
      }
    }

    await this._storage.saveTask(task.uuid, task)
    await this._updateManifest(task, effectiveParentUuid)

    return task.uuid
  }

  /**
   * Update an existing task
   */
  async updateTask(
    uuid: string,
    updates: Partial<SerializedTask>,
    updatedBy: TaskUpdatedBy
  ): Promise<void> {
    await this._ensureInitialized()

    const task = await this.getTask(uuid)
    if (!task) return

    const updatedTask: SerializedTask = {
      ...task,
      ...updates,
      lastUpdated: Date.now(),
      lastUpdatedBy: updatedBy,
    }

    await this._storage.saveTask(uuid, updatedTask)
    await this._updateManifest(updatedTask, this._manifest.tasks[uuid]?.parentTask)
  }

  /**
   * Get a task by UUID
   */
  async getTask(uuid: string): Promise<HydratedTask | undefined> {
    await this._ensureInitialized()
    return this._storage.loadTask(uuid)
  }

  /**
   * Get a task with all sub-tasks hydrated
   */
  async getHydratedTask(uuid: string): Promise<HydratedTask | undefined> {
    await this._ensureInitialized()

    const task = await this.getTask(uuid)
    if (!task) return undefined

    const subTasksData: HydratedTask[] = []
    for (const subTaskUuid of task.subTasks) {
      const subTask = await this.getHydratedTask(subTaskUuid)
      if (subTask) {
        subTasksData.push(subTask)
      }
    }

    return { ...task, subTasksData }
  }

  /**
   * Cancel a task and optionally its sub-tasks
   */
  async cancelTask(
    uuid: string,
    cancelSubTasks: boolean = false,
    updatedBy: TaskUpdatedBy = TaskUpdatedBy.USER
  ): Promise<void> {
    await this._ensureInitialized()

    const task = await this.getTask(uuid)
    if (!task) return

    await this.updateTask(uuid, { state: TaskState.CANCELLED }, updatedBy)

    if (cancelSubTasks) {
      for (const subTaskUuid of task.subTasks) {
        await this.cancelTask(subTaskUuid, true, updatedBy)
      }
    }
  }

  /**
   * Complete a task
   */
  async completeTask(uuid: string, updatedBy: TaskUpdatedBy = TaskUpdatedBy.USER): Promise<void> {
    await this.updateTask(uuid, { state: TaskState.COMPLETED }, updatedBy)
  }

  /**
   * Start a task (mark as in progress)
   */
  async startTask(uuid: string, updatedBy: TaskUpdatedBy = TaskUpdatedBy.USER): Promise<void> {
    await this.updateTask(uuid, { state: TaskState.IN_PROGRESS }, updatedBy)
  }

  /**
   * Get all tasks
   */
  async getAllTasks(): Promise<SerializedTask[]> {
    await this._ensureInitialized()

    const tasks: SerializedTask[] = []
    for (const uuid of Object.keys(this._manifest.tasks)) {
      const task = await this.getTask(uuid)
      if (task) {
        tasks.push(task)
      }
    }
    return tasks
  }

  /**
   * Get all root tasks (tasks with no parent)
   */
  async getRootTasks(): Promise<SerializedTask[]> {
    await this._ensureInitialized()

    const rootTaskUuids = Object.entries(this._manifest.tasks)
      .filter(([_, metadata]) => !metadata.parentTask)
      .map(([uuid]) => uuid)

    const rootTasks: SerializedTask[] = []
    for (const uuid of rootTaskUuids) {
      const task = await this.getTask(uuid)
      if (task) {
        rootTasks.push(task)
      }
    }
    return rootTasks
  }

  /**
   * Get current root task UUID
   */
  getCurrentRootTaskUuid(): string | undefined {
    return this._currentRootTaskUuid
  }

  /**
   * Set current root task UUID
   */
  setCurrentRootTaskUuid(uuid: string): void {
    this._currentRootTaskUuid = uuid
  }

  /**
   * Update an entire task tree
   */
  async updateHydratedTask(
    newTree: HydratedTask,
    updatedBy: TaskUpdatedBy
  ): Promise<{ created: number; updated: number; deleted: number }> {
    await this._ensureInitialized()

    const existingTree = await this.getHydratedTask(newTree.uuid)
    if (!existingTree) {
      return { created: 0, updated: 0, deleted: 0 }
    }

    const changes = diffTaskTrees(existingTree, newTree)

    // Create new tasks
    const tempUuidToRealUuid = new Map<string, string>()
    for (const task of changes.created) {
      const oldUuid = task.uuid
      const newUuid = await this.createTask(task.name, task.description)
      tempUuidToRealUuid.set(oldUuid, newUuid)
      task.uuid = newUuid
    }

    // Update UUIDs in all tasks
    const updateUuids = (task: SerializedTask) => {
      task.subTasks = task.subTasks.map((uuid) => tempUuidToRealUuid.get(uuid) || uuid)
    }
    changes.created.forEach(updateUuids)
    changes.updated.forEach(updateUuids)

    // Update existing tasks
    for (const task of [...changes.created, ...changes.updated]) {
      await this.updateTask(
        task.uuid,
        {
          name: task.name,
          description: task.description,
          state: task.state,
          subTasks: task.subTasks,
        },
        updatedBy
      )
    }

    // Delete tasks (cancel them)
    for (const task of changes.deleted) {
      if (task.uuid === newTree.uuid) continue
      await this.cancelTask(task.uuid, true, updatedBy)
    }

    return {
      created: changes.created.length,
      updated: changes.updated.length,
      deleted: changes.deleted.length,
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let _taskManager: TaskManager | undefined

export function getTaskManager(storage?: TaskStorage): TaskManager {
  if (!_taskManager) {
    _taskManager = new TaskManager(storage ?? new InMemoryTaskStorage())
  }
  return _taskManager
}
