/**
 * Fuzzy Matcher - Integrated from AgentTool
 * Provides advanced fuzzy matching for string replacement operations
 */

import { splitIntoSymbols } from './matchLines'
import { findLongestCommonSubsequence } from './findLcs'

export enum MatchFailReason {
  ExceedsMaxDiff = 'ExceedsMaxDiff',
  ExceedsMaxDiffRatio = 'ExceedsMaxDiffRatio',
  FirstSymbolOfOldStrNotInOriginal = 'FirstSymbolOfOldStrNotInOriginal',
  LastSymbolOfOldStrNotInOriginal = 'LastSymbolOfOldStrNotInOriginal',
  SymbolInOldNotInOriginalOrNew = 'SymbolInOldNotInOriginalOrNew',
  AmbiguousReplacement = 'AmbiguousReplacement',
}

/**
 * Performs fuzzy matching between the original file content, the string to be
 * replaced, and the replacement string.
 *
 * The algorithm works as follows:
 * 1. Split original snippet, old and new strings into symbols. Alphanumeric words
 *    are treated as single symbols, all other characters are treated as separate
 *    symbols.
 * 2. Find the Longest Common Subsequence (LCS) between old and original strings,
 *    as well as between old and new strings.
 * 3. Go through the old string detecting spans of symbols that are different
 *    between these strings(diff span).
 * 4. We require that each diff span is isolated between sections of symbols that
 *    are matching in all three strings. The minimum section length is controlled
 *    by minAllMatchStreakBetweenDiffs. If this requirement is not met we return
 *    AmbiguousReplacement as a fail reason since there is a chance that
 *    the diffs are overlapping and we cannot determine the correct replacement.
 * 5. If there is an isolated diff span between original and old strings, we
 *    modify both old and new strings to match that.
 * 6. We also check that the number of symbols in the difference between old and
 *    original is under given thresholds in both absolute terms (maxDiff) and
 *    relative terms (maxDiffRatio).
 * 7. If the differences are too large or ambiguous, the function returns a
 *    MatchFailReason.
 *
 * @param originalStr Excerpt from the original file that should contain oldStr
 * @param oldStr The string to be replaced
 * @param newStr The string to replace with
 * @param maxDiff Sum of unmatched symbols in oldStr and originalStr allowed
 * @param maxDiffRatio In [0, 1] range. Maximum ratio maxDiff / oldStr.length allowed
 * @param minAllMatchStreakBetweenDiffs Minimum number of consecutive matching symbols
 *        required between differences
 * @param computeBudgetIterations Maximum number of iterations allowed for LCS
 *        computation (performance limit)
 * @returns Modified oldStr and newStr that can be used for replacement or just the
 *          MatchFailReason if no good match was found
 */
export function fuzzyMatchReplacementStrings(
  originalStr: string,
  oldStr: string,
  newStr: string,
  maxDiff: number = 20,
  maxDiffRatio: number = 0.2,
  minAllMatchStreakBetweenDiffs: number = 3,
  computeBudgetIterations: number = 100 * 1000
): { oldStr: string; newStr: string } | MatchFailReason {
  // Match symbol by symbol
  const oldSymbols = splitIntoSymbols(oldStr, false)
  const originalSymbols = splitIntoSymbols(originalStr, false)
  const newSymbols = splitIntoSymbols(newStr, false)

  const maxIndexDiff = Math.ceil(computeBudgetIterations / oldSymbols.length)
  const oldToOriginalMapping = findLongestCommonSubsequence(
    oldSymbols,
    originalSymbols,
    maxIndexDiff
  )
  const oldToNewMapping = findLongestCommonSubsequence(oldSymbols, newSymbols, maxIndexDiff)

  // if first or last symbol of oldStr do not have a match then it can be an ambiguous replacement
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
  // set initial streaks to max to allow for any diffs at the beginning
  let originalMatchStreak = oldSymbols.length
  let newMatchStreak = oldSymbols.length

  while (oldIndex < oldSymbols.length) {
    if (oldToOriginalMapping[oldIndex] !== -1 && originalFirstMatchIndex === -1) {
      originalFirstMatchIndex = oldToOriginalMapping[oldIndex]
    }

    if (oldToOriginalMapping[oldIndex] !== -1 && originalIndex < oldToOriginalMapping[oldIndex]) {
      // process symbols in original that are not in old

      // do not consider leading symbols in original
      // only consider symbols after the first match
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
      // process symbols in new that are not in old

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
      // process symbols that are in both old and new and original
      modifiedOldStr.push(oldSymbols[oldIndex])
      modifiedNewStr.push(newSymbols[newIndex])
      oldIndex++
      originalIndex++
      newIndex++

      originalMatchStreak++
      newMatchStreak++
    } else if (oldToOriginalMapping[oldIndex] === originalIndex) {
      // process symbols that are in old and original but not in new
      if (originalMatchStreak < minAllMatchStreakBetweenDiffs) {
        // Diffs between old vs new and old vs original are too close to each other
        // Potentially ambiguous replacement
        return MatchFailReason.AmbiguousReplacement
      }

      modifiedOldStr.push(oldSymbols[oldIndex])
      oldIndex++
      originalIndex++
      originalMatchStreak++
      newMatchStreak = 0
    } else if (oldToNewMapping[oldIndex] === newIndex) {
      // process symbols that are in old and new but not in original
      if (newMatchStreak < minAllMatchStreakBetweenDiffs) {
        // Diffs between old vs new and old vs original are too close to each other
        // Potentially ambiguous replacement
        return MatchFailReason.AmbiguousReplacement
      }

      // skipping this symbol since it was not in original
      // but present in both old and new, so it is not related to the replacement
      oldIndex++
      newIndex++
      numDiff++
      originalMatchStreak = 0
      newMatchStreak++
    } else {
      // old symbol is not in original and not in new. Potentially ambiguous replacement
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
