import { stat } from 'fs/promises'
import { Box, Text } from 'ink'
import React from 'react'
import { z } from 'zod'
import { Cost } from '@components/Cost'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool } from '@tool'
import { getCwd } from '@utils/state'
import {
  getAbsolutePath,
  getAbsoluteAndRelativePaths,
} from '@utils/file'
import { ripGrep } from '@utils/ripgrep'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT, REGEX_SYNTAX_GUIDE } from './prompt'
import { hasReadPermission } from '@utils/permissions/filesystem'

const inputSchema = z.strictObject({
  pattern: z
    .string()
    .describe('The regular expression pattern to search for in file contents'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search in (rg PATH). Defaults to current working directory.',
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
    ),
  type: z
    .string()
    .optional()
    .describe(
      'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
    ),
  '-A': z
    .number()
    .optional()
    .describe('Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.'),
  '-B': z
    .number()
    .optional()
    .describe('Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.'),
  '-C': z
    .number()
    .optional()
    .describe('Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.'),
  '-i': z
    .boolean()
    .optional()
    .describe('Case insensitive search (rg -i)'),
  '-n': z
    .boolean()
    .optional()
    .describe('Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.'),
  multiline: z
    .boolean()
    .optional()
    .describe('Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.'),
  head_limit: z
    .number()
    .optional()
    .describe('Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults based on "cap" experiment value: 0 (unlimited), 20, or 100.'),
  offset: z
    .number()
    .optional()
    .describe('Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.'),
})

// Legacy alias for backward compatibility
const inputSchemaLegacy = inputSchema.extend({
  include: z.string().optional().describe('Deprecated: Use "glob" instead'),
})

const MAX_RESULTS = 100
const DEFAULT_HEAD_LIMIT = 100

type Input = typeof inputSchema
type Output = {
  durationMs: number
  numFiles: number
  filenames: string[]
  content?: string
  matchCount?: number
}

export const GrepTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Search'
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true // GrepTool is read-only, safe for concurrent execution
  },
  async isEnabled() {
    return true
  },
  needsPermissions({ path }) {
    return !hasReadPermission(path || getCwd())
  },
  async prompt() {
    return DESCRIPTION + '\n\n' + REGEX_SYNTAX_GUIDE
  },
  renderToolUseMessage(input: any, { verbose }) {
    const { pattern, path, glob, type, output_mode } = input
    // Support legacy 'include' parameter
    const effectiveGlob = glob || input.include
    const { absolutePath, relativePath } = getAbsoluteAndRelativePaths(path)

    const parts: string[] = [`pattern: "${pattern}"`]
    if (relativePath || verbose) {
      parts.push(`path: "${verbose ? absolutePath : relativePath}"`)
    }
    if (effectiveGlob) {
      parts.push(`glob: "${effectiveGlob}"`)
    }
    if (type) {
      parts.push(`type: "${type}"`)
    }
    if (output_mode && output_mode !== 'files_with_matches') {
      parts.push(`output_mode: "${output_mode}"`)
    }
    // Show context options if present
    if (input['-C']) parts.push(`-C: ${input['-C']}`)
    else {
      if (input['-A']) parts.push(`-A: ${input['-A']}`)
      if (input['-B']) parts.push(`-B: ${input['-B']}`)
    }

    return parts.join(', ')
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output) {
    // Handle string content for backward compatibility
    if (typeof output === 'string') {
      output = output as unknown as Output
    }

    const hasContent = output.content && output.content.length > 0

    return (
      <Box justifyContent="space-between" width="100%">
        <Box flexDirection="row">
          <Text>&nbsp;&nbsp;⎿ &nbsp;Found </Text>
          <Text bold>{output.matchCount ?? output.numFiles} </Text>
          <Text>
            {hasContent
              ? `match${(output.matchCount ?? 0) !== 1 ? 'es' : ''} in ${output.numFiles} file${output.numFiles !== 1 ? 's' : ''}`
              : `${output.numFiles === 0 || output.numFiles > 1 ? 'files' : 'file'}`
            }
          </Text>
        </Box>
        <Cost costUSD={0} durationMs={output.durationMs} debug={false} />
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    const { numFiles, filenames, content, matchCount } = output

    // Content mode - return the formatted content
    if (content) {
      if (matchCount === 0) {
        return 'No matches found'
      }
      return content
    }

    // Files mode (default)
    if (numFiles === 0) {
      return 'No files found'
    }
    let result = `Found ${numFiles} file${numFiles === 1 ? '' : 's'}\n${filenames.slice(0, MAX_RESULTS).join('\n')}`
    if (numFiles > MAX_RESULTS) {
      result +=
        '\n(Results are truncated. Consider using a more specific path or pattern.)'
    }
    return result
  },
  async *call(input: any, { abortController }) {
    const start = Date.now()
    const {
      pattern,
      path,
      output_mode = 'files_with_matches',
      head_limit = DEFAULT_HEAD_LIMIT,
      offset = 0,
      multiline = false,
    } = input

    // Support legacy 'include' parameter
    const glob = input.glob || input.include
    const type = input.type
    const contextBefore = input['-B'] || input['-C'] || 0
    const contextAfter = input['-A'] || input['-C'] || 0
    const caseInsensitive = input['-i'] ?? false
    const showLineNumbers = input['-n'] ?? true

    const absolutePath = getAbsolutePath(path) || getCwd()

    // Build ripgrep arguments
    const args: string[] = []

    // Output mode
    if (output_mode === 'files_with_matches') {
      args.push('-l')
    } else if (output_mode === 'count') {
      args.push('-c')
    }

    // Case insensitivity
    if (caseInsensitive) {
      args.push('-i')
    }

    // Multiline mode
    if (multiline) {
      args.push('-U', '--multiline-dotall')
    }

    // Line numbers for content mode
    if (output_mode === 'content' && showLineNumbers) {
      args.push('-n')
    }

    // Context lines
    if (output_mode === 'content') {
      if (contextBefore > 0) {
        args.push('-B', String(contextBefore))
      }
      if (contextAfter > 0) {
        args.push('-A', String(contextAfter))
      }
    }

    // File filtering
    if (glob) {
      args.push('--glob', glob)
    }
    if (type) {
      args.push('--type', type)
    }

    // The pattern
    args.push(pattern)

    try {
      const results = await ripGrep(args, absolutePath, abortController.signal)

      // Process results based on output mode
      let filenames: string[] = []
      let content: string | undefined
      let matchCount = 0

      if (output_mode === 'content') {
        // For content mode, results is the raw output with context
        const lines = results as unknown as string[]
        content = lines.join('\n')
        matchCount = lines.filter(l => !l.startsWith('--')).length

        // Apply offset and limit
        if (offset > 0 || head_limit > 0) {
          const contentLines = content.split('\n')
          const sliced = contentLines.slice(offset, offset + (head_limit || contentLines.length))
          content = sliced.join('\n')
          if (sliced.length < contentLines.length - offset) {
            content += '\n(Results are truncated. Consider using a more specific path or pattern.)'
          }
        }

        // Get unique files from matches
        const fileSet = new Set<string>()
        for (const line of (results as string[])) {
          const match = line.match(/^([^:]+):/)
          if (match) fileSet.add(match[1])
        }
        filenames = Array.from(fileSet)
      } else {
        // Files mode - sort by modification time
        filenames = results as string[]

        if (filenames.length > 0) {
          const stats = await Promise.all(filenames.map(f => stat(f).catch(() => null)))
          const filesWithStats = filenames
            .map((f, i) => [f, stats[i]] as const)
            .filter(([, s]) => s !== null)
            .sort((a, b) => {
              if (process.env.NODE_ENV === 'test') {
                return a[0].localeCompare(b[0])
              }
              const timeComparison = (b[1]?.mtimeMs ?? 0) - (a[1]?.mtimeMs ?? 0)
              return timeComparison === 0 ? a[0].localeCompare(b[0]) : timeComparison
            })
            .map(([f]) => f)

          filenames = filesWithStats
        }

        // Apply offset and limit
        if (offset > 0) {
          filenames = filenames.slice(offset)
        }
        if (head_limit > 0 && filenames.length > head_limit) {
          filenames = filenames.slice(0, head_limit)
        }

        matchCount = filenames.length
      }

      const output: Output = {
        filenames,
        durationMs: Date.now() - start,
        numFiles: filenames.length,
        content,
        matchCount,
      }

      yield {
        type: 'result',
        resultForAssistant: this.renderResultForAssistant(output),
        data: output,
      }
    } catch (error) {
      // Handle errors gracefully
      const output: Output = {
        filenames: [],
        durationMs: Date.now() - start,
        numFiles: 0,
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        matchCount: 0,
      }

      yield {
        type: 'result',
        resultForAssistant: output.content || 'Search failed',
        data: output,
      }
    }
  },
} satisfies Tool<Input, Output>
