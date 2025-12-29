/**
 * Observable - Reactive state management with computed values
 *
 * Migrated from AgentTool/10-UtilityTools/observable.ts
 *
 * Features:
 * - Reactive value boxing with change notifications
 * - Computed/derived observables with automatic updates
 * - waitUntil for async condition waiting
 * - Custom equality functions
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Listener callback type
 */
export type ObservableListener<T> = (newValue: T, oldValue: T) => void

/**
 * Predicate function for waitUntil
 */
export type ObservablePredicate<T> = (value: T) => boolean

/**
 * Equality function for comparing values
 */
export type EqualityFn<T> = (a: T, b: T) => boolean

/**
 * Unlisten function returned by listen()
 */
export type Unlisten = () => void

// ============================================================================
// Observable Class
// ============================================================================

/**
 * Observable - Boxes a value and notifies listeners when the value changes
 *
 * Features:
 * - Reactive updates via listen()
 * - Computed observables via Observable.watch()
 * - Async condition waiting via waitUntil()
 * - Custom equality comparison
 *
 * @example
 * ```typescript
 * const count = new Observable(0)
 *
 * // Listen for changes
 * const unlisten = count.listen((newVal, oldVal) => {
 *   console.log(`Changed from ${oldVal} to ${newVal}`)
 * })
 *
 * count.value = 1 // logs: "Changed from 0 to 1"
 *
 * // Stop listening
 * unlisten()
 * ```
 */
export class Observable<T> {
  private _value: T
  private _equalityFn: EqualityFn<T>
  private _listeners: ObservableListener<T>[] = []

  constructor(
    initialValue: T,
    equalityFn: EqualityFn<T> = (a, b) => a === b
  ) {
    this._value = initialValue
    this._equalityFn = equalityFn
  }

  /**
   * Get the current value
   */
  get value(): T {
    return this._value
  }

  /**
   * Set a new value (triggers listeners if value changed)
   */
  set value(newValue: T) {
    if (this._equalityFn(newValue, this._value)) {
      return
    }

    const oldValue = this._value
    this._value = newValue

    for (const listener of this._listeners) {
      try {
        listener(newValue, oldValue)
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Subscribe to value changes
   *
   * @param listener Callback to invoke on value change
   * @param fireImmediately If true, fires the listener immediately with current value
   * @returns Function to unsubscribe
   */
  listen(listener: ObservableListener<T>, fireImmediately = false): Unlisten {
    if (fireImmediately) {
      listener(this._value, this._value)
    }

    this._listeners.push(listener)

    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener)
    }
  }

  /**
   * Wait until the value satisfies a predicate
   *
   * @param predicate Function that returns true when condition is met
   * @param timeoutMs Optional timeout in milliseconds
   * @returns Promise that resolves with the value when predicate is satisfied
   * @throws Error if timeout is reached
   */
  waitUntil(predicate: ObservablePredicate<T>, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let unlisten: Unlisten | undefined
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      // Set up timeout if specified
      if (timeoutMs !== undefined) {
        timeoutId = setTimeout(() => {
          unlisten?.()
          reject(new Error('Timeout exceeded waiting for observable condition'))
        }, timeoutMs)
      }

      // Listen for changes (including checking current value)
      unlisten = this.listen((value) => {
        if (predicate(value)) {
          if (timeoutId) {
            clearTimeout(timeoutId)
          }
          unlisten?.()
          resolve(value)
        }
      }, true) // Fire immediately to check current value
    })
  }

  /**
   * Dispose the observable (clear all listeners)
   */
  dispose(): void {
    this._listeners = []
  }

  /**
   * Get the number of active listeners
   */
  get listenerCount(): number {
    return this._listeners.length
  }

  /**
   * Create a computed observable that updates when dependencies change
   *
   * @example
   * ```typescript
   * const firstName = new Observable('John')
   * const lastName = new Observable('Doe')
   *
   * const fullName = Observable.watch(
   *   (first, last) => `${first} ${last}`,
   *   firstName,
   *   lastName
   * )
   *
   * console.log(fullName.value) // "John Doe"
   *
   * lastName.value = 'Smith'
   * console.log(fullName.value) // "John Smith"
   * ```
   */
  static watch<TArgs extends unknown[], TResult>(
    computeFn: (...args: TArgs) => TResult,
    ...observables: { [K in keyof TArgs]: Observable<TArgs[K]> }
  ): Observable<TResult> {
    // Compute initial value
    const getValues = () => observables.map((o) => o.value) as TArgs
    const initialValue = computeFn(...getValues())

    // Create the computed observable
    const computed = new Observable<TResult>(initialValue)

    // Track unlisteners for cleanup
    const unlisteners: Unlisten[] = []

    // Listen to each dependency
    for (const observable of observables) {
      const unlisten = observable.listen(() => {
        computed.value = computeFn(...getValues())
      })
      unlisteners.push(unlisten)
    }

    // Override dispose to also unlisten from dependencies
    const originalDispose = computed.dispose.bind(computed)
    computed.dispose = () => {
      for (const unlisten of unlisteners) {
        unlisten()
      }
      originalDispose()
    }

    return computed
  }

  /**
   * Create a mapped observable that transforms values
   *
   * @example
   * ```typescript
   * const count = new Observable(5)
   * const doubled = count.map(x => x * 2)
   *
   * console.log(doubled.value) // 10
   *
   * count.value = 10
   * console.log(doubled.value) // 20
   * ```
   */
  map<U>(transform: (value: T) => U): Observable<U> {
    return Observable.watch(transform, this)
  }

  /**
   * Create a filtered observable that only updates when predicate is true
   */
  filter(predicate: ObservablePredicate<T>): Observable<T | undefined> {
    const filtered = new Observable<T | undefined>(
      predicate(this._value) ? this._value : undefined
    )

    const unlisten = this.listen((value) => {
      if (predicate(value)) {
        filtered.value = value
      }
    })

    const originalDispose = filtered.dispose.bind(filtered)
    filtered.dispose = () => {
      unlisten()
      originalDispose()
    }

    return filtered
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a readonly observable wrapper
 */
export interface ReadonlyObservable<T> {
  readonly value: T
  listen(listener: ObservableListener<T>, fireImmediately?: boolean): Unlisten
  waitUntil(predicate: ObservablePredicate<T>, timeoutMs?: number): Promise<T>
}

/**
 * Create a readonly view of an observable
 */
export function asReadonly<T>(observable: Observable<T>): ReadonlyObservable<T> {
  return {
    get value() {
      return observable.value
    },
    listen: (listener, fireImmediately) => observable.listen(listener, fireImmediately),
    waitUntil: (predicate, timeoutMs) => observable.waitUntil(predicate, timeoutMs),
  }
}

/**
 * Combine multiple observables into a single observable of tuple
 *
 * @example
 * ```typescript
 * const a = new Observable(1)
 * const b = new Observable('hello')
 *
 * const combined = combineObservables(a, b)
 * console.log(combined.value) // [1, 'hello']
 * ```
 */
export function combineObservables<T extends unknown[]>(
  ...observables: { [K in keyof T]: Observable<T[K]> }
): Observable<T> {
  return Observable.watch((...values) => values as T, ...observables)
}

/**
 * Create an observable from a promise
 */
export function observableFromPromise<T>(
  promise: Promise<T>,
  initialValue: T
): Observable<T> {
  const observable = new Observable<T>(initialValue)

  promise.then((value) => {
    observable.value = value
  }).catch(() => {
    // Keep initial value on error
  })

  return observable
}

/**
 * Deep equality function for objects
 */
export function deepEqual<T>(a: T, b: T): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false

  const keysA = Object.keys(a as object)
  const keysB = Object.keys(b as object)

  if (keysA.length !== keysB.length) return false

  for (const key of keysA) {
    if (!keysB.includes(key)) return false
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false
    }
  }

  return true
}
