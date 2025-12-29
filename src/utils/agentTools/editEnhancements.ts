/**
 * Edit Enhancements - Integrated from AgentTool
 * Provides fuzzy matching, line number tolerance, and advanced edit utilities
 */

import { debug } from '@utils/debugLogger'

// Helper for logging
const log = (msg: string) => debug.trace('edit', msg)

// ============================================================================
// Types
// ============================================================================

export interface Match {
  startLine: number
  endLine: number
}

export interface EditResult {
  isError: boolean
  genMessageFunc?: (result: EditResult) => string
  oldStr: string
  oldStrStartLineNumber?: number
  oldStrEndLineNumber?: number
  newContent?: string
  newStr?: string
  newStrStartLineNumber?: number
  newStrEndLineNumber?: number
  numLinesDiff: number
  linesAdded: number
  linesDeleted: number
  index: number
  wasReformattedByIDE?: boolean
}

export interface IndentInfo {
  type: 'space' | 'tab'
  size: number
}

export enum MatchFailReason {
  ExceedsMaxDiff = 'ExceedsMaxDiff',
  ExceedsMaxDiffRatio = 'ExceedsMaxDiffRatio',
  FirstSymbolOfOldStrNotInOriginal = 'FirstSymbolOfOldStrNotInOriginal',
  LastSymbolOfOldStrNotInOriginal = 'LastSymbolOfOldStrNotInOriginal',
  SymbolInOldNotInOriginalOrNew = 'SymbolInOldNotInOriginalOrNew',
  AmbiguousReplacement = 'AmbiguousReplacement',
}

// ============================================================================
// Text Processing Utilities
// ============================================================================

/**
 * Removes trailing whitespace from each line while preserving line endings
 */
export function removeTrailingWhitespace(text: string): string {
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(lineEnding)
  const trimmedLines = lines.map(line => line.replace(/\s+$/, ''))
  return trimmedLines.join(lineEnding)
}

/**
 * Normalizes line endings to \n
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/**
 * Detects line ending type
 */
export function detectLineEnding(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Restores original line endings
 */
export function restoreLineEndings(text: string, originalLineEnding: string): string {
  if (originalLineEnding === '\r\n') {
    return text.replace(/\n/g, '\r\n')
  }
  return text
}

/**
 * Prepares text for editing by normalizing line endings and removing trailing whitespace
 */
export function prepareTextForEditing(text: string): {
  content: string
  originalLineEnding: string
} {
  const originalLineEnding = detectLineEnding(text)
  const content = normalizeLineEndings(removeTrailingWhitespace(text))
  return { content, originalLineEnding }
}

// ============================================================================
// Indentation Detection and Handling
// ============================================================================

/**
 * Detects the indentation type used in a string
 */
export function detectIndentation(content: string): IndentInfo {
  const lines = content.split('\n')
  let spaceIndents = 0
  let tabIndents = 0
  let spaceSize = 0

  for (const line of lines) {
    if (line.trim() === '') continue

    const leadingSpaces = line.match(/^( +)/)
    const leadingTabs = line.match(/^(\t+)/)

    if (leadingSpaces) {
      spaceIndents++
      if (spaceSize === 0) {
        spaceSize = leadingSpaces[1].length
      }
    } else if (leadingTabs) {
      tabIndents++
    }
  }

  if (tabIndents > spaceIndents) {
    return { type: 'tab', size: 1 }
  }
  return { type: 'space', size: spaceSize || 2 }
}

/**
 * Removes one level of indentation from each line
 */
export function removeOneIndentLevel(text: string, indentation: IndentInfo): string {
  const lines = text.split('\n')
  const pattern = indentation.type === 'tab'
    ? /^\t/
    : new RegExp(`^ {1,${indentation.size}}`)

  return lines.map(line => line.replace(pattern, '')).join('\n')
}

/**
 * Checks if all non-empty lines have indentation
 */
export function allLinesHaveIndent(text: string, indentation: IndentInfo): boolean {
  const lines = text.split('\n')
  return lines.every(line => {
    if (line.trim() === '') return true
    const pattern = indentation.type === 'tab'
      ? /^\t/
      : new RegExp(`^ {1,${indentation.size}}`)
    return line.match(pattern) !== null
  })
}

/**
 * Removes all indentation from text
 */
export function removeAllIndents(text: string): string {
  const lineEnding = detectLineEnding(text)
  return text
    .split(lineEnding)
    .map(line => line.trim())
    .join(lineEnding)
}

// ============================================================================
// Match Finding
// ============================================================================

/**
 * Find all matches of a string in content
 */
export function findMatches(content: string, str: string): Match[] {
  const contentLines = content.split('\n')
  const strLines = str.split('\n')
  const matches: Match[] = []

  if (str.trim() === '' || strLines.length > contentLines.length) {
    return matches
  }

  // Single line search
  if (strLines.length === 1) {
    contentLines.forEach((line, index) => {
      if (line.includes(str)) {
        matches.push({ startLine: index, endLine: index })
      }
    })
    return matches
  }

  // Multi-line search
  const contentText = content
  const searchText = str
  let startIndex = 0
  let foundIndex: number

  while ((foundIndex = contentText.indexOf(searchText, startIndex)) !== -1) {
    const textBeforeMatch = contentText.substring(0, foundIndex)
    const textUpToEndOfMatch = contentText.substring(0, foundIndex + searchText.length)

    const startLine = (textBeforeMatch.match(/\n/g) || []).length
    const endLine = (textUpToEndOfMatch.match(/\n/g) || []).length

    matches.push({ startLine, endLine })
    startIndex = foundIndex + 1
  }

  return matches
}

/**
 * Find the closest match to target line numbers using tolerance
 */
export function findClosestMatch(
  matches: Match[],
  targetStartLine: number,
  targetEndLine: number,
  lineNumberErrorTolerance: number
): number {
  if (matches.length === 0) return -1
  if (matches.length === 1) return 0

  // Look for exact matches first
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    if (match.startLine === targetStartLine && match.endLine === targetEndLine) {
      return i
    }
  }

  if (lineNumberErrorTolerance === 0) {
    return -1
  }

  // Find closest match
  let closestIndex = -1
  let minDistance = Number.MAX_SAFE_INTEGER

  for (let i = 0; i < matches.length; i++) {
    const distance = Math.abs(matches[i].startLine - targetStartLine)
    if (distance < minDistance) {
      minDistance = distance
      closestIndex = i
    }
  }

  if (lineNumberErrorTolerance === 1) {
    return closestIndex
  }

  if (closestIndex === -1) return -1

  // Find next closest for tolerance calculation
  let nextClosestDistance = Number.MAX_SAFE_INTEGER
  let nextClosestIndex = -1

  for (let i = 0; i < matches.length; i++) {
    if (i === closestIndex) continue
    const distance = Math.abs(matches[i].startLine - targetStartLine)
    if (distance < nextClosestDistance) {
      nextClosestDistance = distance
      nextClosestIndex = i
    }
  }

  if (nextClosestIndex === -1) return closestIndex

  const distanceBetweenMatches = Math.abs(
    matches[nextClosestIndex].startLine - matches[closestIndex].startLine
  )
  const toleranceThreshold = Math.floor((distanceBetweenMatches / 2) * lineNumberErrorTolerance)

  return minDistance <= toleranceThreshold ? closestIndex : -1
}

// ============================================================================
// Symbol-based Matching (for fuzzy matching)
// ============================================================================

/**
 * Split text into symbols for matching
 */
export function splitIntoSymbols(text: string, includeWhitespace = false): string[] {
  const symbols: string[] = []
  let currentWord = ''

  for (const char of text) {
    if (/[a-zA-Z0-9_]/.test(char)) {
      currentWord += char
    } else {
      if (currentWord) {
        symbols.push(currentWord)
        currentWord = ''
      }
      if (includeWhitespace || !/\s/.test(char)) {
        symbols.push(char)
      }
    }
  }

  if (currentWord) {
    symbols.push(currentWord)
  }

  return symbols
}

/**
 * Find Longest Common Subsequence between two symbol arrays
 */
export function findLongestCommonSubsequence(
  a: string[],
  b: string[],
  maxIndexDiff: number = 1000
): number[] {
  const mapping = new Array(a.length).fill(-1)

  // Simple O(n*m) LCS with index difference limit for performance
  const dp: number[][] = []
  for (let i = 0; i <= a.length; i++) {
    dp[i] = new Array(b.length + 1).fill(0)
  }

  for (let i = 1; i <= a.length; i++) {
    const minJ = Math.max(1, i - maxIndexDiff)
    const maxJ = Math.min(b.length, i + maxIndexDiff)

    for (let j = minJ; j <= maxJ; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to find mapping
  let i = a.length
  let j = b.length

  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      mapping[i - 1] = j - 1
      i--
      j--
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  return mapping
}

// ============================================================================
// Fuzzy Matching
// ============================================================================

/**
 * Performs fuzzy matching for replacement strings
 */
export function fuzzyMatchReplacementStrings(
  originalStr: string,
  oldStr: string,
  newStr: string,
  maxDiff: number = 5,
  maxDiffRatio: number = 0.2,
  minAllMatchStreakBetweenDiffs: number = 3,
  computeBudgetIterations: number = 100000
): { oldStr: string; newStr: string } | MatchFailReason {
  const oldSymbols = splitIntoSymbols(oldStr, false)
  const originalSymbols = splitIntoSymbols(originalStr, false)
  const newSymbols = splitIntoSymbols(newStr, false)

  const maxIndexDiff = Math.ceil(computeBudgetIterations / oldSymbols.length)
  const oldToOriginalMapping = findLongestCommonSubsequence(oldSymbols, originalSymbols, maxIndexDiff)
  const oldToNewMapping = findLongestCommonSubsequence(oldSymbols, newSymbols, maxIndexDiff)

  // Check first and last symbols
  if (oldToOriginalMapping[0] === -1) {
    return MatchFailReason.FirstSymbolOfOldStrNotInOriginal
  }
  if (oldToOriginalMapping[oldSymbols.length - 1] === -1) {
    return MatchFailReason.LastSymbolOfOldStrNotInOriginal
  }

  const modifiedOldStr: string[] = []
  const modifiedNewStr: string[] = []
  let originalIndex = 0
  let oldIndex = 0
  let newIndex = 0
  let numDiff = 0
  let originalFirstMatchIndex = -1
  let originalMatchStreak = oldSymbols.length
  let newMatchStreak = oldSymbols.length

  while (oldIndex < oldSymbols.length) {
    if (oldToOriginalMapping[oldIndex] !== -1 && originalFirstMatchIndex === -1) {
      originalFirstMatchIndex = oldToOriginalMapping[oldIndex]
    }

    if (oldToOriginalMapping[oldIndex] !== -1 && originalIndex < oldToOriginalMapping[oldIndex]) {
      if (originalIndex > originalFirstMatchIndex) {
        originalMatchStreak = 0
        if (newMatchStreak < minAllMatchStreakBetweenDiffs) {
          return MatchFailReason.AmbiguousReplacement
        }
        numDiff++
        modifiedOldStr.push(originalSymbols[originalIndex])
        modifiedNewStr.push(originalSymbols[originalIndex])
      }
      originalIndex++
    } else if (oldToNewMapping[oldIndex] !== -1 && newIndex < oldToNewMapping[oldIndex]) {
      newMatchStreak = 0
      if (originalMatchStreak < minAllMatchStreakBetweenDiffs) {
        return MatchFailReason.AmbiguousReplacement
      }
      modifiedNewStr.push(newSymbols[newIndex])
      newIndex++
    } else if (
      oldToOriginalMapping[oldIndex] === originalIndex &&
      oldToNewMapping[oldIndex] === newIndex
    ) {
      modifiedOldStr.push(oldSymbols[oldIndex])
      modifiedNewStr.push(newSymbols[newIndex])
      oldIndex++
      originalIndex++
      newIndex++
      originalMatchStreak++
      newMatchStreak++
    } else if (oldToOriginalMapping[oldIndex] === originalIndex) {
      if (originalMatchStreak < minAllMatchStreakBetweenDiffs) {
        return MatchFailReason.AmbiguousReplacement
      }
      modifiedOldStr.push(oldSymbols[oldIndex])
      oldIndex++
      originalIndex++
      originalMatchStreak++
      newMatchStreak = 0
    } else if (oldToNewMapping[oldIndex] === newIndex) {
      if (newMatchStreak < minAllMatchStreakBetweenDiffs) {
        return MatchFailReason.AmbiguousReplacement
      }
      oldIndex++
      newIndex++
      numDiff++
      originalMatchStreak = 0
      newMatchStreak++
    } else {
      return MatchFailReason.SymbolInOldNotInOriginalOrNew
    }
  }

  while (newIndex < newSymbols.length) {
    modifiedNewStr.push(newSymbols[newIndex])
    newIndex++
  }

  if (numDiff > maxDiff) {
    return MatchFailReason.ExceedsMaxDiff
  }
  if (numDiff / oldSymbols.length > maxDiffRatio) {
    return MatchFailReason.ExceedsMaxDiffRatio
  }

  return {
    oldStr: modifiedOldStr.join(''),
    newStr: modifiedNewStr.join(''),
  }
}

// ============================================================================
// Tab Indent Fix
// ============================================================================

/**
 * Try to fix tab indentation mismatch
 */
export function tryTabIndentFix(
  content: string,
  oldStr: string,
  newStr: string
): { matches: Match[]; oldStr: string; newStr: string } {
  const contentIndentation = detectIndentation(content)
  const oldStrIndentation = detectIndentation(oldStr)
  const newStrIndentation = detectIndentation(newStr)

  if (
    contentIndentation.type === 'tab' &&
    oldStrIndentation.type === 'tab' &&
    (newStrIndentation.type === 'tab' || newStr.trim() === '') &&
    allLinesHaveIndent(oldStr, contentIndentation) &&
    allLinesHaveIndent(newStr, contentIndentation)
  ) {
    const currentOldStr = removeOneIndentLevel(oldStr, contentIndentation)
    const currentNewStr = removeOneIndentLevel(newStr, contentIndentation)
    const matches = findMatches(content, currentOldStr)

    if (matches.length > 0) {
      return { matches, oldStr: currentOldStr, newStr: currentNewStr }
    }
  }

  return { matches: [], oldStr, newStr }
}

// ============================================================================
// Snippet Creation
// ============================================================================

/**
 * Creates a snippet of content around a specific line
 */
export function createSnippet(
  content: string,
  replacementStartLine: number,
  replacementNumLines: number,
  snippetContextLines: number
): { snippet: string; startLine: number } {
  const startLine = Math.max(0, replacementStartLine - snippetContextLines)
  const endLine = replacementStartLine + replacementNumLines - 1 + snippetContextLines

  content = content.replace(/\r\n/g, '\n')
  const snippet = content
    .split('\n')
    .slice(startLine, endLine + 1)
    .join('\n')

  return { snippet, startLine }
}

/**
 * Creates a formatted snippet string with line numbers
 */
export function createSnippetStr(
  content: string,
  replacementStartLine: number,
  replacementNumLines: number,
  snippetContextLines: number
): string {
  const { snippet, startLine } = createSnippet(
    content,
    replacementStartLine,
    replacementNumLines,
    snippetContextLines
  )

  return snippet
    .split('\n')
    .map((line, i) => `${String(i + startLine + 1).padStart(6)}\t${line}`)
    .join('\n')
}

// ============================================================================
// Enhanced Edit Function
// ============================================================================

export interface EnhancedEditOptions {
  /** Enable fuzzy matching (default: true) */
  enableFuzzyMatching?: boolean
  /** Line number error tolerance 0-1 (default: 0.2) */
  lineNumberErrorTolerance?: number
  /** Max diff symbols for fuzzy matching (default: 5) */
  maxDiff?: number
  /** Max diff ratio for fuzzy matching (default: 0.2) */
  maxDiffRatio?: number
  /** Snippet context lines (default: 4) */
  snippetContextLines?: number
}

const DEFAULT_OPTIONS: Required<EnhancedEditOptions> = {
  enableFuzzyMatching: true,
  lineNumberErrorTolerance: 0.2,
  maxDiff: 5,
  maxDiffRatio: 0.2,
  snippetContextLines: 4,
}

/**
 * Enhanced string replacement with fuzzy matching and line number tolerance
 */
export function enhancedStrReplace(
  content: string,
  oldStr: string,
  newStr: string,
  options: EnhancedEditOptions = {},
  oldStrStartLineNumber?: number,
  oldStrEndLineNumber?: number
): {
  success: boolean
  newContent?: string
  error?: string
  matchStartLine?: number
  matchEndLine?: number
  usedFuzzyMatching?: boolean
} {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const normalizedContent = removeTrailingWhitespace(content)
  const { content: preparedOldStr } = prepareTextForEditing(oldStr)
  const { content: preparedNewStr } = prepareTextForEditing(newStr)

  let workingOldStr = preparedOldStr
  let workingNewStr = preparedNewStr
  let usedFuzzyMatching = false

  // Check if old_str equals new_str
  if (workingOldStr === workingNewStr) {
    return {
      success: false,
      error: 'No changes: old_string and new_string are identical.',
    }
  }

  // Handle empty old_str for new files
  if (workingOldStr.trim() === '') {
    if (content.trim() === '') {
      return {
        success: true,
        newContent: workingNewStr,
        matchStartLine: 0,
        matchEndLine: workingNewStr.split('\n').length - 1,
      }
    } else {
      return {
        success: false,
        error: 'Cannot use empty old_string on non-empty file.',
      }
    }
  }

  // Find matches
  let matches = findMatches(normalizedContent, workingOldStr)

  // Try tab indent fix if no matches
  if (matches.length === 0) {
    log( 'No verbatim match, trying tab indent fix...')
    const tabFixResult = tryTabIndentFix(normalizedContent, workingOldStr, workingNewStr)
    matches = tabFixResult.matches
    workingOldStr = tabFixResult.oldStr
    workingNewStr = tabFixResult.newStr
  }

  // Try fuzzy matching if enabled and no matches
  if (matches.length === 0 && opts.enableFuzzyMatching &&
      oldStrStartLineNumber !== undefined && oldStrEndLineNumber !== undefined) {
    log( 'No verbatim match, trying fuzzy matching...')

    const snippet = createSnippet(
      normalizedContent,
      oldStrStartLineNumber,
      oldStrEndLineNumber - oldStrStartLineNumber + 1,
      10
    ).snippet

    const fuzzyResult = fuzzyMatchReplacementStrings(
      snippet,
      workingOldStr,
      workingNewStr,
      opts.maxDiff,
      opts.maxDiffRatio,
      3
    )

    if (typeof fuzzyResult === 'object' && 'oldStr' in fuzzyResult) {
      log( 'Fuzzy match successful')
      matches = findMatches(normalizedContent, fuzzyResult.oldStr)
      workingOldStr = fuzzyResult.oldStr
      workingNewStr = fuzzyResult.newStr
      usedFuzzyMatching = matches.length > 0
    } else {
      log( `Fuzzy match failed: ${fuzzyResult}`)
    }
  }

  // No matches found
  if (matches.length === 0) {
    return {
      success: false,
      error: 'String to replace not found in file.',
    }
  }

  // Determine which match to use
  let matchIndex = 0
  if (matches.length > 1) {
    if (oldStrStartLineNumber === undefined || oldStrEndLineNumber === undefined) {
      return {
        success: false,
        error: `Found ${matches.length} matches. Provide line numbers to disambiguate or add more context.`,
      }
    }

    matchIndex = findClosestMatch(
      matches,
      oldStrStartLineNumber,
      oldStrEndLineNumber,
      opts.lineNumberErrorTolerance
    )

    if (matchIndex === -1) {
      return {
        success: false,
        error: `No match found near the specified line numbers (${oldStrStartLineNumber + 1}, ${oldStrEndLineNumber + 1}).`,
      }
    }
  }

  const match = matches[matchIndex]

  // Perform the replacement
  const contentLines = content.split('\n')
  const normalizedContentLines = normalizedContent.split('\n')
  const linesBeforeMatch = contentLines.slice(0, match.startLine)
  const linesAfterMatch = contentLines.slice(match.endLine + 1)
  const matchLines = normalizedContentLines.slice(match.startLine, match.endLine + 1).join('\n')

  const matchPosition = matchLines.indexOf(workingOldStr)
  if (matchPosition === -1) {
    return {
      success: false,
      error: 'Internal error: Could not find exact position of match.',
    }
  }

  const beforeMatch = matchLines.substring(0, matchPosition)
  const afterMatch = matchLines.substring(matchPosition + workingOldStr.length)

  const newContent =
    linesBeforeMatch.join('\n') +
    (linesBeforeMatch.length > 0 ? '\n' : '') +
    beforeMatch +
    workingNewStr +
    afterMatch +
    (linesAfterMatch.length > 0 ? '\n' : '') +
    linesAfterMatch.join('\n')

  return {
    success: true,
    newContent,
    matchStartLine: match.startLine,
    matchEndLine: match.startLine + workingNewStr.split('\n').length - 1,
    usedFuzzyMatching,
  }
}
