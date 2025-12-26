import { isAbsolute, resolve } from 'path'
import { getCwd } from '@utils/state'
import { readFileSync, existsSync } from 'fs'
import { detectFileEncoding } from '@utils/file'
import { type Hunk } from 'diff'
import { getPatch } from '@utils/diff'
import {
  enhancedStrReplace,
  findMatches,
  findClosestMatch,
  tryTabIndentFix,
  removeTrailingWhitespace,
} from '@utils/agentTools'

/**
 * Applies an edit to a file and returns the patch and updated file.
 * Does not write the file to disk.
 */
export function applyEdit(
  file_path: string,
  old_string: string,
  new_string: string,
): { patch: Hunk[]; updatedFile: string } {
  const fullFilePath = isAbsolute(file_path)
    ? file_path
    : resolve(getCwd(), file_path)

  let originalFile
  let updatedFile
  if (old_string === '') {
    // Create new file
    originalFile = ''
    updatedFile = new_string
  } else {
    // Edit existing file
    const enc = detectFileEncoding(fullFilePath)
    originalFile = readFileSync(fullFilePath, enc)
    if (new_string === '') {
      if (
        !old_string.endsWith('\n') &&
        originalFile.includes(old_string + '\n')
      ) {
        updatedFile = originalFile.replace(old_string + '\n', () => new_string)
      } else {
        updatedFile = originalFile.replace(old_string, () => new_string)
      }
    } else {
      updatedFile = originalFile.replace(old_string, () => new_string)
    }
    if (updatedFile === originalFile) {
      throw new Error(
        'Original and edited file match exactly. Failed to apply edit.',
      )
    }
  }

  const patch = getPatch({
    filePath: file_path,
    fileContents: originalFile,
    oldStr: originalFile,
    newStr: updatedFile,
  })

  return { patch, updatedFile }
}

/**
 * Options for enhanced editing
 */
export interface EnhancedEditOptions {
  /** Replace all occurrences (default: false) */
  replaceAll?: boolean
  /** Start line number hint (1-based) */
  startLineNumber?: number
  /** End line number hint (1-based) */
  endLineNumber?: number
  /** Enable fuzzy matching (default: true) */
  enableFuzzyMatching?: boolean
  /** Line number error tolerance 0-1 (default: 0.2) */
  lineNumberErrorTolerance?: number
}

/**
 * Enhanced edit that supports fuzzy matching, line number hints, and replace all.
 */
export function applyEditWithEnhancements(
  file_path: string,
  old_string: string,
  new_string: string,
  options: EnhancedEditOptions = {},
): {
  patch: Hunk[]
  updatedFile: string
  usedFuzzyMatching: boolean
  matchedLine?: number
} {
  const {
    replaceAll = false,
    startLineNumber,
    endLineNumber,
    enableFuzzyMatching = true,
    lineNumberErrorTolerance = 0.2,
  } = options

  const fullFilePath = isAbsolute(file_path)
    ? file_path
    : resolve(getCwd(), file_path)

  // Handle new file creation
  if (old_string === '') {
    const patch = getPatch({
      filePath: file_path,
      fileContents: '',
      oldStr: '',
      newStr: new_string,
    })
    return { patch, updatedFile: new_string, usedFuzzyMatching: false }
  }

  // Read existing file
  if (!existsSync(fullFilePath)) {
    throw new Error(`File does not exist: ${fullFilePath}`)
  }

  const enc = detectFileEncoding(fullFilePath)
  const originalFile = readFileSync(fullFilePath, enc)
  const normalizedContent = removeTrailingWhitespace(originalFile)

  let updatedFile: string
  let usedFuzzyMatching = false
  let matchedLine: number | undefined

  // Handle replace all
  if (replaceAll) {
    updatedFile = originalFile.split(old_string).join(new_string)
    if (updatedFile === originalFile) {
      throw new Error('String to replace not found in file.')
    }
  } else {
    // Try enhanced replacement with fuzzy matching
    const result = enhancedStrReplace(
      originalFile,
      old_string,
      new_string,
      {
        enableFuzzyMatching,
        lineNumberErrorTolerance,
      },
      startLineNumber !== undefined ? startLineNumber - 1 : undefined, // Convert to 0-based
      endLineNumber !== undefined ? endLineNumber - 1 : undefined,
    )

    if (result.success && result.newContent) {
      updatedFile = result.newContent
      usedFuzzyMatching = result.usedFuzzyMatching || false
      matchedLine = result.matchStartLine !== undefined ? result.matchStartLine + 1 : undefined
    } else {
      // Fall back to standard replacement
      const matches = findMatches(normalizedContent, old_string)

      if (matches.length === 0) {
        // Try tab indent fix
        const tabFixResult = tryTabIndentFix(normalizedContent, old_string, new_string)
        if (tabFixResult.matches.length > 0) {
          updatedFile = originalFile.replace(tabFixResult.oldStr, tabFixResult.newStr)
          matchedLine = tabFixResult.matches[0].startLine + 1
        } else {
          throw new Error(result.error || 'String to replace not found in file.')
        }
      } else if (matches.length === 1) {
        // Single match - simple replacement
        updatedFile = originalFile.replace(old_string, new_string)
        matchedLine = matches[0].startLine + 1
      } else {
        // Multiple matches - use line number hint
        if (startLineNumber !== undefined) {
          const matchIndex = findClosestMatch(
            matches,
            startLineNumber - 1,
            (endLineNumber ?? startLineNumber) - 1,
            lineNumberErrorTolerance,
          )

          if (matchIndex >= 0) {
            // Replace only the specific occurrence
            const parts = originalFile.split(old_string)
            updatedFile = parts.slice(0, matchIndex + 1).join(old_string) +
              new_string +
              parts.slice(matchIndex + 1).join(old_string)
            matchedLine = matches[matchIndex].startLine + 1
          } else {
            throw new Error(
              `No match found near line ${startLineNumber}. Found ${matches.length} matches but none within tolerance.`
            )
          }
        } else {
          throw new Error(
            `Found ${matches.length} matches. Provide line number hints or more context to disambiguate.`
          )
        }
      }
    }
  }

  if (updatedFile === originalFile) {
    throw new Error('Original and edited file match exactly. Failed to apply edit.')
  }

  const patch = getPatch({
    filePath: file_path,
    fileContents: originalFile,
    oldStr: originalFile,
    newStr: updatedFile,
  })

  return { patch, updatedFile, usedFuzzyMatching, matchedLine }
}
