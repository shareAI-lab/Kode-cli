/**
 * IgnoreRulesManager - Gitignore-style pattern matching for file filtering
 *
 * Migrated from AgentTool/08-IgnoreRulesManager
 *
 * Features:
 * - Complete .gitignore/.augmentignore support
 * - Pattern prefixing for nested directories
 * - LRU cache for ignore decisions
 * - Directory descent optimization
 */

import * as fs from 'fs/promises'
import * as path from 'path'

// ============================================================================
// Types
// ============================================================================

export type Pathname = string

export interface TestResult {
  ignored: boolean
  unignored: boolean
}

export interface IgnoreInstance {
  add(patterns: string | IgnoreInstance | readonly (string | IgnoreInstance)[]): IgnoreInstance
  addPatterns(patterns: string[]): void
  filter(pathnames: readonly Pathname[]): Pathname[]
  createFilter(): (pathname: Pathname) => boolean
  ignores(pathname: Pathname): boolean
  test(pathname: Pathname): TestResult
  mergeRulesFrom(other: IgnoreInstance): IgnoreInstance
}

interface CacheEntry {
  lastReadTime: number | undefined
  content: string | undefined
}

interface IgnoreObjectsCacheEntry {
  ignoreObj: IgnoreInstance
  lastReadTime: number
}

// ============================================================================
// Ignore Pattern Engine (node-ignore compatible)
// ============================================================================

type Replacer = [RegExp, (...args: any[]) => string]

function makeArray<T>(subject: T | readonly T[]): T[] {
  return Array.isArray(subject) ? (subject as T[]) : [subject as T]
}

const EMPTY = ''
const SPACE = ' '
const ESCAPE = '\\'
const REGEX_TEST_BLANK_LINE = /^\s+$/
const REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/
const REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/
const REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/
const REGEX_SPLITALL_CRLF = /\r?\n/g
const REGEX_TEST_INVALID_PATH = /^\.*\/|^\.+$/
const SLASH = '/'

let KEY_IGNORE: string | symbol = 'node-ignore'
if (typeof Symbol !== 'undefined') {
  KEY_IGNORE = Symbol.for('node-ignore')
}

const define = (object: object, key: PropertyKey, value: unknown): void => {
  Object.defineProperty(object, key, { value })
}

const REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g
const RETURN_FALSE = () => false

const sanitizeRange = (range: string): string =>
  range.replace(REGEX_REGEXP_RANGE, (match: string, from: string, to: string) =>
    from.charCodeAt(0) <= to.charCodeAt(0) ? match : EMPTY
  )

const cleanRangeBackSlash = (slashes: string): string => {
  const { length } = slashes
  return slashes.slice(0, length - (length % 2))
}

const REPLACERS: Replacer[] = [
  [/\\?\s+$/, (match: string) => (match.indexOf('\\') === 0 ? SPACE : EMPTY)],
  [/\\\s/g, () => SPACE],
  [/[\\$.|*+(){^]/g, (match: string) => `\\${match}`],
  [/(?!\\)\?/g, () => '[^/]'],
  [/^\//, () => '^'],
  [/\//g, () => '\\/'],
  [/^\^*\\\*\\\*\\\//, () => '^(?:.*\\/)?'],
  [
    /^(?=[^^])/,
    function startingReplacer(this: string): string {
      return !/\/(?!$)/.test(this) ? '(?:^|\\/)' : '^'
    },
  ],
  [
    /\\\/\\\*\\\*(?=\\\/|$)/g,
    (_: string, index: number, str: string) =>
      index + 6 < str.length ? '(?:\\/[^\\/]+)*' : '\\/.+',
  ],
  [
    /(^|[^\\]+)(\\\*)+(?=.+)/g,
    (_: string, p1: string, p2: string) => {
      const unescaped = p2.replace(/\\\*/g, '[^\\/]*')
      return p1 + unescaped
    },
  ],
  [/\\\\\\(?=[$.|*+(){^])/g, () => ESCAPE],
  [/\\\\/g, () => ESCAPE],
  [
    /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
    (
      match: string,
      leadEscape: string | undefined,
      range: string,
      endEscape: string,
      close: string
    ) =>
      leadEscape === ESCAPE
        ? `\\[${range}${cleanRangeBackSlash(endEscape)}${close}`
        : close === ']'
          ? endEscape.length % 2 === 0
            ? `[${sanitizeRange(range)}${endEscape}]`
            : '[]'
          : '[]',
  ],
  [
    /(?:[^*])$/,
    (match: string) =>
      /\/$/.test(match) ? `${match}(?:$|.*)` : `${match}(?=$|\\/$)`,
  ],
  [
    /(\^|\\\/)?\\\*$/,
    (_: string, p1: string | undefined) => {
      const prefix = p1 ? `${p1}[^/]+` : '[^/]*'
      return `${prefix}(?=$|\\/$)`
    },
  ],
]

const regexCache = Object.create(null) as Record<string, string>

const makeRegex = (pattern: string, ignoreCase: boolean): RegExp => {
  let source = regexCache[pattern]
  if (!source) {
    source = REPLACERS.reduce<string>(
      (prev, current) => prev.replace(current[0], current[1].bind(pattern)),
      pattern
    )
    regexCache[pattern] = source
  }
  return ignoreCase ? new RegExp(source, 'i') : new RegExp(source)
}

const isString = (subject: unknown): subject is string => typeof subject === 'string'

const checkPattern = (pattern: unknown): pattern is string =>
  Boolean(
    pattern &&
      isString(pattern) &&
      !REGEX_TEST_BLANK_LINE.test(pattern) &&
      !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) &&
      pattern.indexOf('#') !== 0
  )

const splitPattern = (pattern: string): string[] => pattern.split(REGEX_SPLITALL_CRLF)

class IgnoreRule {
  constructor(
    public origin: string,
    public pattern: string,
    public negative: boolean,
    public regex: RegExp
  ) {}
}

const createRule = (pattern: string, ignoreCase: boolean): IgnoreRule => {
  const origin = pattern
  let negative = false

  if (pattern.indexOf('!') === 0) {
    negative = true
    pattern = pattern.substr(1)
  }

  pattern = pattern
    .replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, '!')
    .replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, '#')

  const regex = makeRegex(pattern, ignoreCase)
  return new IgnoreRule(origin, pattern, negative, regex)
}

const throwError = (message: string, Ctor: new (message: string) => Error): never => {
  throw new Ctor(message)
}

type DoThrow = (message: string, Ctor: new (message: string) => Error) => boolean | never

type CheckPathFn = ((path: unknown, originalPath: unknown, doThrow: DoThrow) => boolean) & {
  isNotRelative: (path: string) => boolean
  convert: (p: unknown) => string
}

const checkPath: CheckPathFn = ((
  path: unknown,
  originalPath: unknown,
  doThrow: DoThrow
): boolean => {
  if (!isString(path)) {
    return doThrow(`path must be a string, but got \`${originalPath}\``, TypeError) as boolean
  }
  if (!path) {
    return doThrow('path must not be empty', TypeError) as boolean
  }
  if (checkPath.isNotRelative(path)) {
    const r = '`path.relative()`d'
    return doThrow(`path should be a ${r} string, but got "${originalPath}"`, RangeError) as boolean
  }
  return true
}) as CheckPathFn

const isNotRelative = (path: string): boolean => REGEX_TEST_INVALID_PATH.test(path)
checkPath.isNotRelative = isNotRelative
checkPath.convert = (p: any): string => p

/**
 * Core Ignore class implementing gitignore-style pattern matching
 */
class Ignore implements IgnoreInstance {
  private _rules: IgnoreRule[][]
  private _ignoreCase: boolean
  private _allowRelativePaths: boolean
  private _ignoreCache!: Record<string, TestResult>
  private _added = false

  constructor(options: { ignoreCase?: boolean; allowRelativePaths?: boolean } = {}) {
    define(this, KEY_IGNORE, true)
    this._rules = [[]]
    this._ignoreCase = options.ignoreCase ?? true
    this._allowRelativePaths = options.allowRelativePaths ?? false
    this._initCache()
  }

  private _initCache(): void {
    this._ignoreCache = Object.create(null) as Record<string, TestResult>
  }

  private _addPattern(pattern: unknown): void {
    if (this._isIgnoreInstance(pattern)) {
      this.mergeRulesFrom(pattern as IgnoreInstance)
      this._added = true
      return
    }
    if (checkPattern(pattern)) {
      const rule = createRule(pattern, this._ignoreCase)
      this._added = true
      const currentIndex = this._rules.length - 1
      this._rules[currentIndex].push(rule)
    }
  }

  private _isIgnoreInstance(value: unknown): boolean {
    return value !== null && typeof value === 'object' && KEY_IGNORE in value
  }

  add(pattern: string | IgnoreInstance | readonly (string | IgnoreInstance)[]): IgnoreInstance {
    this._added = false
    makeArray(isString(pattern) ? splitPattern(pattern) : pattern).forEach(this._addPattern, this)
    if (this._added) {
      this._initCache()
    }
    return this
  }

  addPatterns(patterns: string[]) {
    this._added = false
    const newRules: IgnoreRule[] = []
    for (const pattern of patterns) {
      if (checkPattern(pattern)) {
        const rule = createRule(pattern, this._ignoreCase)
        this._added = true
        newRules.push(rule)
      }
    }
    if (newRules.length > 0) {
      const currentIndex = this._rules.length - 1
      this._rules[currentIndex].push(...newRules)
    }
    return this
  }

  mergeRulesFrom(other: IgnoreInstance): IgnoreInstance {
    const otherIgnore = other as Ignore
    if (otherIgnore._rules && otherIgnore._rules.length > 0) {
      this._rules = this._rules.concat(otherIgnore._rules)
      this._initCache()
    }
    return this
  }

  private _testOne(path: string, _checkUnignored: boolean): TestResult {
    let ignored = false
    let unignored = false
    const localRegexCache = new Map<RegExp, boolean>()

    for (const ruleList of this._rules) {
      let ruleMatched = false
      for (const rule of ruleList) {
        const { negative, regex } = rule
        let matched: boolean
        if (localRegexCache.has(regex)) {
          matched = localRegexCache.get(regex)!
        } else {
          matched = regex.test(path)
          localRegexCache.set(regex, matched)
        }
        if (matched) {
          ignored = !negative
          unignored = negative
          ruleMatched = true
        }
      }
      if (ruleMatched) {
        return { ignored, unignored }
      }
    }
    return { ignored, unignored }
  }

  private _test(
    originalPath: Pathname,
    cache: Record<string, TestResult>,
    checkUnignored: boolean
  ): TestResult {
    const pathStr = originalPath ? checkPath.convert(originalPath) : ''
    checkPath(pathStr, originalPath, this._allowRelativePaths ? RETURN_FALSE : throwError)
    if (pathStr in cache) {
      return cache[pathStr]
    }
    const result = this._testOne(pathStr, checkUnignored)
    cache[pathStr] = result
    return result
  }

  ignores(path: Pathname): boolean {
    return this._test(path, this._ignoreCache, false).ignored
  }

  createFilter(): (pathname: Pathname) => boolean {
    return (path: Pathname) => !this.ignores(path)
  }

  filter(paths: readonly Pathname[]): Pathname[] {
    return makeArray(paths).filter(this.createFilter())
  }

  test(path: Pathname): TestResult {
    return this._test(path, this._ignoreCache, true)
  }
}

/**
 * Factory function to create Ignore instances
 */
export function createIgnore(options?: { ignoreCase?: boolean; allowRelativePaths?: boolean }): IgnoreInstance {
  return new Ignore(options)
}

// ============================================================================
// Ignore Cache
// ============================================================================

/**
 * IgnoreCache - TTL-based caching for ignore files and parsed objects
 */
export class IgnoreCache {
  private static readonly TTL_MS = 5 * 60 * 1000 // 5 minutes
  private cache = new Map<string, CacheEntry>()
  private ignoreObjectsCache = new Map<string, IgnoreObjectsCacheEntry>()

  async exists(filePath: string): Promise<boolean> {
    const entry = await this.getCachedOrFetch(filePath)
    return entry.content !== undefined
  }

  async read(filePath: string, _encoding?: string): Promise<string> {
    const entry = await this.getCachedOrFetch(filePath)
    if (entry.content === undefined) {
      throw new Error(`File not found: ${filePath}`)
    }
    return entry.content
  }

  private async getCachedOrFetch(filePath: string): Promise<CacheEntry> {
    const now = Date.now()
    const cached = this.cache.get(filePath)

    if (cached && cached.lastReadTime && now - cached.lastReadTime < IgnoreCache.TTL_MS) {
      return cached
    }

    let content: string | undefined
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch {
      content = undefined
    }

    const entry: CacheEntry = { lastReadTime: now, content }
    this.cache.set(filePath, entry)
    return entry
  }

  getIgnoreObjects(dirPath: string): IgnoreObjectsCacheEntry | undefined {
    const cached = this.ignoreObjectsCache.get(dirPath)
    if (!cached) return undefined

    const now = Date.now()
    if (now - cached.lastReadTime >= IgnoreCache.TTL_MS) {
      this.ignoreObjectsCache.delete(dirPath)
      return undefined
    }
    return cached
  }

  setIgnoreObjects(dirPath: string, ignoreObj: IgnoreInstance): void {
    this.ignoreObjectsCache.set(dirPath, {
      ignoreObj,
      lastReadTime: Date.now(),
    })
  }

  clear(): void {
    this.cache.clear()
    this.ignoreObjectsCache.clear()
  }
}

// ============================================================================
// Path utilities
// ============================================================================

function basename(filepath: string): string {
  const lastSlash = filepath.lastIndexOf('/')
  return lastSlash === -1 ? filepath : filepath.slice(lastSlash + 1)
}

function dirname(filepath: string): string {
  const lastSlash = filepath.lastIndexOf('/')
  if (lastSlash === -1) return ''
  return filepath.slice(0, lastSlash)
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

// ============================================================================
// IgnoreRulesManager
// ============================================================================

/**
 * IgnoreRulesManager - Manages .gitignore and .augmentignore rules
 *
 * Supports:
 * - Hierarchical rule inheritance from parent directories
 * - Pattern prefixing for nested directories
 * - .augmentignore with higher precedence than .gitignore
 */
export class IgnoreRulesManager {
  static cache = new IgnoreCache()

  /**
   * Prefix a pattern based on the directory path
   */
  static prefixPattern(line: string, dirPath: string): string {
    if (dirPath.endsWith('/')) {
      dirPath = dirPath.slice(0, -1)
    }

    // Negation patterns
    if (line.startsWith('!')) {
      const pattern = line.substring(1)
      if (pattern.startsWith('/')) {
        return '!' + dirPath + pattern
      }
      return '!' + dirPath + '/**/' + pattern
    }

    // Anchored patterns
    if (line.startsWith('/')) {
      return dirPath + line
    }

    // Regular patterns
    return dirPath + '/**/' + line
  }

  /**
   * Parse ignore rules from file content
   */
  static parseIgnoreRules(content: string, dirPath: string): string[] {
    const lines = content
      .split('\n')
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .filter((line) => line.trim() && !line.trim().startsWith('#'))

    if (dirPath === '') {
      return lines
    }

    return lines.map((line) => this.prefixPattern(line, dirPath))
  }

  /**
   * Get or build accumulated ignore objects for a directory
   */
  static async getOrBuildIgnoreObjects(
    walkRoot: string,
    dirPath: string
  ): Promise<{ ignoreObj: IgnoreInstance }> {
    if (dirPath === '.') {
      dirPath = ''
    }

    const cacheKey = walkRoot + '#' + dirPath
    const cached = this.cache.getIgnoreObjects(cacheKey)
    if (cached) {
      return { ignoreObj: cached.ignoreObj }
    }

    // Build ignore objects
    const augmentignorePath = join(walkRoot, dirPath, '.augmentignore')
    const gitignorePath = join(walkRoot, dirPath, '.gitignore')

    let dirIgnoreObj = createIgnore()
    const ruleList: string[] = []

    // Read .gitignore
    if (await this.cache.exists(gitignorePath)) {
      const gitignoreContent = await this.cache.read(gitignorePath, 'utf8')
      ruleList.push(...this.parseIgnoreRules(gitignoreContent, dirPath))
    }

    // Read .augmentignore (higher precedence)
    if (await this.cache.exists(augmentignorePath)) {
      const augmentignoreContent = await this.cache.read(augmentignorePath, 'utf8')
      ruleList.push(...this.parseIgnoreRules(augmentignoreContent, dirPath))
    }

    dirIgnoreObj.addPatterns(ruleList)

    // Inherit from parent
    if (dirPath !== '') {
      const pieces = dirPath.split('/').filter(Boolean)
      const parentDirPath = pieces.slice(0, -1).join('/')
      const parentResult = await this.getOrBuildIgnoreObjects(walkRoot, parentDirPath)
      if (parentResult && parentResult.ignoreObj) {
        dirIgnoreObj.mergeRulesFrom(parentResult.ignoreObj)
      }
    }

    this.cache.setIgnoreObjects(cacheKey, dirIgnoreObj)
    return { ignoreObj: dirIgnoreObj }
  }

  /**
   * Check if a file is ignored
   */
  static async isIgnored(walkRoot: string, filepath: string): Promise<boolean> {
    if (filepath === '.') return false
    const dirPath = dirname(filepath)
    const { ignoreObj } = await this.getOrBuildIgnoreObjects(walkRoot, dirPath)
    return ignoreObj.ignores(filepath)
  }

  /**
   * Check if traversal should descend into a directory
   */
  static async shouldDescend(walkRoot: string, filepath: string): Promise<boolean> {
    if (!filepath || filepath === '.') {
      return true
    }

    const name = basename(filepath)
    if (name === '.git') {
      return false
    }

    const { ignoreObj } = await this.getOrBuildIgnoreObjects(walkRoot, filepath)
    const normalizedPath = filepath.endsWith('/') ? filepath : `${filepath}/`
    const { ignored, unignored } = ignoreObj.test(normalizedPath)

    return !ignored || unignored
  }
}
