/**
 * Grep Enhancements - Integrated from AgentTool
 * Provides context lines display, formatted output, and advanced search options
 */

import { spawn } from 'child_process'
import { isAbsolute, resolve } from 'path'
import { debug } from '@utils/debugLogger'
import { getCwd } from '@utils/state'

// Helper for logging
const log = (msg: string) => debug.trace('grep', msg)

// ============================================================================
// Types
// ============================================================================

export interface EnhancedGrepOptions {
  /** Number of context lines before match (default: 0) */
  contextLinesBefore?: number
  /** Number of context lines after match (default: 0) */
  contextLinesAfter?: number
  /** Case sensitive search (default: false) */
  caseSensitive?: boolean
  /** Include glob pattern */
  includeGlob?: string
  /** Exclude glob pattern */
  excludeGlob?: string
  /** Disable .gitignore and hidden files filtering */
  disableIgnoreFiles?: boolean
  /** Output format: 'content' | 'files' | 'json' */
  outputFormat?: 'content' | 'files' | 'json'
  /** Max output characters (default: 30000) */
  maxOutputChars?: number
  /** Search timeout in ms (default: 30000) */
  timeoutMs?: number
  /** Max number of matches (default: 100) */
  maxMatches?: number
}

export interface GrepMatch {
  file: string
  lineNumber: number
  content: string
  isContext?: boolean
}

export interface EnhancedGrepResult {
  matches: GrepMatch[]
  formattedOutput: string
  matchCount: number
  fileCount: number
  truncated: boolean
  timedOut: boolean
  durationMs: number
}

interface RipgrepResult {
  type: 'begin' | 'end' | 'match' | 'context'
  data: {
    path: { text: string }
    lines?: { text: string }
    line_number?: number
    absolute_offset?: number
    submatches?: Array<{
      start: number
      end: number
      match: { text: string }
    }>
  }
}

// ============================================================================
// Default Options
// ============================================================================

const DEFAULT_OPTIONS: Required<EnhancedGrepOptions> = {
  contextLinesBefore: 0,
  contextLinesAfter: 0,
  caseSensitive: false,
  includeGlob: '',
  excludeGlob: '',
  disableIgnoreFiles: false,
  outputFormat: 'content',
  maxOutputChars: 30000,
  timeoutMs: 30000,
  maxMatches: 100,
}

// ============================================================================
// Regex Syntax Guide
// ============================================================================

export const REGEX_SYNTAX_GUIDE = `
Common regex syntax (ripgrep compatible):
- . matches any character
- \\d matches digits [0-9]
- \\w matches word characters [a-zA-Z0-9_]
- \\s matches whitespace
- * zero or more of previous
- + one or more of previous
- ? zero or one of previous
- ^ start of line
- $ end of line
- [abc] character class
- [^abc] negated character class
- (a|b) alternation
- (?:...) non-capturing group
- \\b word boundary
- Escape special chars with \\: \\. \\* \\+ etc.
`

// ============================================================================
// Enhanced Grep Function
// ============================================================================

/**
 * Find ripgrep binary path
 */
async function findRipgrepPath(): Promise<string | null> {
  const paths = ['rg', '/usr/bin/rg', '/usr/local/bin/rg', '/opt/homebrew/bin/rg']

  for (const rgPath of paths) {
    try {
      const result = await new Promise<boolean>((resolve) => {
        const proc = spawn(rgPath, ['--version'])
        proc.on('close', (code) => resolve(code === 0))
        proc.on('error', () => resolve(false))
      })
      if (result) return rgPath
    } catch {
      continue
    }
  }

  return null
}

/**
 * Process ripgrep JSON output into formatted string
 */
function processRipgrepOutput(
  jsonLines: string,
  workingDir: string,
  options: Required<EnhancedGrepOptions>
): { output: string; matches: GrepMatch[] } {
  const lines = jsonLines.split('\n').filter(line => line.trim())
  let formattedOutput = ''
  const matches: GrepMatch[] = []
  let lastLineNumber = -1
  let currentFile = ''

  for (const line of lines) {
    try {
      const result = JSON.parse(line) as RipgrepResult

      if (result.type === 'begin') {
        currentFile = resolve(workingDir, result.data.path.text)
        if (options.outputFormat === 'content') {
          formattedOutput += `\n=== ${currentFile} ===\n`
        }
        lastLineNumber = -1
      } else if (result.type === 'end') {
        // File end marker
        lastLineNumber = -1
      } else if (result.type === 'match' || result.type === 'context') {
        const { lines: matchLines, line_number: lineNumber } = result.data

        if (matchLines && lineNumber !== undefined) {
          // Add gap indicator if there's a gap in line numbers
          if (options.outputFormat === 'content' &&
              lastLineNumber !== -1 && lineNumber > lastLineNumber + 1) {
            formattedOutput += '    ...\n'
          }

          const lineContent = matchLines.text.trimEnd()

          if (options.outputFormat === 'content') {
            // Format with line number and content
            const lineNumStr = lineNumber.toString().padStart(6)
            const prefix = result.type === 'match' ? '' : ' '
            formattedOutput += `${prefix}${lineNumStr}\t${lineContent}\n`
          }

          matches.push({
            file: currentFile,
            lineNumber,
            content: lineContent,
            isContext: result.type === 'context',
          })

          lastLineNumber = lineNumber
        }
      }
    } catch {
      log( `Failed to parse ripgrep output line: ${line}`)
    }
  }

  return { output: formattedOutput, matches }
}

/**
 * Enhanced grep with context lines and formatted output
 */
export async function enhancedGrep(
  pattern: string,
  searchPath?: string,
  options: EnhancedGrepOptions = {},
  abortSignal?: AbortSignal
): Promise<EnhancedGrepResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const startTime = Date.now()

  // Find ripgrep
  const rgPath = await findRipgrepPath()
  if (!rgPath) {
    return {
      matches: [],
      formattedOutput: 'Error: ripgrep not found. Install with: brew install ripgrep (macOS) or apt install ripgrep (Linux)',
      matchCount: 0,
      fileCount: 0,
      truncated: false,
      timedOut: false,
      durationMs: Date.now() - startTime,
    }
  }

  // Determine search directory
  const workingDir = searchPath
    ? (isAbsolute(searchPath) ? searchPath : resolve(getCwd(), searchPath))
    : getCwd()

  // Build ripgrep arguments
  const args: string[] = [
    '--json',
    '--no-config',
  ]

  if (opts.disableIgnoreFiles) {
    args.push('--no-ignore', '--hidden')
  }

  if (!opts.caseSensitive) {
    args.push('-i')
  }

  if (opts.includeGlob) {
    args.push('-g', opts.includeGlob)
  }

  if (opts.excludeGlob) {
    args.push('-g', `!${opts.excludeGlob}`)
  }

  args.push('-n') // Show line numbers

  if (opts.contextLinesBefore > 0) {
    args.push('--before-context', String(opts.contextLinesBefore))
  }

  if (opts.contextLinesAfter > 0) {
    args.push('--after-context', String(opts.contextLinesAfter))
  }

  args.push(pattern)
  args.push('.')

  log( `Running: ${rgPath} ${args.join(' ')} in ${workingDir}`)

  return new Promise((resolve) => {
    let output = ''
    let errorOutput = ''
    let processKilled = false
    let timedOut = false
    let truncated = false

    const timeout = setTimeout(() => {
      timedOut = true
      processKilled = true
      if (rgProcess && !rgProcess.killed) {
        rgProcess.kill()
      }
    }, opts.timeoutMs)

    const rgProcess = spawn(rgPath, args, { cwd: workingDir })

    rgProcess.stdout.on('data', (data: Buffer) => {
      const dataStr = data.toString()

      if (output.length + dataStr.length > opts.maxOutputChars) {
        const remainingSpace = opts.maxOutputChars - output.length
        if (remainingSpace > 0) {
          output += dataStr.substring(0, remainingSpace)
        }
        truncated = true
        processKilled = true
        if (!rgProcess.killed) {
          rgProcess.kill()
        }
      } else {
        output += dataStr
      }
    })

    rgProcess.stderr.on('data', (data: Buffer) => {
      errorOutput += data.toString()
    })

    rgProcess.on('close', (code) => {
      clearTimeout(timeout)

      if (!processKilled || truncated || timedOut) {
        const { output: formattedOutput, matches } = processRipgrepOutput(
          output,
          workingDir,
          opts
        )

        // Count unique files
        const fileSet = new Set(matches.filter(m => !m.isContext).map(m => m.file))

        let finalOutput = formattedOutput
        if (truncated) {
          finalOutput += `\n[Output truncated at ${opts.maxOutputChars} characters]`
        }
        if (timedOut) {
          finalOutput += `\n[Search timed out after ${opts.timeoutMs / 1000}s]`
        }

        // For files mode, just list the files
        if (opts.outputFormat === 'files') {
          finalOutput = Array.from(fileSet).join('\n')
        }

        resolve({
          matches,
          formattedOutput: finalOutput.trim() || 'No matches found',
          matchCount: matches.filter(m => !m.isContext).length,
          fileCount: fileSet.size,
          truncated,
          timedOut,
          durationMs: Date.now() - startTime,
        })
      }
    })

    rgProcess.on('error', (err) => {
      clearTimeout(timeout)
      resolve({
        matches: [],
        formattedOutput: `Error: ${err.message}`,
        matchCount: 0,
        fileCount: 0,
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - startTime,
      })
    })

    // Handle abort signal
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        clearTimeout(timeout)
        processKilled = true
        if (!rgProcess.killed) {
          rgProcess.kill()
        }
      }, { once: true })
    }
  })
}

/**
 * Simple grep that returns file list (original behavior)
 */
export async function grepFiles(
  pattern: string,
  searchPath?: string,
  includeGlob?: string,
  abortSignal?: AbortSignal
): Promise<string[]> {
  const result = await enhancedGrep(pattern, searchPath, {
    includeGlob,
    outputFormat: 'files',
  }, abortSignal)

  if (result.matchCount === 0) {
    return []
  }

  const fileSet = new Set(result.matches.filter(m => !m.isContext).map(m => m.file))
  return Array.from(fileSet)
}

/**
 * Grep with context lines
 */
export async function grepWithContext(
  pattern: string,
  searchPath?: string,
  contextLines: number = 3,
  options: Partial<EnhancedGrepOptions> = {},
  abortSignal?: AbortSignal
): Promise<EnhancedGrepResult> {
  return enhancedGrep(pattern, searchPath, {
    ...options,
    contextLinesBefore: contextLines,
    contextLinesAfter: contextLines,
    outputFormat: 'content',
  }, abortSignal)
}
