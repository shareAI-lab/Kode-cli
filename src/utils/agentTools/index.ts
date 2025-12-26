/**
 * AgentTools - Integrated utilities from AgentTool
 *
 * This module provides enhanced functionality integrated from the AgentTool codebase:
 * - Memory System: Snapshot management, pending memories, update notifications
 * - Edit Enhancements: Fuzzy matching, line number tolerance, advanced text processing
 * - Grep Enhancements: Context lines, formatted output, advanced search options
 * - Shell Tool: Safe command execution with YAML-based allowlist and timeout prediction
 * - LCS Algorithm: Longest Common Subsequence for symbol matching
 * - Line Matching: Fuzzy line matching based on symbols
 */

// Memory System
export {
  // Types
  type MemoryEntry,
  type PendingMemoryEntry,
  type PendingMemoriesState,
  type MemoryState,
  type MemoryInfoWithState,
  // Classes
  MemorySnapshotManager,
  PendingMemoriesStore,
  MemoryUpdateManager,
  // Factory functions
  getMemorySnapshotManager,
  getMemoryUpdateManager,
  getPendingMemoriesStore,
  disposeMemorySystem,
} from './memorySystem'

// Edit Enhancements
export {
  // Types
  type Match,
  type EditResult,
  type IndentInfo,
  type EnhancedEditOptions,
  MatchFailReason,
  // Text processing
  removeTrailingWhitespace,
  normalizeLineEndings,
  detectLineEnding,
  restoreLineEndings,
  prepareTextForEditing,
  // Indentation
  detectIndentation,
  removeOneIndentLevel,
  allLinesHaveIndent,
  removeAllIndents,
  // Match finding
  findMatches,
  findClosestMatch,
  // Fuzzy matching
  splitIntoSymbols,
  findLongestCommonSubsequence,
  fuzzyMatchReplacementStrings,
  tryTabIndentFix,
  // Snippets
  createSnippet,
  createSnippetStr,
  // Main function
  enhancedStrReplace,
} from './editEnhancements'

// LCS Algorithm (advanced - from AgentTool)
export {
  findLongestCommonSubsequence as findLCS,
} from './findLcs'

// Fuzzy Line Matching (advanced - from AgentTool)
export {
  splitIntoSymbols as splitSymbols,
  fuzzyMatchLines,
} from './matchLines'

// Advanced Fuzzy Matcher (from AgentTool)
export {
  MatchFailReason as FuzzyMatchFailReason,
  fuzzyMatchReplacementStrings as advancedFuzzyMatch,
} from './fuzzyMatcher'

// Grep Enhancements
export {
  // Types
  type EnhancedGrepOptions,
  type GrepMatch,
  type EnhancedGrepResult,
  // Constants
  REGEX_SYNTAX_GUIDE,
  // Functions
  enhancedGrep,
  grepFiles,
  grepWithContext,
} from './grepEnhancements'

// Shell Tool
export {
  // Types
  type ShellResult,
  type ShellOptions,
  type ShellAllowlist,
  type ShellAllowlistEntry,
  type ShellType,
  // Command safety
  isCommandSafe,
  isCommandBanned,
  getShellAllowlist,
  predictCommandTimeout,
  // Execution
  quoteCommand,
  getDefaultShell,
  executeShell,
  simpleShell,
  executeShellSequence,
  // Utilities
  parseCommand,
  isDirectoryChange,
  getShellType,
} from './shellTool'

// Ignore Rules Manager
export {
  // Types
  type Pathname,
  type TestResult,
  type IgnoreInstance,
  // Factory
  createIgnore,
  // Classes
  IgnoreCache,
  IgnoreRulesManager,
} from './ignoreRulesManager'

// File Walk (high-performance directory traversal)
export {
  // Constants
  EXCLUDED_EXTENSIONS,
  // Functions
  walkFilePaths,
  shouldIncludeFile,
  getTraversableDirectories,
  isExcludedExtension,
} from './fileWalk'

// Locate Snippet (fuzzy code location)
export {
  // Types
  type SnippetLocation,
  type LocateOptions,
  // Functions
  fuzzyLocateSnippet,
  locateSnippetWithQuality,
  findAllSnippetOccurrences,
} from './locateSnippet'

// Apply Patch (V4A diff format)
export {
  // Types
  ActionType,
  type Chunk,
  type PatchAction,
  type Patch,
  DiffError,
  // Parsing
  Parser as PatchParser,
  textToPatch,
  extractFilePaths,
  identifyFilesNeeded,
  identifyFilesAffected,
  // Applying
  getUpdatedFile,
  applyPatch,
  // Constants
  PATCH_PREFIX,
  PATCH_SUFFIX,
  ADD_FILE_PREFIX,
  DELETE_FILE_PREFIX,
  UPDATE_FILE_PREFIX,
} from './applyPatch'

// Checkpoint Manager (file state tracking)
export {
  // Types
  type QualifiedPathName,
  type DiffViewDocument,
  type HydratedCheckpoint,
  type FileChangeSummary,
  type AggregateCheckpointInfo,
  type CheckpointKey,
  EditEventSource,
  // Functions
  createQualifiedPathName,
  createDiffViewDocument,
  createRequestId,
  computeChangesSummary,
  // Classes
  CheckpointManager,
  getCheckpointManager,
} from './checkpointManager'

// Task Manager (hierarchical tasks)
export {
  // Types
  type SerializedTask,
  type HydratedTask,
  type TaskMetadata,
  type TaskManifest,
  type TaskStorage,
  TaskState,
  TaskUpdatedBy,
  // Classes
  TaskFactory,
  TaskManager,
  InMemoryTaskStorage,
  // Functions
  diffTaskTrees,
  getTaskManager,
} from './taskManager'

// Workspace Utils (path utilities)
export {
  // Types
  type QualifiedPathName as WorkspacePathName,
  type Workspace,
  FileType,
  // Path functions
  createQualifiedPath,
  parseAbsolutePath,
  normalizeRelativePath,
  joinPath,
  getDirname,
  getBasename,
  getExtension,
  // Blob functions
  sha256,
  calculateBlobName,
  calculateFileBlobName,
  // Glob functions
  matchGlob,
  filterByGlobs,
  // File type detection
  detectFileType,
  // Classes
  WorkspaceManager,
  getWorkspaceManager,
} from './workspaceUtils'

// Lifecycle Management (disposable patterns)
export {
  // Types
  type IDisposable,
  type IAsyncDisposable,
  type Disposable,
  type EventListener,
  // Functions
  isDisposable,
  combineDisposables,
  disposableTimeout,
  disposableInterval,
  onDispose,
  // Constants
  EmptyDisposable,
  // Classes
  DisposableCollection,
  DisposableService,
  EventEmitter,
} from './lifecycle'

// Command Timeout Predictor (smart timeout learning)
export {
  // Types
  type CommandExecutionRecord,
  type CommandStats,
  type TimeoutPredictorStorage,
  // Storage implementations
  FileTimeoutPredictorStorage,
  InMemoryTimeoutPredictorStorage,
  // Classes
  CommandTimeoutPredictor,
  getTimeoutPredictor,
} from './commandTimeoutPredictor'

// Shell Allowlist (auto-approval rules)
export {
  // Types
  type AllowlistRuleType,
  type ShellAllowlistEntry as AllowlistEntry,
  type ShellAllowlist as Allowlist,
  type ShellType as AllowlistShellType,
  // Functions
  parseCommandNaive,
  getShellAllowlist as getAutoApprovalAllowlist,
  checkShellAllowlist,
  isCommandAutoApproved,
  extendAllowlist,
} from './shellAllowlist'

// Observable (reactive state management)
export {
  // Types
  type ObservableListener,
  type ObservablePredicate,
  type EqualityFn,
  type Unlisten,
  type ReadonlyObservable,
  // Classes
  Observable,
  // Functions
  asReadonly,
  combineObservables,
  observableFromPromise,
  deepEqual,
} from './observable'

// Promise Utilities (async helpers)
export {
  // Types
  type BackoffParams,
  type RetryBackoffResult,
  type RetryParams,
  type RetryLogger,
  // Constants
  defaultBackoffParams,
  // Basic utilities
  delayMs,
  timeoutPromise,
  // Retry functions
  isRetryableError,
  retryWithBackoff,
  retryWithTimes,
  // Classes
  DeferredPromise,
  // Timeout wrappers
  withTimeout,
  withTimeoutFn,
  // Concurrent execution
  parallelLimit,
  allSettledSimple,
  raceWithTimeout,
  // Utility functions
  isPromise,
  ignoreError,
  promisify,
  debounceAsync,
} from './promiseUtils'

// KV Store (key-value storage system)
export {
  // Types
  type KvIteratorOptions,
  type KvBatchOperation,
  type IKvStore,
  type StoredExchange,
  type ConversationMetadata,
  type StoredConversationHistory,
  type ConversationHistoryMetadata,
  // KV Store implementations
  InMemoryKvStore,
  FileKvStore,
  // Managers
  ExchangeManager,
  HistoryManager,
  // Singleton factories
  getKvStore,
  getExchangeManager,
  getHistoryManager,
  resetKvStoreSingletons,
} from './kvStore'
