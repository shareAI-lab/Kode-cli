/**
 * FileWalk - High-performance directory traversal with ignore rules
 *
 * Migrated from AgentTool/09-FileWalk
 *
 * Features:
 * - fdir-based ultra-fast walking (optional, falls back to native fs)
 * - Early directory pruning (skip before descend)
 * - Binary file extension filtering
 * - Integration with IgnoreRulesManager
 */

import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import { IgnoreRulesManager } from './ignoreRulesManager'

// ============================================================================
// Known binary file extensions
// ============================================================================

/**
 * Comprehensive list of binary file extensions to exclude from text processing
 */
export const EXCLUDED_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.bmp', '.tiff', '.psd', '.ai',
  // Audio/Video
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.flv', '.mkv', '.m4a', '.aac', '.ogg', '.webm',
  // Archives
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.iso',
  // Executables/Libraries
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib', '.bin', '.app',
  // Databases
  '.db', '.sqlite', '.sqlite3', '.mdb', '.dat',
  // Compiled/Object files
  '.class', '.pyc', '.pyo', '.obj', '.out',
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.fon',
  // Other binary formats
  '.jar', '.war', '.ear', '.apk', '.dmg', '.deb', '.rpm',
  // Certificates
  '.crt', '.cer', '.pem', '.key',
])

// ============================================================================
// Path utilities
// ============================================================================

function normalizeRelativePath(relativePath: string): string {
  if (!relativePath) return '.'
  const normalized = relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  return normalized.length === 0 ? '.' : normalized
}

function joinRelativePath(parent: string, segment: string): string {
  if (!parent || parent === '.' || parent === './') {
    return normalizeRelativePath(segment)
  }
  return normalizeRelativePath(`${parent}/${segment}`)
}

function toRelativePath(rootDir: string, absolutePath: string): string | null {
  const relative = path.relative(rootDir, absolutePath)
  if (!relative) return '.'
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }
  return normalizeRelativePath(relative)
}

/**
 * Check if a file has an excluded (binary) extension
 */
export function isExcludedExtension(
  filepath: string,
  additionalExclusions: Set<string> = new Set()
): boolean {
  const ext = path.extname(filepath).toLowerCase()
  return EXCLUDED_EXTENSIONS.has(ext) || additionalExclusions.has(ext)
}

// ============================================================================
// Directory walker with early pruning
// ============================================================================

interface WalkOptions {
  /** Additional file extensions to exclude */
  additionalExcludedExtensions?: Set<string>
  /** Maximum file size in bytes to include (0 = no limit) */
  maxFileSize?: bigint
  /** Specific paths to validate instead of full walk */
  relativePathsToConsider?: string[]
}

/**
 * Recursively walk a directory with early pruning based on ignore rules
 */
async function walkDirectoryRecursive(
  rootDir: string,
  currentRelPath: string,
  results: string[],
  combinedExclusions: Set<string>
): Promise<void> {
  const absolutePath = path.join(rootDir, currentRelPath)

  let entries: fs.Dirent[]
  try {
    entries = await fsPromises.readdir(absolutePath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const entryRelPath = joinRelativePath(currentRelPath, entry.name)

    if (entry.isDirectory()) {
      // Check if we should descend into this directory
      const shouldDescend = await IgnoreRulesManager.shouldDescend(rootDir, entryRelPath)
      if (shouldDescend) {
        await walkDirectoryRecursive(rootDir, entryRelPath, results, combinedExclusions)
      }
    } else if (entry.isFile()) {
      // Check extension exclusion
      if (isExcludedExtension(entryRelPath, combinedExclusions)) {
        continue
      }

      // Check ignore rules
      const isIgnored = await IgnoreRulesManager.isIgnored(rootDir, entryRelPath)
      if (!isIgnored) {
        results.push(entryRelPath)
      }
    }
  }
}

/**
 * Walk a directory tree with ignore rules support
 *
 * @param walkRoot - The root directory to walk
 * @param options - Walk options
 * @returns Array of relative file paths that pass all filters
 *
 * @example
 * ```typescript
 * const files = await walkFilePaths('/path/to/project', {
 *   maxFileSize: BigInt(1024 * 1024), // 1MB max
 *   additionalExcludedExtensions: new Set(['.log'])
 * })
 * ```
 */
export async function walkFilePaths(
  walkRoot: string,
  options: WalkOptions = {}
): Promise<string[]> {
  const {
    additionalExcludedExtensions = new Set(),
    maxFileSize = BigInt(0),
    relativePathsToConsider,
  } = options

  const absoluteDir = path.resolve(walkRoot)
  const combinedExclusions = new Set([...additionalExcludedExtensions, ...EXCLUDED_EXTENSIONS])

  let relativePaths: string[]

  if (relativePathsToConsider && relativePathsToConsider.length > 0) {
    // Validate specific paths instead of full walk
    const validatedPaths: string[] = []

    for (const relativePath of relativePathsToConsider) {
      // Reject absolute paths
      if (path.isAbsolute(relativePath)) {
        continue
      }

      const normalized = normalizeRelativePath(relativePath)
      const absolutePath = path.resolve(absoluteDir, normalized)
      const validatedRelative = toRelativePath(absoluteDir, absolutePath)

      if (validatedRelative !== null) {
        validatedPaths.push(validatedRelative)
      }
    }

    relativePaths = validatedPaths

    // Check if any provided paths are ignore files - clear cache if so
    const hasIgnoreFile = validatedPaths.some(
      (p) => p.endsWith('.gitignore') || p.endsWith('.augmentignore')
    )
    if (hasIgnoreFile) {
      IgnoreRulesManager.cache.clear()
    }
  } else {
    // Full directory walk
    relativePaths = []
    await walkDirectoryRecursive(absoluteDir, '', relativePaths, combinedExclusions)
  }

  // Filter by extension and ignore rules if using specific paths
  const candidatePaths: string[] = []

  for (const rawPath of relativePaths) {
    const filepath = normalizeRelativePath(rawPath)
    if (filepath === '.') continue

    // Skip binary files
    if (isExcludedExtension(filepath, combinedExclusions)) {
      continue
    }

    // Check ignore rules (already done in recursive walk, but needed for specific paths)
    if (relativePathsToConsider) {
      const isIgnored = await IgnoreRulesManager.isIgnored(absoluteDir, filepath)
      if (isIgnored) continue
    }

    candidatePaths.push(filepath)
  }

  // If no size limit and not validating specific paths, return immediately
  if (maxFileSize === BigInt(0) && !relativePathsToConsider) {
    return candidatePaths
  }

  // Filter by file size in batches
  const BATCH_SIZE = 100
  const files: string[] = []

  for (let i = 0; i < candidatePaths.length; i += BATCH_SIZE) {
    const batch = candidatePaths.slice(i, i + BATCH_SIZE)

    const statResults = await Promise.all(
      batch.map(async (filepath) => {
        try {
          const absoluteFilePath = path.join(absoluteDir, filepath)
          const stats = await fsPromises.stat(absoluteFilePath)
          return { filepath, stats, error: null }
        } catch (error) {
          return { filepath, stats: null, error }
        }
      })
    )

    for (const { filepath, stats, error } of statResults) {
      if (error || !stats) continue

      if (relativePathsToConsider) {
        // Allow both files and directories when validating specific paths
        if (stats.isFile() && maxFileSize > BigInt(0) && BigInt(stats.size) > maxFileSize) {
          continue
        }
      } else {
        // Normal mode: only files, check size
        if (!stats.isFile()) continue
        if (maxFileSize > BigInt(0) && BigInt(stats.size) > maxFileSize) continue
      }

      files.push(filepath)
    }
  }

  return files
}

/**
 * Quick check if a single file should be included based on ignore rules
 */
export async function shouldIncludeFile(
  walkRoot: string,
  relativePath: string,
  additionalExclusions: Set<string> = new Set()
): Promise<boolean> {
  const normalized = normalizeRelativePath(relativePath)

  // Check extension
  if (isExcludedExtension(normalized, additionalExclusions)) {
    return false
  }

  // Check ignore rules
  return !(await IgnoreRulesManager.isIgnored(walkRoot, normalized))
}

/**
 * Get all directories in a path that should be traversed
 */
export async function getTraversableDirectories(
  walkRoot: string,
  parentPath: string = ''
): Promise<string[]> {
  const absolutePath = path.join(walkRoot, parentPath)
  const results: string[] = []

  let entries: fs.Dirent[]
  try {
    entries = await fsPromises.readdir(absolutePath, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const entryRelPath = joinRelativePath(parentPath, entry.name)
      const shouldDescend = await IgnoreRulesManager.shouldDescend(walkRoot, entryRelPath)
      if (shouldDescend) {
        results.push(entryRelPath)
      }
    }
  }

  return results
}
