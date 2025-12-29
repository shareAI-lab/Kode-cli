/**
 * Lifecycle Management - Disposable patterns for resource cleanup
 *
 * Migrated from AgentTool/15-LifecycleManagement
 *
 * Features:
 * - DisposableService base class
 * - DisposableCollection for managing multiple disposables
 * - Async disposal support
 */

// ============================================================================
// Disposable Interface
// ============================================================================

/**
 * Interface for disposable resources
 */
export interface IDisposable {
  dispose(): void
}

/**
 * Interface for async disposable resources
 */
export interface IAsyncDisposable {
  dispose(): Promise<void>
}

/**
 * Type that can be either sync or async disposable
 */
export type Disposable = IDisposable | IAsyncDisposable

/**
 * Check if a value is disposable
 */
export function isDisposable(value: unknown): value is IDisposable {
  return (
    value !== null &&
    typeof value === 'object' &&
    'dispose' in value &&
    typeof (value as IDisposable).dispose === 'function'
  )
}

// ============================================================================
// Disposable Collection
// ============================================================================

/**
 * DisposableCollection - Manages multiple disposable resources
 *
 * Resources are disposed in reverse order (LIFO)
 */
export class DisposableCollection implements IDisposable {
  private _disposables: Disposable[] = []
  private _isDisposed = false

  /**
   * Check if the collection has been disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed
  }

  /**
   * Add a disposable to the collection
   *
   * @returns The added disposable (for chaining)
   */
  add<T extends Disposable>(disposable: T): T {
    if (this._isDisposed) {
      // Immediately dispose if collection is already disposed
      const result = disposable.dispose()
      if (result instanceof Promise) {
        result.catch(() => {}) // Ignore errors
      }
      return disposable
    }

    this._disposables.push(disposable)
    return disposable
  }

  /**
   * Add multiple disposables
   */
  addAll(...disposables: Disposable[]): void {
    for (const disposable of disposables) {
      this.add(disposable)
    }
  }

  /**
   * Remove a disposable without disposing it
   */
  remove(disposable: Disposable): boolean {
    const index = this._disposables.indexOf(disposable)
    if (index !== -1) {
      this._disposables.splice(index, 1)
      return true
    }
    return false
  }

  /**
   * Clear all disposables without disposing them
   */
  clear(): void {
    this._disposables = []
  }

  /**
   * Dispose all resources in reverse order
   */
  dispose(): void {
    if (this._isDisposed) return

    this._isDisposed = true

    // Dispose in reverse order (LIFO)
    const disposables = this._disposables.reverse()
    this._disposables = []

    for (const disposable of disposables) {
      try {
        const result = disposable.dispose()
        if (result instanceof Promise) {
          result.catch(() => {}) // Ignore async errors in sync dispose
        }
      } catch {
        // Ignore errors during disposal
      }
    }
  }

  /**
   * Dispose all resources asynchronously in reverse order
   */
  async disposeAsync(): Promise<void> {
    if (this._isDisposed) return

    this._isDisposed = true

    // Dispose in reverse order (LIFO)
    const disposables = this._disposables.reverse()
    this._disposables = []

    for (const disposable of disposables) {
      try {
        const result = disposable.dispose()
        if (result instanceof Promise) {
          await result
        }
      } catch {
        // Ignore errors during disposal
      }
    }
  }

  /**
   * Create a disposable from a callback
   */
  static fromCallback(callback: () => void | Promise<void>): IDisposable {
    return { dispose: callback }
  }
}

// ============================================================================
// Disposable Service Base Class
// ============================================================================

/**
 * DisposableService - Base class for services that need resource cleanup
 *
 * Provides:
 * - Automatic tracking of disposables
 * - Lifecycle state management
 * - Cleanup on dispose
 */
export abstract class DisposableService implements IDisposable {
  private _disposables = new DisposableCollection()
  private _isDisposed = false

  /**
   * Check if the service has been disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed
  }

  /**
   * Register a disposable to be cleaned up when the service is disposed
   */
  protected register<T extends Disposable>(disposable: T): T {
    return this._disposables.add(disposable)
  }

  /**
   * Register a callback to be called when the service is disposed
   */
  protected registerCallback(callback: () => void | Promise<void>): IDisposable {
    return this.register(DisposableCollection.fromCallback(callback))
  }

  /**
   * Called before disposal - override in subclasses for custom cleanup
   */
  protected onDispose(): void | Promise<void> {
    // Override in subclasses
  }

  /**
   * Dispose the service and all registered resources
   */
  dispose(): void {
    if (this._isDisposed) return

    this._isDisposed = true

    try {
      const result = this.onDispose()
      if (result instanceof Promise) {
        result.catch(() => {})
      }
    } catch {
      // Ignore errors in onDispose
    }

    this._disposables.dispose()
  }

  /**
   * Dispose the service asynchronously
   */
  async disposeAsync(): Promise<void> {
    if (this._isDisposed) return

    this._isDisposed = true

    try {
      await this.onDispose()
    } catch {
      // Ignore errors in onDispose
    }

    await this._disposables.disposeAsync()
  }
}

// ============================================================================
// Event Emitter with Disposal
// ============================================================================

export type EventListener<T> = (event: T) => void

/**
 * Simple event emitter with disposal support
 */
export class EventEmitter<T> implements IDisposable {
  private _listeners = new Set<EventListener<T>>()
  private _isDisposed = false

  /**
   * Subscribe to events
   *
   * @returns Disposable that removes the listener when disposed
   */
  on(listener: EventListener<T>): IDisposable {
    if (this._isDisposed) {
      return { dispose: () => {} }
    }

    this._listeners.add(listener)

    return {
      dispose: () => {
        this._listeners.delete(listener)
      },
    }
  }

  /**
   * Subscribe to a single event
   */
  once(listener: EventListener<T>): IDisposable {
    const disposable = this.on((event) => {
      disposable.dispose()
      listener(event)
    })
    return disposable
  }

  /**
   * Emit an event to all listeners
   */
  emit(event: T): void {
    if (this._isDisposed) return

    for (const listener of this._listeners) {
      try {
        listener(event)
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Clear all listeners
   */
  clear(): void {
    this._listeners.clear()
  }

  /**
   * Dispose the emitter
   */
  dispose(): void {
    this._isDisposed = true
    this._listeners.clear()
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a disposable that does nothing
 */
export const EmptyDisposable: IDisposable = { dispose: () => {} }

/**
 * Combine multiple disposables into one
 */
export function combineDisposables(...disposables: Disposable[]): IDisposable {
  return {
    dispose: () => {
      for (const disposable of disposables.reverse()) {
        try {
          const result = disposable.dispose()
          if (result instanceof Promise) {
            result.catch(() => {})
          }
        } catch {
          // Ignore errors
        }
      }
    },
  }
}

/**
 * Timeout that can be disposed
 */
export function disposableTimeout(
  callback: () => void,
  ms: number
): IDisposable {
  const handle = setTimeout(callback, ms)
  return {
    dispose: () => clearTimeout(handle),
  }
}

/**
 * Interval that can be disposed
 */
export function disposableInterval(
  callback: () => void,
  ms: number
): IDisposable {
  const handle = setInterval(callback, ms)
  return {
    dispose: () => clearInterval(handle),
  }
}

/**
 * Run a callback when a disposable is disposed
 */
export function onDispose(
  disposable: IDisposable,
  callback: () => void
): IDisposable {
  const originalDispose = disposable.dispose.bind(disposable)
  disposable.dispose = () => {
    originalDispose()
    callback()
  }
  return disposable
}
