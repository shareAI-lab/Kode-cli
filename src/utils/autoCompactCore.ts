import { Message } from '@query'
import { countTokens } from './tokens'
import { getMessagesGetter, getMessagesSetter } from '@messages'
import { getContext } from '@context'
import { getCodeStyle } from '@utils/style'
import { clearTerminal } from '@utils/terminal'
import { resetFileFreshnessSession } from '@services/fileFreshness'
import { createUserMessage, normalizeMessagesForAPI } from '@utils/messages'
import { queryLLM } from '@services/claude'
import { selectAndReadFiles } from './fileRecoveryCore'
import { addLineNumbers } from './file'
import { getModelManager } from './model'
import { getGlobalConfig } from './config'

/**
 * Default threshold ratio for triggering automatic context compression
 * When context usage exceeds this ratio of the model's limit, auto-compact activates
 * Users can override this via `autoCompactThreshold` in global config
 */
const DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO = 0.92

/**
 * Gets the auto-compact threshold ratio from config or uses default
 * Lower values = more aggressive compression (happens earlier)
 * Higher values = less aggressive compression (happens later)
 */
function getAutoCompactThresholdRatio(): number {
  const config = getGlobalConfig()
  const threshold = config.autoCompactThreshold

  // Validate threshold is between 0 and 1
  if (typeof threshold === 'number' && threshold > 0 && threshold < 1) {
    return threshold
  }

  return DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO
}

/**
 * Retrieves the context length for the main model that should execute compression
 * Uses ModelManager to get the current model's context length
 */
async function getCompressionModelContextLimit(): Promise<number> {
  try {
    // 🔧 Fix: Use ModelManager instead of legacy config
    const modelManager = getModelManager()
    const modelProfile = modelManager.getModel('main')

    if (modelProfile?.contextLength) {
      return modelProfile.contextLength
    }

    // Fallback to a reasonable default
    return 200_000
  } catch (error) {
    return 200_000
  }
}

const COMPRESSION_PROMPT = `Please provide a comprehensive summary of our conversation structured as follows:

## Technical Context
Development environment, tools, frameworks, and configurations in use. Programming languages, libraries, and technical constraints. File structure, directory organization, and project architecture.

## Project Overview  
Main project goals, features, and scope. Key components, modules, and their relationships. Data models, APIs, and integration patterns.

## Code Changes
Files created, modified, or analyzed during our conversation. Specific code implementations, functions, and algorithms added. Configuration changes and structural modifications.

## Debugging & Issues
Problems encountered and their root causes. Solutions implemented and their effectiveness. Error messages, logs, and diagnostic information.

## Current Status
What we just completed successfully. Current state of the codebase and any ongoing work. Test results, validation steps, and verification performed.

## Pending Tasks
Immediate next steps and priorities. Planned features, improvements, and refactoring. Known issues, technical debt, and areas needing attention.

## User Preferences
Coding style, formatting, and organizational preferences. Communication patterns and feedback style. Tool choices and workflow preferences.

## Key Decisions
Important technical decisions made and their rationale. Alternative approaches considered and why they were rejected. Trade-offs accepted and their implications.

Focus on information essential for continuing the conversation effectively, including specific details about code, files, errors, and plans.`

/**
 * Calculates context usage thresholds based on the main model's capabilities
 * Uses the main model context length since compression tasks require a capable model
 *
 * @param tokenCount Current token count of the conversation
 * @returns Object with threshold calculation results
 */
async function calculateThresholds(tokenCount: number) {
  const contextLimit = await getCompressionModelContextLimit()
  const autoCompactThreshold = contextLimit * getAutoCompactThresholdRatio()

  return {
    isAboveAutoCompactThreshold: tokenCount >= autoCompactThreshold,
    percentUsed: Math.round((tokenCount / contextLimit) * 100),
    tokensRemaining: Math.max(0, autoCompactThreshold - tokenCount),
    contextLimit,
  }
}

/**
 * Determines if auto-compact should trigger based on token usage
 * Uses the main model context limit since compression requires a capable model
 */
async function shouldAutoCompact(messages: Message[]): Promise<boolean> {
  if (messages.length < 3) return false

  const tokenCount = countTokens(messages)
  const { isAboveAutoCompactThreshold } = await calculateThresholds(tokenCount)

  return isAboveAutoCompactThreshold
}

/**
 * Main entry point for automatic context compression
 *
 * This function is called before each query to check if the conversation
 * has grown too large and needs compression. When triggered, it:
 * - Generates a structured summary of the conversation using the main model
 * - Recovers recently accessed files to maintain development context
 * - Resets conversation state while preserving essential information
 *
 * Uses the main model for compression tasks to ensure high-quality summaries
 *
 * @param messages Current conversation messages
 * @param toolUseContext Execution context with model and tool configuration
 * @returns Updated messages (compressed if needed) and compression status
 */
export async function checkAutoCompact(
  messages: Message[],
  toolUseContext: any,
): Promise<{ messages: Message[]; wasCompacted: boolean }> {
  if (!(await shouldAutoCompact(messages))) {
    return { messages, wasCompacted: false }
  }

  try {
    const compactedMessages = await executeAutoCompact(messages, toolUseContext)

    return {
      messages: compactedMessages,
      wasCompacted: true,
    }
  } catch (error) {
    // Graceful degradation: if auto-compact fails, continue with original messages
    // This ensures system remains functional even if compression encounters issues
    console.error(
      'Auto-compact failed, continuing with original messages:',
      error,
    )
    return { messages, wasCompacted: false }
  }
}

/**
 * Executes the conversation compression process using the main model
 *
 * This function generates a comprehensive summary using the main model
 * which is better suited for complex summarization tasks. It also
 * automatically recovers important files to maintain development context.
 */
async function executeAutoCompact(
  messages: Message[],
  toolUseContext: any,
): Promise<Message[]> {
  const summaryRequest = createUserMessage(COMPRESSION_PROMPT)

  const summaryResponse = await queryLLM(
    normalizeMessagesForAPI([...messages, summaryRequest]),
    [
      'You are a helpful AI assistant tasked with creating comprehensive conversation summaries that preserve all essential context for continuing development work.',
    ],
    0,
    toolUseContext.options.tools,
    toolUseContext.abortController.signal,
    {
      safeMode: false,
      model: 'main', // 使用模型指针，让queryLLM统一解析
      prependCLISysprompt: true,
    },
  )

  const content = summaryResponse.message.content
  const summary =
    typeof content === 'string'
      ? content
      : content.length > 0 && content[0]?.type === 'text'
        ? content[0].text
        : null

  if (!summary) {
    throw new Error(
      'Failed to generate conversation summary - response did not contain valid text content',
    )
  }

  summaryResponse.message.usage = {
    input_tokens: 0,
    output_tokens: summaryResponse.message.usage.output_tokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  // Automatic file recovery: preserve recently accessed development files
  // This maintains coding context even after conversation compression
  const recoveredFiles = await selectAndReadFiles()

  const compactedMessages = [
    createUserMessage(
      'Context automatically compressed due to token limit. Essential information preserved.',
    ),
    summaryResponse,
  ]

  // Append recovered files to maintain development workflow continuity
  // Files are prioritized by recency and importance, with strict token limits
  if (recoveredFiles.length > 0) {
    for (const file of recoveredFiles) {
      const contentWithLines = addLineNumbers({
        content: file.content,
        startLine: 1,
      })
      const recoveryMessage = createUserMessage(
        `**Recovered File: ${file.path}**\n\n\`\`\`\n${contentWithLines}\n\`\`\`\n\n` +
          `*Automatically recovered (${file.tokens} tokens)${file.truncated ? ' [truncated]' : ''}*`,
      )
      compactedMessages.push(recoveryMessage)
    }
  }

  // State cleanup to ensure fresh context after compression
  // Mirrors the cleanup sequence from manual /compact command
  getMessagesSetter()([])
  getContext.cache.clear?.()
  getCodeStyle.cache.clear?.()
  resetFileFreshnessSession()

  return compactedMessages
}
