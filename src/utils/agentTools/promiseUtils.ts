/**
 * Promise Utilities - Retry, backoff, and async helpers
 *
 * Migrated from AgentTool/10-UtilityTools/promise-utils.ts
 *
 * Features:
 * - Exponential backoff retry
 * - DeferredPromise for external resolution
 * - Timeout wrapper
 * - Concurrent execution helpers
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for exponential backoff retry
 */
export interface BackoffParams {
  /** Initial delay in milliseconds */
  initialMS: number
  /** Multiplier for each retry */
  mult: number
  /** Maximum delay in milliseconds */
  maxMS: number
  /** Maximum number of retries */
  maxTries?: number
  /** Maximum total time in milliseconds */
  maxTotalMs?: number
  /** Custom function to determine if an error is retryable */
  canRetry?: (error: unknown) => boolean
}

/**
 * Result of a retry backoff decision
 */
export type RetryBackoffResult =
  | { shouldRetry: false }
  | { shouldRetry: true; backoffMs: number }

/**
 * Parameters for custom retry logic
 */
export interface RetryParams {
  /** Maximum number of retries */
  maxTries?: number
  /** Maximum total time in milliseconds */
  maxTotalMs?: number
  /** Function to determine if and how long to wait before retrying */
  getBackoffFn: (
    error: unknown,
    currentBackoffMs: number,
    currentTryCount: number
  ) => RetryBackoffResult
}

/**
 * Logger interface for retry operations
 */
export interface RetryLogger {
  info(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

// ============================================================================
// Default Backoff Parameters
// ============================================================================

export const defaultBackoffParams: BackoffParams = {
  initialMS: 100,
  mult: 2,
  maxMS: 30000,
}

// ============================================================================
// Basic Utilities
// ============================================================================

/**
 * Delay for a specified number of milliseconds
 *
 * @example
 * ```typescript
 * await delayMs(1000) // Wait 1 second
 * ```
 */
export function delayMs(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create a promise that rejects after a timeout
 */
export function timeoutPromise(ms: number, message?: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(message ?? `Timeout after ${ms}ms`))
    }, ms)
  })
}

// ============================================================================
// Retry with Backoff
// ============================================================================

/**
 * Default function to check if an error is retryable
 * By default, retries network errors and 5xx status codes
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    // Network errors
    if (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('socket hang up')
    ) {
      return true
    }
  }

  // Check for HTTP status codes (if error has status property)
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: number }).status
    if (typeof status === 'number' && status >= 500 && status < 600) {
      return true
    }
  }

  return false
}

/**
 * Retry a function with exponential backoff
 *
 * @example
 * ```typescript
 * const result = await retryWithBackoff(
 *   async () => {
 *     const response = await fetch('https://api.example.com/data')
 *     if (!response.ok) throw new Error('Request failed')
 *     return response.json()
 *   },
 *   console,
 *   { initialMS: 100, mult: 2, maxMS: 10000, maxTries: 3 }
 * )
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  logger?: RetryLogger,
  backoffParams: BackoffParams = defaultBackoffParams
): Promise<T> {
  const canRetryFn = backoffParams.canRetry ?? isRetryableError

  const getBackoffFn = (
    error: unknown,
    backoffMs: number,
    _tryCount: number
  ): RetryBackoffResult => {
    if (!canRetryFn(error)) {
      return { shouldRetry: false }
    }

    let newBackoffMs: number
    if (backoffMs === 0) {
      newBackoffMs = backoffParams.initialMS
    } else {
      newBackoffMs = Math.min(backoffMs * backoffParams.mult, backoffParams.maxMS)
    }

    return { shouldRetry: true, backoffMs: newBackoffMs }
  }

  const retryParams: RetryParams = {
    maxTries: backoffParams.maxTries,
    maxTotalMs: backoffParams.maxTotalMs,
    getBackoffFn,
  }

  return retryWithTimes(fn, logger, retryParams)
}

/**
 * Retry a function with custom retry logic
 */
export async function retryWithTimes<T>(
  fn: () => Promise<T>,
  logger?: RetryLogger,
  retryParams: RetryParams = { getBackoffFn: () => ({ shouldRetry: false }) }
): Promise<T> {
  let backoffMs = 0
  const startTime = Date.now()

  for (let tries = 0; ; tries++) {
    try {
      const result = await fn()
      if (tries > 0 && logger) {
        logger.info(`Operation succeeded after ${tries} transient failures`)
      }
      return result
    } catch (error) {
      const currentTryCount = tries + 1

      // Check if we have exceeded max retries
      if (retryParams.maxTries !== undefined && currentTryCount >= retryParams.maxTries) {
        throw error
      }

      // Compute whether to retry and backoff duration
      const backoffResult = retryParams.getBackoffFn(error, backoffMs, currentTryCount)
      if (!backoffResult.shouldRetry) {
        throw error
      }

      backoffMs = backoffResult.backoffMs

      if (logger) {
        logger.info(
          `Operation failed with error: ${String(error)}, retrying in ${backoffMs}ms (attempt ${tries + 1})`
        )
      }

      // Check if backoff will exceed total time
      if (
        retryParams.maxTotalMs !== undefined &&
        Date.now() - startTime + backoffMs > retryParams.maxTotalMs
      ) {
        throw error
      }

      await delayMs(backoffMs)
    }
  }
}

// ============================================================================
// Deferred Promise
// ============================================================================

/**
 * A promise that can be resolved or rejected from outside
 *
 * @example
 * ```typescript
 * const deferred = new DeferredPromise<string>()
 *
 * // Later...
 * deferred.resolve('hello')
 *
 * // Or handle as a promise
 * const result = await deferred
 * ```
 */
export class DeferredPromise<T> implements Promise<T> {
  private _promise: Promise<T>
  private _resolve!: (value: T | PromiseLike<T>) => void
  private _reject!: (reason?: unknown) => void
  private _isSettled = false

  constructor() {
    this._promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject
    })
  }

  /**
   * Check if the promise has been resolved or rejected
   */
  get isSettled(): boolean {
    return this._isSettled
  }

  /**
   * Resolve the promise with a value
   */
  resolve(value: T | PromiseLike<T>): void {
    if (this._isSettled) return
    this._isSettled = true
    this._resolve(value)
  }

  /**
   * Reject the promise with a reason
   */
  reject(reason?: unknown): void {
    if (this._isSettled) return
    this._isSettled = true
    this._reject(reason)
  }

  // Promise interface implementation
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this._promise.then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult> {
    return this._promise.catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this._promise.finally(onfinally)
  }

  get [Symbol.toStringTag](): string {
    return 'DeferredPromise'
  }
}

// ============================================================================
// Timeout Wrapper
// ============================================================================

/**
 * Execute an async function with a timeout
 *
 * @example
 * ```typescript
 * try {
 *   const result = await withTimeout(
 *     fetch('https://api.example.com/slow'),
 *     5000 // 5 second timeout
 *   )
 * } catch (error) {
 *   console.log('Request timed out')
 * }
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage?: string
): Promise<T> {
  return Promise.race([promise, timeoutPromise(timeoutMs, timeoutMessage)])
}

/**
 * Execute a function with a timeout
 */
export async function withTimeoutFn<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage?: string
): Promise<T> {
  return withTimeout(fn(), timeoutMs, timeoutMessage)
}

// ============================================================================
// Concurrent Execution Helpers
// ============================================================================

/**
 * Execute promises with concurrency limit
 *
 * @example
 * ```typescript
 * const urls = ['url1', 'url2', 'url3', 'url4', 'url5']
 * const results = await parallelLimit(
 *   urls.map(url => () => fetch(url)),
 *   2 // Max 2 concurrent requests
 * )
 * ```
 */
export async function parallelLimit<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = []
  const executing: Promise<void>[] = []

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    const promise = (async () => {
      results[i] = await task()
    })()

    executing.push(promise)

    if (executing.length >= concurrency) {
      await Promise.race(executing)
      // Remove completed promises
      for (let j = executing.length - 1; j >= 0; j--) {
        // Check if promise is settled by racing with a resolved promise
        const settled = await Promise.race([
          executing[j].then(() => true),
          Promise.resolve(false),
        ])
        if (settled) {
          executing.splice(j, 1)
        }
      }
    }
  }

  await Promise.all(executing)
  return results
}

/**
 * Execute all promises and collect results/errors
 * Similar to Promise.allSettled but with a simpler return type
 */
export async function allSettledSimple<T>(
  promises: Promise<T>[]
): Promise<{ fulfilled: T[]; rejected: unknown[] }> {
  const results = await Promise.allSettled(promises)

  const fulfilled: T[] = []
  const rejected: unknown[] = []

  for (const result of results) {
    if (result.status === 'fulfilled') {
      fulfilled.push(result.value)
    } else {
      rejected.push(result.reason)
    }
  }

  return { fulfilled, rejected }
}

/**
 * Race promises with a timeout
 */
export async function raceWithTimeout<T>(
  promises: Promise<T>[],
  timeoutMs: number,
  timeoutMessage?: string
): Promise<T> {
  return Promise.race([...promises, timeoutPromise(timeoutMs, timeoutMessage)])
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a value is a promise
 */
export function isPromise<T>(value: unknown): value is Promise<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as Promise<T>).then === 'function'
  )
}

/**
 * Ignore errors from a promise (useful for cleanup)
 */
export async function ignoreError<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise
  } catch {
    return undefined
  }
}

/**
 * Convert a callback-style function to a promise
 */
export function promisify<T>(
  fn: (...args: [...unknown[], (error: Error | null, result?: T) => void]) => void
): (...args: unknown[]) => Promise<T> {
  return (...args: unknown[]) => {
    return new Promise<T>((resolve, reject) => {
      fn(...args, (error: Error | null, result?: T) => {
        if (error) {
          reject(error)
        } else {
          resolve(result as T)
        }
      })
    })
  }
}

/**
 * Create a debounced async function
 */
export function debounceAsync<T extends (...args: Parameters<T>) => Promise<ReturnType<T>>>(
  fn: T,
  delayMs: number
): T {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let pendingPromise: DeferredPromise<ReturnType<T>> | undefined

  return ((...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }

    if (!pendingPromise) {
      pendingPromise = new DeferredPromise<ReturnType<T>>()
    }

    const currentPending = pendingPromise

    timeoutId = setTimeout(async () => {
      pendingPromise = undefined
      try {
        const result = await fn(...args)
        currentPending.resolve(result)
      } catch (error) {
        currentPending.reject(error)
      }
    }, delayMs)

    return currentPending as Promise<ReturnType<T>>
  }) as T
}
