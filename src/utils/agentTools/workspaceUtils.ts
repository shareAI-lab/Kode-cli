/**
 * WorkspaceUtils - Path utilities and blob name calculation
 *
 * Migrated from AgentTool/11-WorkspaceManagement
 *
 * Features:
 * - SHA256 blob name calculator
 * - Qualified path name handling
 * - Cross-platform path normalization
 */

import * as crypto from 'crypto'
import * as path from 'path'
import * as fs from 'fs/promises'

// ============================================================================
// Qualified Path Name
// ============================================================================

/**
 * Represents a file path with both root and relative components
 */
export interface QualifiedPathName {
  /** The workspace/project root path */
  rootPath: string
  /** The path relative to the root */
  relPath: string
  /** The absolute path (computed) */
  readonly absPath: string
}

/**
 * Create a qualified path name
 */
export function createQualifiedPath(rootPath: string, relPath: string): QualifiedPathName {
  const normalized = normalizeRelativePath(relPath)
  return {
    rootPath: path.normalize(rootPath),
    relPath: normalized,
    get absPath() {
      return path.join(this.rootPath, this.relPath)
    },
  }
}

/**
 * Parse an absolute path into qualified path name
 */
export function parseAbsolutePath(
  absPath: string,
  workspaceRoots: string[]
): QualifiedPathName | null {
  const normalizedAbs = path.normalize(absPath)

  for (const root of workspaceRoots) {
    const normalizedRoot = path.normalize(root)
    if (normalizedAbs.startsWith(normalizedRoot + path.sep) || normalizedAbs === normalizedRoot) {
      const relPath = path.relative(normalizedRoot, normalizedAbs)
      if (!relPath.startsWith('..')) {
        return createQualifiedPath(normalizedRoot, relPath)
      }
    }
  }

  return null
}

// ============================================================================
// Path Normalization
// ============================================================================

/**
 * Normalize a relative path (convert backslashes, remove leading ./)
 */
export function normalizeRelativePath(relativePath: string): string {
  if (!relativePath) return '.'

  return relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '') || '.'
}

/**
 * Join path segments and normalize
 */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/')
}

/**
 * Get the directory name from a path
 */
export function getDirname(filepath: string): string {
  const lastSlash = filepath.lastIndexOf('/')
  if (lastSlash === -1) return ''
  return filepath.slice(0, lastSlash)
}

/**
 * Get the base name from a path
 */
export function getBasename(filepath: string): string {
  const lastSlash = filepath.lastIndexOf('/')
  return lastSlash === -1 ? filepath : filepath.slice(lastSlash + 1)
}

/**
 * Get the file extension
 */
export function getExtension(filepath: string): string {
  const basename = getBasename(filepath)
  const lastDot = basename.lastIndexOf('.')
  return lastDot === -1 ? '' : basename.slice(lastDot)
}

// ============================================================================
// Blob Name Calculator
// ============================================================================

/**
 * Calculate a SHA256 hash of content
 */
export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * Calculate a blob name for file content (git-style)
 *
 * Uses SHA256 of the content with a prefix for content-addressable storage
 */
export function calculateBlobName(content: string | Buffer): string {
  const contentBuffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  const header = `blob ${contentBuffer.length}\0`
  const store = Buffer.concat([Buffer.from(header), contentBuffer])
  return sha256(store)
}

/**
 * Calculate blob name for a file on disk
 */
export async function calculateFileBlobName(filepath: string): Promise<string> {
  const content = await fs.readFile(filepath)
  return calculateBlobName(content)
}

// ============================================================================
// Path Matching
// ============================================================================

/**
 * Simple glob pattern matching (supports * and **)
 */
export function matchGlob(pattern: string, filepath: string): boolean {
  // Escape regex special chars except * and **
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')

  return new RegExp(`^${regex}$`).test(filepath)
}

/**
 * Filter files by glob patterns
 */
export function filterByGlobs(
  files: string[],
  includePatterns: string[],
  excludePatterns: string[] = []
): string[] {
  return files.filter((file) => {
    // Check if excluded
    for (const pattern of excludePatterns) {
      if (matchGlob(pattern, file)) return false
    }

    // Check if included (if no include patterns, include all)
    if (includePatterns.length === 0) return true

    for (const pattern of includePatterns) {
      if (matchGlob(pattern, file)) return true
    }

    return false
  })
}

// ============================================================================
// File Type Detection
// ============================================================================

export enum FileType {
  TEXT = 'text',
  BINARY = 'binary',
  UNKNOWN = 'unknown',
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.asciidoc',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.pyw', '.pyi',
  '.rb', '.erb',
  '.php', '.phtml',
  '.java', '.kt', '.kts', '.groovy', '.scala',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx',
  '.cs', '.fs', '.fsx',
  '.go', '.rs', '.swift', '.m', '.mm',
  '.html', '.htm', '.xhtml', '.xml', '.xsl', '.xslt',
  '.css', '.scss', '.sass', '.less', '.styl',
  '.json', '.jsonc', '.json5',
  '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.config',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.psd1', '.bat', '.cmd',
  '.sql', '.pgsql', '.mysql',
  '.graphql', '.gql',
  '.proto',
  '.r', '.R', '.rmd', '.Rmd',
  '.lua', '.vim', '.el', '.lisp', '.clj', '.cljs', '.cljc', '.edn',
  '.ex', '.exs', '.erl', '.hrl',
  '.hs', '.lhs',
  '.ml', '.mli', '.ocaml',
  '.pas', '.pp',
  '.pl', '.pm', '.pod',
  '.tcl', '.tk',
  '.asm', '.s',
  '.v', '.sv', '.svh', '.vhd', '.vhdl',
  '.cmake', '.make', '.makefile', '.mk',
  '.dockerfile', '.containerfile',
  '.gitignore', '.gitattributes', '.gitmodules',
  '.editorconfig', '.prettierrc', '.eslintrc',
  '.env', '.env.local', '.env.development', '.env.production',
  '.lock', '.lockb',
  '.log',
])

/**
 * Detect file type based on extension
 */
export function detectFileType(filepath: string): FileType {
  const ext = getExtension(filepath).toLowerCase()

  if (TEXT_EXTENSIONS.has(ext)) return FileType.TEXT

  // Check for common binary extensions
  const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff',
    '.mp3', '.mp4', '.wav', '.mov', '.avi', '.mkv', '.m4a', '.aac',
    '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz',
    '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib',
    '.db', '.sqlite', '.sqlite3',
    '.class', '.pyc', '.pyo', '.obj',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.jar', '.war', '.ear', '.apk',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  ])

  if (BINARY_EXTENSIONS.has(ext)) return FileType.BINARY

  return FileType.UNKNOWN
}

// ============================================================================
// Workspace Manager
// ============================================================================

export interface Workspace {
  name: string
  rootPath: string
}

/**
 * WorkspaceManager - Manages multiple workspace roots
 */
export class WorkspaceManager {
  private _workspaces: Workspace[] = []

  /**
   * Add a workspace
   */
  addWorkspace(name: string, rootPath: string): void {
    const existing = this._workspaces.find((w) => w.rootPath === rootPath)
    if (!existing) {
      this._workspaces.push({ name, rootPath: path.normalize(rootPath) })
    }
  }

  /**
   * Remove a workspace
   */
  removeWorkspace(rootPath: string): void {
    this._workspaces = this._workspaces.filter((w) => w.rootPath !== path.normalize(rootPath))
  }

  /**
   * Get all workspaces
   */
  getWorkspaces(): Workspace[] {
    return [...this._workspaces]
  }

  /**
   * Get workspace root paths
   */
  getRootPaths(): string[] {
    return this._workspaces.map((w) => w.rootPath)
  }

  /**
   * Find workspace containing a path
   */
  findWorkspace(filepath: string): Workspace | undefined {
    const normalizedPath = path.normalize(filepath)
    return this._workspaces.find(
      (w) =>
        normalizedPath.startsWith(w.rootPath + path.sep) || normalizedPath === w.rootPath
    )
  }

  /**
   * Parse absolute path to qualified path
   */
  parseAbsolutePath(absPath: string): QualifiedPathName | null {
    return parseAbsolutePath(absPath, this.getRootPaths())
  }

  /**
   * Check if a file is within any workspace
   */
  isWithinWorkspace(filepath: string): boolean {
    return this.findWorkspace(filepath) !== undefined
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let _workspaceManager: WorkspaceManager | undefined

export function getWorkspaceManager(): WorkspaceManager {
  if (!_workspaceManager) {
    _workspaceManager = new WorkspaceManager()
  }
  return _workspaceManager
}
