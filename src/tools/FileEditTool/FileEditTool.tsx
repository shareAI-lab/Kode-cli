import { Hunk } from 'diff'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { Box, Text } from 'ink'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import * as React from 'react'
import { z } from 'zod'
import { FileEditToolUpdatedMessage } from '@components/FileEditToolUpdatedMessage'
import { StructuredDiff } from '@components/StructuredDiff'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool, ValidationResult } from '@tool'
import { intersperse } from '@utils/array'
import {
  addLineNumbers,
  detectFileEncoding,
  detectLineEndings,
  findSimilarFile,
  writeTextContent,
} from '@utils/file'
import { logError } from '@utils/log'
import { getCwd } from '@utils/state'
import { getTheme } from '@utils/theme'
import { emitReminderEvent } from '@services/systemReminder'
import { recordFileEdit } from '@services/fileFreshness'
import { NotebookEditTool } from '@tools/NotebookEditTool/NotebookEditTool'
import { DESCRIPTION } from './prompt'
import { applyEdit, applyEditWithEnhancements } from './utils'
import { hasWritePermission } from '@utils/permissions/filesystem'
import { PROJECT_FILE } from '@constants/product'
import { debug } from '@utils/debugLogger'

const inputSchema = z.strictObject({
  file_path: z.string().describe('The absolute path to the file to modify'),
  old_string: z.string().describe('The text to replace'),
  new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
  replace_all: z.boolean().optional().default(false).describe('Replace all occurences of old_string (default false)'),
  old_str_start_line_number: z.number().optional().describe('Optional hint: 1-based start line number of old_string'),
  old_str_end_line_number: z.number().optional().describe('Optional hint: 1-based end line number of old_string'),
})

export type In = typeof inputSchema

// Number of lines of context to include before/after the change in our result message
const N_LINES_SNIPPET = 4

export const FileEditTool = {
  name: 'Edit',
  async description() {
    return 'A tool for editing files'
  },
  async prompt() {
    return DESCRIPTION
  },
  inputSchema,
  userFacingName() {
    return 'Edit'
  },
  async isEnabled() {
    return true
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false // FileEdit modifies files, not safe for concurrent execution
  },
  needsPermissions({ file_path }) {
    return !hasWritePermission(file_path)
  },
  renderToolUseMessage(input, { verbose }) {
    return `file_path: ${verbose ? input.file_path : relative(getCwd(), input.file_path)}`
  },
  renderToolResultMessage({ filePath, structuredPatch }) {
    const verbose = false // Set default value for verbose
    return (
      <FileEditToolUpdatedMessage
        filePath={filePath}
        structuredPatch={structuredPatch}
        verbose={verbose}
      />
    )
  },
  renderToolUseRejectedMessage(
    { file_path, old_string, new_string }: any = {},
    { columns, verbose }: any = {},
  ) {
    try {
      if (!file_path) {
        return <FallbackToolUseRejectedMessage />
      }
      const { patch } = applyEdit(file_path, old_string, new_string)
      return (
        <Box flexDirection="column">
          <Text>
            {'  '}⎿{' '}
            <Text color={getTheme().error}>
              User rejected {old_string === '' ? 'write' : 'update'} to{' '}
            </Text>
            <Text bold>
              {verbose ? file_path : relative(getCwd(), file_path)}
            </Text>
          </Text>
          {intersperse(
            patch.map(patch => (
              <Box flexDirection="column" paddingLeft={5} key={patch.newStart}>
                <StructuredDiff patch={patch} dim={true} width={columns - 12} />
              </Box>
            )),
            i => (
              <Box paddingLeft={5} key={`ellipsis-${i}`}>
                <Text color={getTheme().secondaryText}>...</Text>
              </Box>
            ),
          )}
        </Box>
      )
    } catch (e) {
      // Handle the case where while we were showing the diff, the user manually made the change.
      // TODO: Find a way to show the diff in this case
      logError(e)
      return (
        <Box flexDirection="column">
          <Text>{'  '}⎿ (No changes)</Text>
        </Box>
      )
    }
  },
  async validateInput(
    { file_path, old_string, new_string, replace_all, old_str_start_line_number, old_str_end_line_number },
    { readFileTimestamps },
  ) {
    if (old_string === new_string) {
      return {
        result: false,
        message:
          'No changes to make: old_string and new_string are exactly the same.',
        meta: {
          old_string,
        },
      } as ValidationResult
    }

    const fullFilePath = isAbsolute(file_path)
      ? file_path
      : resolve(getCwd(), file_path)

    if (existsSync(fullFilePath) && old_string === '') {
      return {
        result: false,
        message: 'Cannot create new file - file already exists.',
      }
    }

    if (!existsSync(fullFilePath) && old_string === '') {
      return {
        result: true,
      }
    }

    if (!existsSync(fullFilePath)) {
      // Try to find a similar file with a different extension
      const similarFilename = findSimilarFile(fullFilePath)
      let message = 'File does not exist.'

      // If we found a similar file, suggest it to the assistant
      if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        message,
      }
    }

    if (fullFilePath.endsWith('.ipynb')) {
      return {
        result: false,
        message: `File is a Jupyter Notebook. Use the ${NotebookEditTool.name} to edit this file.`,
      }
    }

    const readTimestamp = readFileTimestamps[fullFilePath]
    if (!readTimestamp) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before writing to it.',
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
      }
    }

    // Check if file exists and get its last modified time
    const stats = statSync(fullFilePath)
    const lastWriteTime = stats.mtimeMs
    if (lastWriteTime > readTimestamp) {
      return {
        result: false,
        message:
          'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
      }
    }

    const enc = detectFileEncoding(fullFilePath)
    const file = readFileSync(fullFilePath, enc)

    // Try exact match first
    if (!file.includes(old_string)) {
      // If line numbers are provided, we might try fuzzy matching later in call()
      // For now, just indicate the string wasn't found
      if (old_str_start_line_number !== undefined && old_str_end_line_number !== undefined) {
        debug.trace('edit', `String not found verbatim, will try fuzzy matching with line hints: ${old_str_start_line_number}-${old_str_end_line_number}`)
        // Allow validation to pass - we'll try enhanced matching in call()
        return { result: true }
      }

      return {
        result: false,
        message: `String to replace not found in file.`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
      }
    }

    const matches = file.split(old_string).length - 1
    if (matches > 1 && !replace_all) {
      // If line numbers are provided, we can try to disambiguate
      if (old_str_start_line_number !== undefined) {
        debug.trace('edit', `Found ${matches} matches, will use line number hint to disambiguate`)
        return { result: true }
      }

      return {
        result: false,
        message: `Found ${matches} matches of the string to replace. For safety, this tool only supports replacing exactly one occurrence at a time. Either add more lines of context to your edit, provide line number hints (old_str_start_line_number/old_str_end_line_number), or set replace_all=true.`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
          matchCount: matches,
        },
      }
    }

    return { result: true }
  },
  async *call(
    { file_path, old_string, new_string, replace_all, old_str_start_line_number, old_str_end_line_number },
    { readFileTimestamps }
  ) {
    const fullFilePath = isAbsolute(file_path)
      ? file_path
      : resolve(getCwd(), file_path)
    const dir = dirname(fullFilePath)
    mkdirSync(dir, { recursive: true })
    const enc = existsSync(fullFilePath)
      ? detectFileEncoding(fullFilePath)
      : 'utf8'
    const endings = existsSync(fullFilePath)
      ? detectLineEndings(fullFilePath)
      : 'LF'
    const originalFile = existsSync(fullFilePath)
      ? readFileSync(fullFilePath, enc)
      : ''

    // Use enhanced editing with fuzzy matching and line number support
    const { patch, updatedFile, usedFuzzyMatching, matchedLine } = applyEditWithEnhancements(
      file_path,
      old_string,
      new_string,
      {
        replaceAll: replace_all || false,
        startLineNumber: old_str_start_line_number,
        endLineNumber: old_str_end_line_number,
        enableFuzzyMatching: true,
        lineNumberErrorTolerance: 0.2,
      }
    )

    // Log if fuzzy matching was used
    if (usedFuzzyMatching) {
      debug.trace('edit', `Used fuzzy matching for edit at line ${matchedLine}`)
    }

    writeTextContent(fullFilePath, updatedFile, enc, endings)

    // Record Agent edit operation for file freshness tracking
    recordFileEdit(fullFilePath, updatedFile)

    // Update read timestamp, to invalidate stale writes
    readFileTimestamps[fullFilePath] = statSync(fullFilePath).mtimeMs

    // Log when editing CLAUDE.md
    if (fullFilePath.endsWith(`${sep}${PROJECT_FILE}`)) {
    }

    // Emit file edited event for system reminders
    emitReminderEvent('file:edited', {
      filePath: fullFilePath,
      oldString: old_string,
      newString: new_string,
      timestamp: Date.now(),
      operation:
        old_string === '' ? 'create' : new_string === '' ? 'delete' : 'update',
    })

    const data = {
      filePath: file_path,
      oldString: old_string,
      newString: new_string,
      originalFile,
      structuredPatch: patch,
      usedFuzzyMatching,
      matchedLine,
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: this.renderResultForAssistant(data),
    }
  },
  renderResultForAssistant({ filePath, originalFile, oldString, newString }) {
    const { snippet, startLine } = getSnippet(
      originalFile || '',
      oldString,
      newString,
    )
    return `The file ${filePath} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:
${addLineNumbers({
  content: snippet,
  startLine,
})}`
  },
} satisfies Tool<
  typeof inputSchema,
  {
    filePath: string
    oldString: string
    newString: string
    originalFile: string
    structuredPatch: Hunk[]
  }
>

export function getSnippet(
  initialText: string,
  oldStr: string,
  newStr: string,
): { snippet: string; startLine: number } {
  const before = initialText.split(oldStr)[0] ?? ''
  const replacementLine = before.split(/\r?\n/).length - 1
  const newFileLines = initialText.replace(oldStr, newStr).split(/\r?\n/)
  // Calculate the start and end line numbers for the snippet
  const startLine = Math.max(0, replacementLine - N_LINES_SNIPPET)
  const endLine =
    replacementLine + N_LINES_SNIPPET + newStr.split(/\r?\n/).length
  // Get snippet
  const snippetLines = newFileLines.slice(startLine, endLine + 1)
  const snippet = snippetLines.join('\n')
  return { snippet, startLine: startLine + 1 }
}
