/**
 * Match Lines - Integrated from AgentTool
 * Provides symbol-based fuzzy line matching for file edits
 */

import { findLongestCommonSubsequence } from './findLcs'

/**
 * Split text into symbols
 *
 * Symbols are basically variable/function/class names.
 * More precisely, they are sequences of alphanumerics and underscores.
 * Whitespaces are ignored.
 * Other characters are considered as a single symbol.
 *
 * @param text - Text to split
 * @param ignoreWhitespace - Whether to ignore whitespace (default: true)
 * @returns Array of symbols
 */
export function splitIntoSymbols(text: string, ignoreWhitespace: boolean = true): string[] {
  const symbols: string[] = []
  let currentSymbol = ''

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (/[a-zA-Z0-9_]/.test(char)) {
      // Part of a symbol (alphanumeric or underscore)
      currentSymbol += char
    } else if (/\s/.test(char) && ignoreWhitespace) {
      // Whitespace - ignore but finalize current symbol if any
      if (currentSymbol) {
        symbols.push(currentSymbol)
        currentSymbol = ''
      }
    } else {
      // Other character - treat as a single symbol
      if (currentSymbol) {
        symbols.push(currentSymbol)
        currentSymbol = ''
      }
      symbols.push(char)
    }
  }

  // Add the last symbol if there is one
  if (currentSymbol) {
    symbols.push(currentSymbol)
  }

  return symbols
}

/**
 * Fuzzy match lines
 *
 * Assumes that difference between A and B is mainly in formatting and line breaks.
 *
 * Mapping for each line can be many-to-many.
 * Returns an array of arrays,
 * where each inner array contains the indices of lines in B
 * that contain parts of current line in A
 * Inner arrays are sorted in increasing order
 *
 * @param linesA - Lines from first text
 * @param linesB - Lines from second text
 * @returns mapping from index in linesA to index in linesB, or [] if not mapped.
 */
export function fuzzyMatchLines(linesA: string[], linesB: string[]): number[][] {
  // Split each line into symbols
  const symbolsPerLineA = linesA.map((line) => splitIntoSymbols(line))
  const symbolsPerLineB = linesB.map((line) => splitIntoSymbols(line))

  function mergeSymbols(symbolsPerLine: string[][]): [string[], number[]] {
    const allSymbols: string[] = []
    const lineIndices: number[] = []

    for (let i = 0; i < symbolsPerLine.length; i++) {
      for (let j = 0; j < symbolsPerLine[i].length; j++) {
        allSymbols.push(symbolsPerLine[i][j])
        lineIndices.push(i)
      }
    }

    return [allSymbols, lineIndices]
  }

  const [allSymbolsA, lineIndicesA] = mergeSymbols(symbolsPerLineA)
  const [allSymbolsB, lineIndicesB] = mergeSymbols(symbolsPerLineB)

  // Find longest common subsequence
  const symbolMapping = findLongestCommonSubsequence(allSymbolsA, allSymbolsB)

  // Map the indices back to lines
  const lineMapping: number[][] = Array.from<number[]>({
    length: linesA.length,
  })
    .fill([])
    .map(() => [])

  for (let i = 0; i < symbolMapping.length; i++) {
    const mappedIndex = symbolMapping[i]
    if (mappedIndex !== -1) {
      const lineA = lineIndicesA[i]
      const lineB = lineIndicesB[mappedIndex]

      // Add the mapping if it doesn't already exist
      if (!lineMapping[lineA].includes(lineB)) {
        lineMapping[lineA].push(lineB)
      }
    }
  }

  // No need to sort
  // They would already be sorted since we match symbols in order

  return lineMapping
}
