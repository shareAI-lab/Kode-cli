/**
 * LocateSnippet - Fuzzy code snippet location using LCS
 *
 * Migrated from AgentTool/10-UtilityTools/locate-snippet.ts
 *
 * Features:
 * - FNV-1a hash-based line comparison for performance
 * - Handles indentation differences
 * - Finds shortest range containing max LCS
 */

// ============================================================================
// Fast Hash (FNV-1a)
// ============================================================================

/**
 * Computes a fast hash of the input string using the FNV-1a algorithm.
 *
 * This function implements a non-cryptographic hash function that is
 * designed for speed while still providing a good distribution of hash
 * values. It's particularly useful for hash table implementations and
 * quick string comparisons.
 *
 * @param str - The input string to be hashed
 * @param ignoreLeadingWhitespace - If true, leading whitespace will be ignored
 * @returns A 32-bit unsigned integer representing the hash
 */
function fastHash(str: string, ignoreLeadingWhitespace: boolean = false): number {
  let hash = 0x811c9dc5 // FNV offset basis
  const startIndex = ignoreLeadingWhitespace ? str.length - str.trimStart().length : 0

  for (let i = startIndex; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash *= 0x01000193 // FNV prime
  }

  return hash >>> 0 // Convert to 32-bit unsigned integer
}

// ============================================================================
// LCS Computation
// ============================================================================

interface LCSResult {
  maxLCSLength: number
  minSubstringLength: number
  endIndex: number
}

/**
 * Computes the Longest Common Subsequence (LCS) between two arrays of numbers.
 *
 * @param document - Array of numbers representing the document content (hashed lines)
 * @param pattern - Array of numbers representing the pattern to match (hashed lines)
 * @returns Object containing LCS length, minimum substring length, and end index
 */
function computeLCS(document: number[], pattern: number[]): LCSResult {
  const n = document.length
  const m = pattern.length

  let previousRow: { lcsLength: number; minSubstringLength: number }[] = Array(m + 1)
    .fill(null)
    .map(() => ({ lcsLength: 0, minSubstringLength: Infinity }))
  let currentRow: { lcsLength: number; minSubstringLength: number }[] = Array(m + 1)
    .fill(null)
    .map(() => ({ lcsLength: 0, minSubstringLength: Infinity }))

  previousRow[0].minSubstringLength = 0

  let maxLCSLength = 0
  let minSubstringLength = Infinity
  let endIndex = -1

  for (let i = 1; i <= n; i++) {
    currentRow[0] = { lcsLength: 0, minSubstringLength: 0 }

    for (let j = 1; j <= m; j++) {
      if (document[i - 1] === pattern[j - 1]) {
        const lcsLength = previousRow[j - 1].lcsLength + 1
        const minSubLength = previousRow[j - 1].minSubstringLength + 1
        currentRow[j] = { lcsLength, minSubstringLength: minSubLength }
      } else {
        const fromTop = previousRow[j]
        const fromLeft = currentRow[j - 1]

        if (fromTop.lcsLength > fromLeft.lcsLength) {
          currentRow[j] = {
            lcsLength: fromTop.lcsLength,
            minSubstringLength: fromTop.minSubstringLength + 1,
          }
        } else if (fromTop.lcsLength < fromLeft.lcsLength) {
          currentRow[j] = {
            lcsLength: fromLeft.lcsLength,
            minSubstringLength: fromLeft.minSubstringLength,
          }
        } else {
          currentRow[j] = {
            lcsLength: fromTop.lcsLength,
            minSubstringLength: Math.min(
              fromTop.minSubstringLength + 1,
              fromLeft.minSubstringLength
            ),
          }
        }
      }

      if (j === m) {
        const current = currentRow[j]
        if (
          current.lcsLength > maxLCSLength ||
          (current.lcsLength === maxLCSLength && current.minSubstringLength < minSubstringLength)
        ) {
          maxLCSLength = current.lcsLength
          minSubstringLength = current.minSubstringLength
          endIndex = i
        }
      }
    }

    // Swap rows
    ;[previousRow, currentRow] = [currentRow, previousRow]
  }

  return { maxLCSLength, minSubstringLength, endIndex }
}

// ============================================================================
// Fuzzy Locate Snippet
// ============================================================================

export interface SnippetLocation {
  /** Start line index (0-based, inclusive) */
  start: number
  /** End line index (0-based, inclusive) */
  end: number
}

/**
 * Locates the shortest range in the file content that contains the maximum
 * longest common subsequence (LCS) with the provided pattern.
 *
 * Comparisons are performed line by line using hash-based matching for performance.
 * The function handles cases where the snippet might have different indentation
 * levels compared to the original file content.
 *
 * @param fileContent - The content of the file as a string
 * @param pattern - The pattern/snippet to locate
 * @returns Object with start and end line indices, or null if no match found
 *
 * @example
 * ```typescript
 * const location = fuzzyLocateSnippet(fileContent, codeSnippet)
 * if (location) {
 *   console.log(`Found at lines ${location.start}-${location.end}`)
 * }
 * ```
 */
export function fuzzyLocateSnippet(
  fileContent: string,
  pattern: string
): SnippetLocation | null {
  const fileLines = fileContent.split('\n')
  const patternLines = pattern.trim().split('\n')

  function computeHashesAndLCS(ignoreLeadingWhitespace: boolean): LCSResult {
    const fileHashes = fileLines.map((line) => fastHash(line, ignoreLeadingWhitespace))
    const patternHashes = patternLines.map((line) => fastHash(line, ignoreLeadingWhitespace))
    return computeLCS(fileHashes, patternHashes)
  }

  // Try both options: with and without ignoring indentation
  const resultWithoutIgnoreIndentation = computeHashesAndLCS(false)
  const resultWithIgnoreIndentation = computeHashesAndLCS(true)

  // Choose the result, giving priority to the one without ignoring indentation
  const { maxLCSLength, minSubstringLength, endIndex } =
    resultWithoutIgnoreIndentation.maxLCSLength >= resultWithIgnoreIndentation.maxLCSLength
      ? resultWithoutIgnoreIndentation
      : resultWithIgnoreIndentation

  if (maxLCSLength === 0) {
    return null
  }

  const startIndex = endIndex - minSubstringLength
  const endIndexInclusive = endIndex - 1

  return { start: startIndex, end: endIndexInclusive }
}

/**
 * Find the best matching line range for a code snippet in file content
 * with additional context options
 */
export interface LocateOptions {
  /** Minimum match ratio (0-1) to consider a valid match */
  minMatchRatio?: number
  /** Whether to prefer exact indentation match */
  preferExactIndentation?: boolean
}

/**
 * Advanced snippet location with match quality scoring
 *
 * @param fileContent - The content of the file
 * @param pattern - The pattern to locate
 * @param options - Location options
 * @returns Location with match quality, or null if no good match found
 */
export function locateSnippetWithQuality(
  fileContent: string,
  pattern: string,
  options: LocateOptions = {}
): (SnippetLocation & { matchRatio: number }) | null {
  const { minMatchRatio = 0.5, preferExactIndentation = true } = options

  const fileLines = fileContent.split('\n')
  const patternLines = pattern.trim().split('\n')

  function computeHashesAndLCS(ignoreLeadingWhitespace: boolean): LCSResult {
    const fileHashes = fileLines.map((line) => fastHash(line, ignoreLeadingWhitespace))
    const patternHashes = patternLines.map((line) => fastHash(line, ignoreLeadingWhitespace))
    return computeLCS(fileHashes, patternHashes)
  }

  const resultExact = computeHashesAndLCS(false)
  const resultIgnoreIndent = computeHashesAndLCS(true)

  // Calculate match ratios
  const exactRatio = patternLines.length > 0 ? resultExact.maxLCSLength / patternLines.length : 0
  const ignoreIndentRatio =
    patternLines.length > 0 ? resultIgnoreIndent.maxLCSLength / patternLines.length : 0

  // Choose best result based on preferences
  let bestResult: LCSResult
  let matchRatio: number

  if (preferExactIndentation && exactRatio >= ignoreIndentRatio * 0.9) {
    // Prefer exact if it's within 90% of indent-ignoring result
    bestResult = resultExact
    matchRatio = exactRatio
  } else if (ignoreIndentRatio > exactRatio) {
    bestResult = resultIgnoreIndent
    matchRatio = ignoreIndentRatio
  } else {
    bestResult = resultExact
    matchRatio = exactRatio
  }

  // Check minimum match ratio
  if (matchRatio < minMatchRatio) {
    return null
  }

  const { minSubstringLength, endIndex, maxLCSLength } = bestResult

  if (maxLCSLength === 0) {
    return null
  }

  const startIndex = endIndex - minSubstringLength
  const endIndexInclusive = endIndex - 1

  return {
    start: startIndex,
    end: endIndexInclusive,
    matchRatio,
  }
}

/**
 * Find multiple occurrences of a pattern in file content
 *
 * @param fileContent - The content of the file
 * @param pattern - The pattern to locate
 * @param maxOccurrences - Maximum number of occurrences to find
 * @returns Array of locations
 */
export function findAllSnippetOccurrences(
  fileContent: string,
  pattern: string,
  maxOccurrences: number = 10
): SnippetLocation[] {
  const results: SnippetLocation[] = []
  const fileLines = fileContent.split('\n')
  const patternLines = pattern.trim().split('\n')

  if (patternLines.length === 0) return results

  let searchStart = 0

  while (results.length < maxOccurrences && searchStart < fileLines.length) {
    // Create a subset of the file starting from searchStart
    const remainingContent = fileLines.slice(searchStart).join('\n')
    const location = fuzzyLocateSnippet(remainingContent, pattern)

    if (!location) break

    // Adjust indices to account for searchStart offset
    const adjustedLocation: SnippetLocation = {
      start: location.start + searchStart,
      end: location.end + searchStart,
    }

    results.push(adjustedLocation)

    // Move search start past the current match
    searchStart = adjustedLocation.end + 1
  }

  return results
}
