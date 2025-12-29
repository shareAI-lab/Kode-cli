/**
 * ApplyPatch - V4A diff format parser and applier
 *
 * Migrated from AgentTool/01-FileEditTools/apply-patch-tool
 *
 * Features:
 * - V4A diff format parsing
 * - Context-based matching (no line numbers needed)
 * - @@ class/function scope operators
 * - Add/Update/Delete/Move operations
 * - Unicode punctuation normalization
 */

// ============================================================================
// Constants
// ============================================================================

export const PATCH_PREFIX = '*** Begin Patch\n'
export const PATCH_SUFFIX = '\n*** End Patch'
export const ADD_FILE_PREFIX = '*** Add File: '
export const DELETE_FILE_PREFIX = '*** Delete File: '
export const UPDATE_FILE_PREFIX = '*** Update File: '
export const MOVE_FILE_TO_PREFIX = '*** Move to: '
export const END_OF_FILE_PREFIX = '*** End of File'
export const HUNK_ADD_LINE_PREFIX = '+'

// ============================================================================
// Types
// ============================================================================

export enum ActionType {
  ADD = 'add',
  DELETE = 'delete',
  UPDATE = 'update',
}

export interface Chunk {
  /** Line index of the first line in the original file */
  orig_index: number
  /** Lines to delete */
  del_lines: string[]
  /** Lines to insert */
  ins_lines: string[]
}

export interface PatchAction {
  type: ActionType
  new_file?: string | null
  chunks: Chunk[]
  move_path?: string | null
}

export interface Patch {
  actions: Record<string, PatchAction>
}

export class DiffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiffError'
  }
}

// ============================================================================
// Unicode Punctuation Normalization
// ============================================================================

/**
 * Mapping of visually similar Unicode punctuation to ASCII equivalents
 */
const PUNCT_EQUIV: Record<string, string> = {
  // Hyphen/dash variants
  '-': '-',
  '\u2010': '-', // HYPHEN
  '\u2011': '-', // NO-BREAK HYPHEN
  '\u2012': '-', // FIGURE DASH
  '\u2013': '-', // EN DASH
  '\u2014': '-', // EM DASH
  '\u2212': '-', // MINUS SIGN

  // Double quotes
  '\u0022': '"', // QUOTATION MARK
  '\u201C': '"', // LEFT DOUBLE QUOTATION MARK
  '\u201D': '"', // RIGHT DOUBLE QUOTATION MARK
  '\u201E': '"', // DOUBLE LOW-9 QUOTATION MARK
  '\u00AB': '"', // LEFT-POINTING DOUBLE ANGLE QUOTATION MARK
  '\u00BB': '"', // RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK

  // Single quotes
  '\u0027': "'", // APOSTROPHE
  '\u2018': "'", // LEFT SINGLE QUOTATION MARK
  '\u2019': "'", // RIGHT SINGLE QUOTATION MARK
  '\u201B': "'", // SINGLE HIGH-REVERSED-9 QUOTATION MARK

  // Spaces
  '\u00A0': ' ', // NO-BREAK SPACE
  '\u202F': ' ', // NARROW NO-BREAK SPACE
}

/**
 * Canonicalize string for comparison (Unicode normalization + punctuation mapping)
 */
function canonicalize(s: string): string {
  return s.normalize('NFC').replace(/./gu, (c) => PUNCT_EQUIV[c] ?? c)
}

// ============================================================================
// Context Finding
// ============================================================================

function findContextCore(
  lines: string[],
  context: string[],
  start: number
): [number, number] {
  if (context.length === 0) {
    return [start, 0]
  }

  const canonicalContext = canonicalize(context.join('\n'))

  // Pass 1: exact equality after canonicalization
  for (let i = start; i < lines.length; i++) {
    const segment = canonicalize(lines.slice(i, i + context.length).join('\n'))
    if (segment === canonicalContext) {
      return [i, 0]
    }
  }

  // Pass 2: ignore trailing whitespace
  for (let i = start; i < lines.length; i++) {
    const segment = canonicalize(
      lines
        .slice(i, i + context.length)
        .map((s) => s.trimEnd())
        .join('\n')
    )
    const ctx = canonicalize(context.map((s) => s.trimEnd()).join('\n'))
    if (segment === ctx) {
      return [i, 1]
    }
  }

  // Pass 3: ignore all surrounding whitespace
  for (let i = start; i < lines.length; i++) {
    const segment = canonicalize(
      lines
        .slice(i, i + context.length)
        .map((s) => s.trim())
        .join('\n')
    )
    const ctx = canonicalize(context.map((s) => s.trim()).join('\n'))
    if (segment === ctx) {
      return [i, 100]
    }
  }

  return [-1, 0]
}

function findContext(
  lines: string[],
  context: string[],
  start: number,
  eof: boolean
): [number, number] {
  if (eof) {
    let [newIndex, fuzz] = findContextCore(lines, context, lines.length - context.length)
    if (newIndex !== -1) {
      return [newIndex, fuzz]
    }
    ;[newIndex, fuzz] = findContextCore(lines, context, start)
    return [newIndex, fuzz + 10000]
  }
  return findContextCore(lines, context, start)
}

// ============================================================================
// Section Parsing
// ============================================================================

function peekNextSection(
  lines: string[],
  initialIndex: number
): [string[], Chunk[], number, boolean] {
  let index = initialIndex
  const old: string[] = []
  let delLines: string[] = []
  let insLines: string[] = []
  const chunks: Chunk[] = []
  let mode: 'keep' | 'add' | 'delete' = 'keep'

  while (index < lines.length) {
    const s = lines[index]!
    if (
      [
        '@@',
        PATCH_SUFFIX,
        UPDATE_FILE_PREFIX,
        DELETE_FILE_PREFIX,
        ADD_FILE_PREFIX,
        END_OF_FILE_PREFIX,
      ].some((p) => s.startsWith(p.trim()))
    ) {
      break
    }
    if (s === '***') break
    if (s.startsWith('***')) {
      throw new DiffError(`Invalid Line: ${s}`)
    }

    index += 1
    const lastMode = mode
    let line = s

    if (line[0] === HUNK_ADD_LINE_PREFIX) {
      mode = 'add'
    } else if (line[0] === '-') {
      mode = 'delete'
    } else if (line[0] === ' ') {
      mode = 'keep'
    } else {
      // Tolerate lines without leading whitespace
      mode = 'keep'
      line = ' ' + line
    }

    line = line.slice(1)

    if (mode === 'keep' && lastMode !== mode) {
      if (insLines.length || delLines.length) {
        chunks.push({
          orig_index: old.length - delLines.length,
          del_lines: delLines,
          ins_lines: insLines,
        })
      }
      delLines = []
      insLines = []
    }

    if (mode === 'delete') {
      delLines.push(line)
      old.push(line)
    } else if (mode === 'add') {
      insLines.push(line)
    } else {
      old.push(line)
    }
  }

  if (insLines.length || delLines.length) {
    chunks.push({
      orig_index: old.length - delLines.length,
      del_lines: delLines,
      ins_lines: insLines,
    })
  }

  if (index < lines.length && lines[index] === END_OF_FILE_PREFIX) {
    index += 1
    return [old, chunks, index, true]
  }

  return [old, chunks, index, false]
}

// ============================================================================
// Parser
// ============================================================================

export class Parser {
  currentFiles: Record<string, string>
  lines: string[]
  index = 0
  patch: Patch = { actions: {} }
  fuzz = 0

  constructor(currentFiles: Record<string, string>, lines: string[]) {
    this.currentFiles = currentFiles
    this.lines = lines
  }

  private isDone(prefixes?: string[]): boolean {
    if (this.index >= this.lines.length) return true
    if (prefixes && prefixes.some((p) => this.lines[this.index]!.startsWith(p.trim()))) {
      return true
    }
    return false
  }

  private startsWith(prefix: string | string[]): boolean {
    const prefixes = Array.isArray(prefix) ? prefix : [prefix]
    return prefixes.some((p) => this.lines[this.index]!.startsWith(p))
  }

  private readStr(prefix = '', returnEverything = false): string {
    if (this.index >= this.lines.length) {
      throw new DiffError(`Index: ${this.index} >= ${this.lines.length}`)
    }
    if (this.lines[this.index]!.startsWith(prefix)) {
      const text = returnEverything
        ? this.lines[this.index]
        : this.lines[this.index]!.slice(prefix.length)
      this.index += 1
      return text ?? ''
    }
    return ''
  }

  parse(): void {
    while (!this.isDone([PATCH_SUFFIX])) {
      let path = this.readStr(UPDATE_FILE_PREFIX)
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Update File Error: Duplicate Path: ${path}`)
        }
        const moveTo = this.readStr(MOVE_FILE_TO_PREFIX)
        if (!(path in this.currentFiles)) {
          throw new DiffError(`Update File Error: Missing File: ${path}`)
        }
        const text = this.currentFiles[path]
        const action = this.parseUpdateFile(text ?? '')
        action.move_path = moveTo || undefined
        this.patch.actions[path] = action
        continue
      }

      path = this.readStr(DELETE_FILE_PREFIX)
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Delete File Error: Duplicate Path: ${path}`)
        }
        if (!(path in this.currentFiles)) {
          throw new DiffError(`Delete File Error: Missing File: ${path}`)
        }
        this.patch.actions[path] = { type: ActionType.DELETE, chunks: [] }
        continue
      }

      path = this.readStr(ADD_FILE_PREFIX)
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Add File Error: Duplicate Path: ${path}`)
        }
        if (path in this.currentFiles) {
          throw new DiffError(`Add File Error: File already exists: ${path}`)
        }
        this.patch.actions[path] = this.parseAddFile()
        continue
      }

      throw new DiffError(`Unknown Line: ${this.lines[this.index]}`)
    }

    if (!this.startsWith(PATCH_SUFFIX.trim())) {
      throw new DiffError('Missing End Patch')
    }
    this.index += 1
  }

  private parseUpdateFile(fileContent: string): PatchAction {
    const action: PatchAction = { type: ActionType.UPDATE, chunks: [] }
    const fileLines = fileContent.split('\n')
    let index = 0

    while (
      !this.isDone([
        PATCH_SUFFIX,
        UPDATE_FILE_PREFIX,
        DELETE_FILE_PREFIX,
        ADD_FILE_PREFIX,
        END_OF_FILE_PREFIX,
      ])
    ) {
      const defStr = this.readStr('@@ ')
      let sectionStr = ''
      if (!defStr && this.lines[this.index] === '@@') {
        sectionStr = this.lines[this.index]!
        this.index += 1
      }

      if (!(defStr || sectionStr || index === 0)) {
        throw new DiffError(`Invalid Line:\n${this.lines[this.index]}`)
      }

      if (defStr.trim()) {
        let found = false
        const canonLocal = (s: string): string => canonicalize(s)

        if (!fileLines.slice(0, index).some((s) => canonLocal(s) === canonLocal(defStr))) {
          for (let i = index; i < fileLines.length; i++) {
            if (canonLocal(fileLines[i]!) === canonLocal(defStr)) {
              index = i + 1
              found = true
              break
            }
          }
        }

        if (
          !found &&
          !fileLines.slice(0, index).some((s) => canonLocal(s.trim()) === canonLocal(defStr.trim()))
        ) {
          for (let i = index; i < fileLines.length; i++) {
            if (canonLocal(fileLines[i]!.trim()) === canonLocal(defStr.trim())) {
              index = i + 1
              this.fuzz += 1
              found = true
              break
            }
          }
        }
      }

      const [nextChunkContext, chunks, endPatchIndex, eof] = peekNextSection(this.lines, this.index)
      const [newIndex, fuzz] = findContext(fileLines, nextChunkContext, index, eof)

      if (newIndex === -1) {
        const ctxText = nextChunkContext.join('\n')
        if (eof) {
          throw new DiffError(`Invalid EOF Context ${index}:\n${ctxText}`)
        } else {
          throw new DiffError(`Invalid Context ${index}:\n${ctxText}`)
        }
      }

      this.fuzz += fuzz
      for (const ch of chunks) {
        ch.orig_index += newIndex
        action.chunks.push(ch)
      }
      index = newIndex + nextChunkContext.length
      this.index = endPatchIndex
    }

    return action
  }

  private parseAddFile(): PatchAction {
    const lines: string[] = []
    while (!this.isDone([PATCH_SUFFIX, UPDATE_FILE_PREFIX, DELETE_FILE_PREFIX, ADD_FILE_PREFIX])) {
      const s = this.readStr()
      if (!s.startsWith(HUNK_ADD_LINE_PREFIX)) {
        throw new DiffError(`Invalid Add File Line: ${s}`)
      }
      lines.push(s.slice(1))
    }
    return {
      type: ActionType.ADD,
      new_file: lines.join('\n'),
      chunks: [],
    }
  }
}

// ============================================================================
// High-level API
// ============================================================================

/**
 * Parse patch text into a Patch object
 *
 * @param patchText - The patch text in V4A format
 * @param fileContents - Map of file paths to their current contents
 * @returns Tuple of [Patch, fuzz score]
 */
export function textToPatch(
  patchText: string,
  fileContents: Record<string, string>
): [Patch, number] {
  const lines = patchText.trim().split('\n')

  if (
    lines.length < 2 ||
    !(lines[0] ?? '').startsWith(PATCH_PREFIX.trim()) ||
    lines[lines.length - 1] !== PATCH_SUFFIX.trim()
  ) {
    let reason = 'Invalid patch text: '
    if (lines.length < 2) {
      reason += 'Patch text must have at least two lines.'
    } else if (!(lines[0] ?? '').startsWith(PATCH_PREFIX.trim())) {
      reason += 'Patch text must start with the correct patch prefix.'
    } else if (lines[lines.length - 1] !== PATCH_SUFFIX.trim()) {
      reason += 'Patch text must end with the correct patch suffix.'
    }
    throw new DiffError(reason)
  }

  const parser = new Parser(fileContents, lines)
  parser.index = 1
  parser.parse()
  return [parser.patch, parser.fuzz]
}

/**
 * Extract file paths from patch text
 */
export function extractFilePaths(patchText: string): {
  added: string[]
  updated: string[]
  deleted: string[]
} {
  const lines = patchText.trim().split('\n')
  const added = new Set<string>()
  const updated = new Set<string>()
  const deleted = new Set<string>()

  for (const line of lines) {
    if (line.startsWith(ADD_FILE_PREFIX)) {
      added.add(line.slice(ADD_FILE_PREFIX.length))
    }
    if (line.startsWith(UPDATE_FILE_PREFIX)) {
      updated.add(line.slice(UPDATE_FILE_PREFIX.length))
    }
    if (line.startsWith(DELETE_FILE_PREFIX)) {
      deleted.add(line.slice(DELETE_FILE_PREFIX.length))
    }
  }

  return {
    added: [...added],
    updated: [...updated],
    deleted: [...deleted],
  }
}

/**
 * Identify files that need to be read before applying patch
 */
export function identifyFilesNeeded(patchText: string): string[] {
  const { updated, deleted } = extractFilePaths(patchText)
  return [...new Set([...updated, ...deleted])]
}

/**
 * Identify all files affected by the patch
 */
export function identifyFilesAffected(patchText: string): string[] {
  const { added, updated, deleted } = extractFilePaths(patchText)
  return [...new Set([...added, ...updated, ...deleted])]
}

/**
 * Apply UPDATE action to get the new file content
 *
 * @param originalText - Original file content
 * @param action - The patch action to apply
 * @param path - File path (for error messages)
 * @returns Updated file content
 */
export function getUpdatedFile(originalText: string, action: PatchAction, path: string): string {
  if (action.type !== ActionType.UPDATE) {
    throw new DiffError('Expected UPDATE action')
  }

  const origLines = originalText.split('\n')
  const destLines: string[] = []
  let origIndex = 0

  for (const chunk of action.chunks) {
    if (chunk.orig_index > origLines.length) {
      throw new DiffError(
        `${path}: chunk.orig_index ${chunk.orig_index} > len(lines) ${origLines.length}`
      )
    }
    if (origIndex > chunk.orig_index) {
      throw new DiffError(`${path}: orig_index ${origIndex} > chunk.orig_index ${chunk.orig_index}`)
    }

    destLines.push(...origLines.slice(origIndex, chunk.orig_index))
    origIndex = chunk.orig_index

    // Insert new lines
    if (chunk.ins_lines.length) {
      destLines.push(...chunk.ins_lines)
    }

    origIndex += chunk.del_lines.length
  }

  destLines.push(...origLines.slice(origIndex))
  return destLines.join('\n')
}

/**
 * Apply a complete patch to file contents
 *
 * @param patch - The parsed patch
 * @param fileContents - Current file contents
 * @returns Map of file paths to their new contents (undefined = deleted)
 */
export function applyPatch(
  patch: Patch,
  fileContents: Record<string, string>
): Record<string, string | undefined> {
  const results: Record<string, string | undefined> = {}

  for (const [path, action] of Object.entries(patch.actions)) {
    switch (action.type) {
      case ActionType.ADD:
        results[path] = action.new_file ?? ''
        break

      case ActionType.DELETE:
        results[path] = undefined
        break

      case ActionType.UPDATE:
        const originalContent = fileContents[path] ?? ''
        const newContent = getUpdatedFile(originalContent, action, path)

        if (action.move_path) {
          // Delete original, add at new path
          results[path] = undefined
          results[action.move_path] = newContent
        } else {
          results[path] = newContent
        }
        break
    }
  }

  return results
}
