import '@anthropic-ai/sdk/shims/node'
import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk'
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import chalk from 'chalk'
import { createHash, randomUUID, UUID } from 'crypto'
import 'dotenv/config'

import { addToTotalCost } from '@costTracker'
import models from '@constants/models'
import type { AssistantMessage, UserMessage } from '@query'
import { Tool } from '@tool'
import {
  getAnthropicApiKey,
  getOrCreateUserID,
  getGlobalConfig,
  ModelProfile,
} from '@utils/config'
import { getProjectDocs } from '@context'
import { logError, SESSION_ID } from '@utils/log'
import { USER_AGENT } from '@utils/http'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
} from '@utils/messages'
import { countTokens } from '@utils/tokens'
import { withVCR } from './vcr'
import {
  debug as debugLogger,
  markPhase,
  getCurrentRequest,
  logLLMInteraction,
  logSystemPromptConstruction,
  logErrorWithDiagnosis,
} from '@utils/debugLogger'
import {
  MessageContextManager,
  createRetentionStrategy,
} from '@utils/messageContextManager'
import { getModelManager } from '@utils/model'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream.mjs'
import { ModelAdapterFactory } from './modelAdapterFactory'
import { UnifiedRequestParams } from '@kode-types/modelCapabilities'
import { responseStateManager, getConversationId } from './responseStateManager'
import type { ToolUseContext } from '@tool'
import type {
  Message as APIMessage,
  MessageParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { USE_BEDROCK, USE_VERTEX } from '@utils/model'
import { getCLISyspromptPrefix } from '@constants/prompts'
import { getVertexRegionForModel } from '@utils/model'
import OpenAI from 'openai'
import type { ChatCompletionStream } from 'openai/lib/ChatCompletionStream'
import { ContentBlock } from '@anthropic-ai/sdk/resources/messages/messages'
import { nanoid } from 'nanoid'
import { getCompletionWithProfile, getGPT5CompletionWithProfile } from './openai'
import { getReasoningEffort } from '@utils/thinking'
import { generateSystemReminders } from './systemReminder'

// Helper function to check if a model is GPT-5
function isGPT5Model(modelName: string): boolean {
  return modelName.startsWith('gpt-5')
}

// Helper function to extract model configuration for debug logging
function getModelConfigForDebug(model: string): {
  modelName: string
  provider: string
  apiKeyStatus: 'configured' | 'missing' | 'invalid'
  baseURL?: string
  maxTokens?: number
  reasoningEffort?: string
  isStream?: boolean
  temperature?: number
} {
  const config = getGlobalConfig()
  const modelManager = getModelManager()


  const modelProfile = modelManager.getModel('main')

  let apiKeyStatus: 'configured' | 'missing' | 'invalid' = 'missing'
  let baseURL: string | undefined
  let maxTokens: number | undefined
  let reasoningEffort: string | undefined


  if (modelProfile) {
    apiKeyStatus = modelProfile.apiKey ? 'configured' : 'missing'
    baseURL = modelProfile.baseURL
    maxTokens = modelProfile.maxTokens
    reasoningEffort = modelProfile.reasoningEffort
  } else {
    // 🚨 No ModelProfile available - this should not happen in modern system
    apiKeyStatus = 'missing'
    maxTokens = undefined
    reasoningEffort = undefined
  }

  return {
    modelName: model,
    provider: modelProfile?.provider || config.primaryProvider || 'anthropic',
    apiKeyStatus,
    baseURL,
    maxTokens,
    reasoningEffort,
    isStream: config.stream || false,
    temperature: MAIN_QUERY_TEMPERATURE,
  }
}

// KodeContext管理器 - 用于项目文档的同步缓存和访问
class KodeContextManager {
  private static instance: KodeContextManager
  private projectDocsCache: string = ''
  private cacheInitialized: boolean = false
  private initPromise: Promise<void> | null = null

  private constructor() {}

  public static getInstance(): KodeContextManager {
    if (!KodeContextManager.instance) {
      KodeContextManager.instance = new KodeContextManager()
    }
    return KodeContextManager.instance
  }

  public async initialize(): Promise<void> {
    if (this.cacheInitialized) return

    if (this.initPromise) {
      return this.initPromise
    }

    this.initPromise = this.loadProjectDocs()
    await this.initPromise
  }

  private async loadProjectDocs(): Promise<void> {
    try {
      const projectDocs = await getProjectDocs()
      this.projectDocsCache = projectDocs || ''
      this.cacheInitialized = true

      // 在调试模式下记录加载结果
      if (process.env.NODE_ENV === 'development') {
        debugLogger.info('KODE_CONTEXT_LOADED', {
          characters: this.projectDocsCache.length,
        })
      }
    } catch (error) {
      console.warn('[KodeContext] Failed to load project docs:', error)
      this.projectDocsCache = ''
      this.cacheInitialized = true
    }
  }

  public getKodeContext(): string {
    if (!this.cacheInitialized) {
      // 如果未初始化，异步初始化但立即返回空字符串
      this.initialize().catch(console.warn)
      return ''
    }
    return this.projectDocsCache
  }

  public async refreshCache(): Promise<void> {
    this.cacheInitialized = false
    this.initPromise = null
    await this.initialize()
  }
}

// 导出函数保持向后兼容
const kodeContextManager = KodeContextManager.getInstance()

// 在模块加载时异步初始化
kodeContextManager.initialize().catch(console.warn)

export const generateKodeContext = (): string => {
  return kodeContextManager.getKodeContext()
}

export const refreshKodeContext = async (): Promise<void> => {
  await kodeContextManager.refreshCache()
}

interface StreamResponse extends APIMessage {
  ttftMs?: number
}

export const API_ERROR_MESSAGE_PREFIX = 'API Error'
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'
export const INVALID_API_KEY_ERROR_MESSAGE =
  'Invalid API key · Please run /login'
export const NO_CONTENT_MESSAGE = '(no content)'
const PROMPT_CACHING_ENABLED = !process.env.DISABLE_PROMPT_CACHING

// @see https://docs.anthropic.com/en/docs/about-claude/models#model-comparison-table
const HAIKU_COST_PER_MILLION_INPUT_TOKENS = 0.8
const HAIKU_COST_PER_MILLION_OUTPUT_TOKENS = 4
const HAIKU_COST_PER_MILLION_PROMPT_CACHE_WRITE_TOKENS = 1
const HAIKU_COST_PER_MILLION_PROMPT_CACHE_READ_TOKENS = 0.08

const SONNET_COST_PER_MILLION_INPUT_TOKENS = 3
const SONNET_COST_PER_MILLION_OUTPUT_TOKENS = 15
const SONNET_COST_PER_MILLION_PROMPT_CACHE_WRITE_TOKENS = 3.75
const SONNET_COST_PER_MILLION_PROMPT_CACHE_READ_TOKENS = 0.3

export const MAIN_QUERY_TEMPERATURE = 1 // to get more variation for binary feedback

function getMetadata() {
  return {
    user_id: `${getOrCreateUserID()}_${SESSION_ID}`,
  }
}

const MAX_RETRIES = process.env.USER_TYPE === 'SWE_BENCH' ? 100 : 10
const BASE_DELAY_MS = 500

interface RetryOptions {
  maxRetries?: number
  signal?: AbortSignal
}

// Helper function to create an abortable delay
function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already aborted
    if (signal?.aborted) {
      reject(new Error('Request was aborted'))
      return
    }

    const timeoutId = setTimeout(() => {
      resolve()
    }, delayMs)

    // If signal is provided, listen for abort event
    if (signal) {
      const abortHandler = () => {
        clearTimeout(timeoutId)
        reject(new Error('Request was aborted'))
      }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
}

function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 32000) // Max 32s delay
}

function shouldRetry(error: APIError): boolean {
  // Check for overloaded errors first and only retry for SWE_BENCH
  if (error.message?.includes('"type":"overloaded_error"')) {
    return process.env.USER_TYPE === 'SWE_BENCH'
  }

  // Note this is not a standard header.
  const shouldRetryHeader = error.headers?.['x-should-retry']

  // If the server explicitly says whether or not to retry, obey.
  if (shouldRetryHeader === 'true') return true
  if (shouldRetryHeader === 'false') return false

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  // Retry on request timeouts.
  if (error.status === 408) return true

  // Retry on lock timeouts.
  if (error.status === 409) return true

  // Retry on rate limits.
  if (error.status === 429) return true

  // Retry internal errors.
  if (error.status && error.status >= 500) return true

  return false
}

async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  let lastError: unknown

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      // Only retry if the error indicates we should
      if (
        attempt > maxRetries ||
        !(error instanceof APIError) ||
        !shouldRetry(error)
      ) {
        throw error
      }

      if (options.signal?.aborted) {
        throw new Error('Request cancelled by user')
      }
      
      // Get retry-after header if available
      const retryAfter = error.headers?.['retry-after'] ?? null
      const delayMs = getRetryDelay(attempt, retryAfter)

      console.log(
        `  ⎿  ${chalk.red(`API ${error.name} (${error.message}) · Retrying in ${Math.round(delayMs / 1000)} seconds… (attempt ${attempt}/${maxRetries})`)}`,
      )

      

      try {
        await abortableDelay(delayMs, options.signal)
      } catch (delayError) {
        // If aborted during delay, throw the error to stop retrying
        if (delayError.message === 'Request was aborted') {
          throw new Error('Request cancelled by user')
        }
        throw delayError
      }
    }
  }

  throw lastError
}

/**
 * Fetch available models from Anthropic API
 */
export async function fetchAnthropicModels(
  baseURL: string,
  apiKey: string,
): Promise<any[]> {
  try {
    // Use provided baseURL or default to official Anthropic API
    const modelsURL = baseURL
      ? `${baseURL.replace(/\/+$/, '')}/v1/models`
      : 'https://api.anthropic.com/v1/models'

    const response = await fetch(modelsURL, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'User-Agent': USER_AGENT,
      },
    })

    if (!response.ok) {
      // Provide user-friendly error messages based on status code
      if (response.status === 401) {
        throw new Error(
          'Invalid API key. Please check your Anthropic API key and try again.',
        )
      } else if (response.status === 403) {
        throw new Error(
          'API key does not have permission to access models. Please check your API key permissions.',
        )
      } else if (response.status === 429) {
        throw new Error(
          'Too many requests. Please wait a moment and try again.',
        )
      } else if (response.status >= 500) {
        throw new Error(
          'Anthropic service is temporarily unavailable. Please try again later.',
        )
      } else {
        throw new Error(
          `Unable to connect to Anthropic API (${response.status}). Please check your internet connection and API key.`,
        )
      }
    }

    const data = await response.json()
    return data.data || []
  } catch (error) {
    // If it's already our custom error, pass it through
    if (
      (error instanceof Error && error.message.includes('API key')) ||
      (error instanceof Error && error.message.includes('Anthropic'))
    ) {
      throw error
    }

    // For network errors or other issues
    console.error('Failed to fetch Anthropic models:', error)
    throw new Error(
      'Unable to connect to Anthropic API. Please check your internet connection and try again.',
    )
  }
}

export async function verifyApiKey(
  apiKey: string,
  baseURL?: string,
  provider?: string,
): Promise<boolean> {
  if (!apiKey) {
    return false
  }

  // For non-Anthropic providers, use OpenAI-compatible verification
  if (provider && provider !== 'anthropic') {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      }


      if (!baseURL) {
        console.warn(
          'No baseURL provided for non-Anthropic provider verification',
        )
        return false
      }

      const modelsURL = `${baseURL.replace(/\/+$/, '')}/models`

      const response = await fetch(modelsURL, {
        method: 'GET',
        headers,
      })

      return response.ok
    } catch (error) {
      console.warn('API verification failed for non-Anthropic provider:', error)
      return false
    }
  }

  // For Anthropic and Anthropic-compatible APIs
  const clientConfig: any = {
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 3,
    defaultHeaders: {
      'User-Agent': USER_AGENT,
    },
  }

  // Only add baseURL for true Anthropic-compatible APIs
  if (
    baseURL &&
    (provider === 'anthropic' ||
      provider === 'bigdream' ||
      provider === 'opendev')
  ) {
    clientConfig.baseURL = baseURL
  }

  const anthropic = new Anthropic(clientConfig)

  try {
    await withRetry(
      async () => {
        const model = 'claude-sonnet-4-20250514'
        const messages: MessageParam[] = [{ role: 'user', content: 'test' }]
        await anthropic.messages.create({
          model,
          max_tokens: 1000, // Simple test token limit for API verification
          messages,
          temperature: 0,
          metadata: getMetadata(),
        })
        return true
      },
      { maxRetries: 2 }, // Use fewer retries for API key verification
    )
    return true
  } catch (error) {
    logError(error)
    // Check for authentication error
    if (
      error instanceof Error &&
      error.message.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      )
    ) {
      return false
    }
    throw error
  }
}

function convertAnthropicMessagesToOpenAIMessages(
  messages: (UserMessage | AssistantMessage)[],
): (
  | OpenAI.ChatCompletionMessageParam
  | OpenAI.ChatCompletionToolMessageParam
)[] {
  const openaiMessages: (
    | OpenAI.ChatCompletionMessageParam
    | OpenAI.ChatCompletionToolMessageParam
  )[] = []

  const toolResults: Record<string, OpenAI.ChatCompletionToolMessageParam> = {}

  for (const message of messages) {
    let contentBlocks = []
    if (typeof message.message.content === 'string') {
      contentBlocks = [
        {
          type: 'text',
          text: message.message.content,
        },
      ]
    } else if (!Array.isArray(message.message.content)) {
      contentBlocks = [message.message.content]
    } else {
      contentBlocks = message.message.content
    }

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        openaiMessages.push({
          role: message.message.role,
          content: block.text,
        })
      } else if (block.type === 'tool_use') {
        openaiMessages.push({
          role: 'assistant',
          content: undefined,
          tool_calls: [
            {
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
              id: block.id,
            },
          ],
        })
      } else if (block.type === 'tool_result') {
        // Ensure content is always a string for role:tool messages
        let toolContent = block.content
        if (typeof toolContent !== 'string') {
          // Convert content to string if it's not already
          toolContent = JSON.stringify(toolContent)
        }

        toolResults[block.tool_use_id] = {
          role: 'tool',
          content: toolContent,
          tool_call_id: block.tool_use_id,
        }
      }
    }
  }

  const finalMessages: (
    | OpenAI.ChatCompletionMessageParam
    | OpenAI.ChatCompletionToolMessageParam
  )[] = []

  for (const message of openaiMessages) {
    finalMessages.push(message)

    if ('tool_calls' in message && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolResults[toolCall.id]) {
          finalMessages.push(toolResults[toolCall.id])
        }
      }
    }
  }

  return finalMessages
}

function messageReducer(
  previous: OpenAI.ChatCompletionMessage,
  item: OpenAI.ChatCompletionChunk,
): OpenAI.ChatCompletionMessage {
  const reduce = (acc: any, delta: OpenAI.ChatCompletionChunk.Choice.Delta) => {
    acc = { ...acc }
    for (const [key, value] of Object.entries(delta)) {
      if (acc[key] === undefined || acc[key] === null) {
        acc[key] = value
        //  OpenAI.Chat.Completions.ChatCompletionMessageToolCall does not have a key, .index
        if (Array.isArray(acc[key])) {
          for (const arr of acc[key]) {
            delete arr.index
          }
        }
      } else if (typeof acc[key] === 'string' && typeof value === 'string') {
        acc[key] += value
      } else if (typeof acc[key] === 'number' && typeof value === 'number') {
        acc[key] = value
      } else if (Array.isArray(acc[key]) && Array.isArray(value)) {
        const accArray = acc[key]
        for (let i = 0; i < value.length; i++) {
          const { index, ...chunkTool } = value[i]
          if (index - accArray.length > 1) {
            throw new Error(
              `Error: An array has an empty value when tool_calls are constructed. tool_calls: ${accArray}; tool: ${value}`,
            )
          }
          accArray[index] = reduce(accArray[index], chunkTool)
        }
      } else if (typeof acc[key] === 'object' && typeof value === 'object') {
        acc[key] = reduce(acc[key], value)
      }
    }
    return acc
  }

  const choice = item.choices?.[0]
  if (!choice) {
    // chunk contains information about usage and token counts
    return previous
  }
  return reduce(previous, choice.delta) as OpenAI.ChatCompletionMessage
}
async function handleMessageStream(
  stream: ChatCompletionStream,
  signal?: AbortSignal,
): Promise<OpenAI.ChatCompletion> {
  const streamStartTime = Date.now()
  let ttftMs: number | undefined
  let chunkCount = 0
  let errorCount = 0

  debugLogger.api('OPENAI_STREAM_START', {
    streamStartTime: String(streamStartTime),
  })

  let message = {} as OpenAI.ChatCompletionMessage

  let id, model, created, object, usage
  try {
    for await (const chunk of stream) {

      if (signal?.aborted) {
        debugLogger.flow('OPENAI_STREAM_ABORTED', { 
          chunkCount,
          timestamp: Date.now() 
        })
        throw new Error('Request was cancelled')
      }
      
      chunkCount++

      try {
        if (!id) {
          id = chunk.id
          debugLogger.api('OPENAI_STREAM_ID_RECEIVED', {
            id,
            chunkNumber: String(chunkCount),
          })
        }
        if (!model) {
          model = chunk.model
          debugLogger.api('OPENAI_STREAM_MODEL_RECEIVED', {
            model,
            chunkNumber: String(chunkCount),
          })
        }
        if (!created) {
          created = chunk.created
        }
        if (!object) {
          object = chunk.object
        }
        if (!usage) {
          usage = chunk.usage
        }

        message = messageReducer(message, chunk)

        if (chunk?.choices?.[0]?.delta?.content) {
          if (!ttftMs) {
            ttftMs = Date.now() - streamStartTime
            debugLogger.api('OPENAI_STREAM_FIRST_TOKEN', {
              ttftMs: String(ttftMs),
              chunkNumber: String(chunkCount),
            })
          }
        }
      } catch (chunkError) {
        errorCount++
        debugLogger.error('OPENAI_STREAM_CHUNK_ERROR', {
          chunkNumber: String(chunkCount),
          errorMessage:
            chunkError instanceof Error
              ? chunkError.message
              : String(chunkError),
          errorType:
            chunkError instanceof Error
              ? chunkError.constructor.name
              : typeof chunkError,
        })
        // Continue processing other chunks
      }
    }

    debugLogger.api('OPENAI_STREAM_COMPLETE', {
      totalChunks: String(chunkCount),
      errorCount: String(errorCount),
      totalDuration: String(Date.now() - streamStartTime),
      ttftMs: String(ttftMs || 0),
      finalMessageId: id || 'undefined',
    })
  } catch (streamError) {
    debugLogger.error('OPENAI_STREAM_FATAL_ERROR', {
      totalChunks: String(chunkCount),
      errorCount: String(errorCount),
      errorMessage:
        streamError instanceof Error
          ? streamError.message
          : String(streamError),
      errorType:
        streamError instanceof Error
          ? streamError.constructor.name
          : typeof streamError,
    })
    throw streamError
  }
  return {
    id,
    created,
    model,
    object,
    choices: [
      {
        index: 0,
        message,
        finish_reason: 'stop',
        logprobs: undefined,
      },
    ],
    usage,
  }
}

function convertOpenAIResponseToAnthropic(response: OpenAI.ChatCompletion, tools?: Tool[]) {
  let contentBlocks: ContentBlock[] = []
  const message = response.choices?.[0]?.message
  if (!message) {
    return {
      role: 'assistant',
      content: [],
      stop_reason: response.choices?.[0]?.finish_reason,
      type: 'message',
      usage: response.usage,
    }
  }

  if (message?.tool_calls) {
    for (const toolCall of message.tool_calls) {
      const tool = toolCall.function
      const toolName = tool?.name
      let toolArgs = {}
      try {
        toolArgs = tool?.arguments ? JSON.parse(tool.arguments) : {}
      } catch (e) {
        // Invalid JSON in tool arguments
      }

      contentBlocks.push({
        type: 'tool_use',
        input: toolArgs,
        name: toolName,
        id: toolCall.id?.length > 0 ? toolCall.id : nanoid(),
      })
    }
  }

  if ((message as any).reasoning) {
    contentBlocks.push({
      type: 'thinking',
      thinking: (message as any).reasoning,
      signature: '',
    })
  }

  // NOTE: For deepseek api, the key for its returned reasoning process is reasoning_content
  if ((message as any).reasoning_content) {
    contentBlocks.push({
      type: 'thinking',
      thinking: (message as any).reasoning_content,
      signature: '',
    })
  }

  if (message.content) {
    contentBlocks.push({
      type: 'text',
      text: message?.content,
      citations: [],
    })
  }

  const finalMessage = {
    role: 'assistant',
    content: contentBlocks,
    stop_reason: response.choices?.[0]?.finish_reason,
    type: 'message',
    usage: response.usage,
  }


  return finalMessage
}

let anthropicClient: Anthropic | AnthropicBedrock | AnthropicVertex | null =
  null

/**
 * Get the Anthropic client, creating it if it doesn't exist
 */
export function getAnthropicClient(
  model?: string,
): Anthropic | AnthropicBedrock | AnthropicVertex {
  const config = getGlobalConfig()
  const provider = config.primaryProvider

  // Reset client if provider has changed to ensure correct configuration
  if (anthropicClient && provider) {
    // Always recreate client for provider-specific configurations
    anthropicClient = null
  }

  if (anthropicClient) {
    return anthropicClient
  }

  const region = getVertexRegionForModel(model)

  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': USER_AGENT,
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    defaultHeaders['Authorization'] =
      `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`
  }

  const ARGS = {
    defaultHeaders,
    maxRetries: 0, // Disabled auto-retry in favor of manual implementation
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(60 * 1000), 10),
  }
  if (USE_BEDROCK) {
    const client = new AnthropicBedrock(ARGS)
    anthropicClient = client
    return client
  }
  if (USE_VERTEX) {
    const vertexArgs = {
      ...ARGS,
      region: region || process.env.CLOUD_ML_REGION || 'us-east5',
    }
    const client = new AnthropicVertex(vertexArgs)
    anthropicClient = client
    return client
  }

  // Get appropriate API key and baseURL from ModelProfile
  const modelManager = getModelManager()
  const modelProfile = modelManager.getModel('main')

  let apiKey: string
  let baseURL: string | undefined

  if (modelProfile) {
    apiKey = modelProfile.apiKey || ''
    baseURL = modelProfile.baseURL
  } else {
    // Fallback to default anthropic if no ModelProfile
    apiKey = getAnthropicApiKey()
    baseURL = undefined
  }

  if (process.env.USER_TYPE === 'ant' && !apiKey && provider === 'anthropic') {
    console.error(
      chalk.red(
        '[ANT-ONLY] Please set the ANTHROPIC_API_KEY environment variable to use the CLI. To create a new key, go to https://console.anthropic.com/settings/keys.',
      ),
    )
  }

  // Create client with custom baseURL for BigDream/OpenDev
  // Anthropic SDK will append the appropriate paths (like /v1/messages)
  const clientConfig = {
    apiKey,
    dangerouslyAllowBrowser: true,
    ...ARGS,
    ...(baseURL && { baseURL }), // Use baseURL directly, SDK will handle API versioning
  }

  anthropicClient = new Anthropic(clientConfig)
  return anthropicClient
}

/**
 * Reset the Anthropic client to null, forcing a new client to be created on next use
 */
export function resetAnthropicClient(): void {
  anthropicClient = null
}

/**
 * Environment variables for different client types:
 *
 * Direct API:
 * - ANTHROPIC_API_KEY: Required for direct API access
 *
 * AWS Bedrock:
 * - AWS credentials configured via aws-sdk defaults
 *
 * Vertex AI:
 * - Model-specific region variables (highest priority):
 *   - VERTEX_REGION_CLAUDE_3_5_HAIKU: Region for Claude 3.5 Haiku model
 *   - VERTEX_REGION_CLAUDE_3_5_SONNET: Region for Claude 3.5 Sonnet model
 *   - VERTEX_REGION_CLAUDE_3_7_SONNET: Region for Claude 3.7 Sonnet model
 * - CLOUD_ML_REGION: Optional. The default GCP region to use for all models
 *   If specific model region not specified above
 * - ANTHROPIC_VERTEX_PROJECT_ID: Required. Your GCP project ID
 * - Standard GCP credentials configured via google-auth-library
 *
 * Priority for determining region:
 * 1. Hardcoded model-specific environment variables
 * 2. Global CLOUD_ML_REGION variable
 * 3. Default region from config
 * 4. Fallback region (us-east5)
 */

/**
 * Manage cache control to ensure it doesn't exceed Claude's 4 cache block limit
 * Priority:
 * 1. System prompts (high priority)
 * 2. Long documents or reference materials (high priority)
 * 3. Reusable context (medium priority)
 * 4. Short messages or one-time content (no caching)
 */
function applyCacheControlWithLimits(
  systemBlocks: TextBlockParam[],
  messageParams: MessageParam[]
): { systemBlocks: TextBlockParam[]; messageParams: MessageParam[] } {
  if (!PROMPT_CACHING_ENABLED) {
    return { systemBlocks, messageParams }
  }

  const maxCacheBlocks = 4
  let usedCacheBlocks = 0

  // 1. Prioritize adding cache to system prompts (highest priority)
  const processedSystemBlocks = systemBlocks.map((block, index) => {
    if (usedCacheBlocks < maxCacheBlocks && block.text.length > 1000) {
      usedCacheBlocks++
      return {
        ...block,
        cache_control: { type: 'ephemeral' as const }
      }
    }
    const { cache_control, ...blockWithoutCache } = block
    return blockWithoutCache
  })

  // 2. Add cache to message content based on priority
  const processedMessageParams = messageParams.map((message, messageIndex) => {
    if (Array.isArray(message.content)) {
      const processedContent = message.content.map((contentBlock, blockIndex) => {
        // Determine whether this content block should be cached
        const shouldCache = 
          usedCacheBlocks < maxCacheBlocks &&
          contentBlock.type === 'text' &&
          typeof contentBlock.text === 'string' &&
          (
            // Long documents (over 2000 characters)
            contentBlock.text.length > 2000 ||
            // Last content block of the last message (may be important context)
            (messageIndex === messageParams.length - 1 && 
             blockIndex === message.content.length - 1 &&
             contentBlock.text.length > 500)
          )

        if (shouldCache) {
          usedCacheBlocks++
          return {
            ...contentBlock,
            cache_control: { type: 'ephemeral' as const }
          }
        }

        // Remove existing cache_control
        const { cache_control, ...blockWithoutCache } = contentBlock as any
        return blockWithoutCache
      })

      return {
        ...message,
        content: processedContent
      }
    }

    return message
  })

  return {
    systemBlocks: processedSystemBlocks,
    messageParams: processedMessageParams
  }
}

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
          },
        ],
      }
    } else {
      return {
        role: 'user',
        content: message.message.content.map((_) => ({ ..._ })),
      }
    }
  }
  return {
    role: 'user',
    content: message.message.content,
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
          },
        ],
      }
    } else {
      return {
        role: 'assistant',
        content: message.message.content.map((_) => ({ ..._ })),
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content,
  }
}

function splitSysPromptPrefix(systemPrompt: string[]): string[] {
  // split out the first block of the system prompt as the "prefix" for API
  
  const systemPromptFirstBlock = systemPrompt[0] || ''
  const systemPromptRest = systemPrompt.slice(1)
  return [systemPromptFirstBlock, systemPromptRest.join('\n')].filter(Boolean)
}

export async function queryLLM(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number,
  tools: Tool[],
  signal: AbortSignal,
  options: {
    safeMode: boolean
    model: string | import('@utils/config').ModelPointerType
    prependCLISysprompt: boolean
    toolUseContext?: ToolUseContext
  },
): Promise<AssistantMessage> {

  const modelManager = getModelManager()
  const modelResolution = modelManager.resolveModelWithInfo(options.model)

  if (!modelResolution.success || !modelResolution.profile) {
    throw new Error(
      modelResolution.error || `Failed to resolve model: ${options.model}`,
    )
  }

  const modelProfile = modelResolution.profile
  const resolvedModel = modelProfile.modelName

  // Initialize response state if toolUseContext is provided
  const toolUseContext = options.toolUseContext
  if (toolUseContext && !toolUseContext.responseState) {
    const conversationId = getConversationId(toolUseContext.agentId, toolUseContext.messageId)
    const previousResponseId = responseStateManager.getPreviousResponseId(conversationId)
    
    toolUseContext.responseState = {
      previousResponseId,
      conversationId
    }
  }

  debugLogger.api('MODEL_RESOLVED', {
    inputParam: options.model,
    resolvedModelName: resolvedModel,
    provider: modelProfile.provider,
    isPointer: ['main', 'task', 'reasoning', 'quick'].includes(options.model),
    hasResponseState: !!toolUseContext?.responseState,
    conversationId: toolUseContext?.responseState?.conversationId,
    requestId: getCurrentRequest()?.id,
  })

  const currentRequest = getCurrentRequest()
  debugLogger.api('LLM_REQUEST_START', {
    messageCount: messages.length,
    systemPromptLength: systemPrompt.join(' ').length,
    toolCount: tools.length,
    model: resolvedModel,
    originalModelParam: options.model,
    requestId: getCurrentRequest()?.id,
  })

  markPhase('LLM_CALL')

  try {
    const result = await withVCR(messages, () =>
      queryLLMWithPromptCaching(
        messages,
        systemPrompt,
        maxThinkingTokens,
        tools,
        signal,
        { ...options, model: resolvedModel, modelProfile, toolUseContext }, // Pass resolved ModelProfile and toolUseContext
      ),
    )

    debugLogger.api('LLM_REQUEST_SUCCESS', {
      costUSD: result.costUSD,
      durationMs: result.durationMs,
      responseLength: result.message.content?.length || 0,
      requestId: getCurrentRequest()?.id,
    })

    // Update response state for GPT-5 Responses API continuation
    if (toolUseContext?.responseState?.conversationId && result.responseId) {
      responseStateManager.setPreviousResponseId(
        toolUseContext.responseState.conversationId, 
        result.responseId
      )
      
      debugLogger.api('RESPONSE_STATE_UPDATED', {
        conversationId: toolUseContext.responseState.conversationId,
        responseId: result.responseId,
        requestId: getCurrentRequest()?.id,
      })
    }

    return result
  } catch (error) {
    // 使用错误诊断系统记录 LLM 相关错误
    logErrorWithDiagnosis(
      error,
      {
        messageCount: messages.length,
        systemPromptLength: systemPrompt.join(' ').length,
        model: options.model,
        toolCount: tools.length,
        phase: 'LLM_CALL',
      },
      currentRequest?.id,
    )

    throw error
  }
}

export function formatSystemPromptWithContext(
  systemPrompt: string[],
  context: { [k: string]: string },
  agentId?: string,
  skipContextReminders = false, // Parameter kept for API compatibility but not used anymore
): { systemPrompt: string[]; reminders: string } {
  // 构建增强的系统提示，保持与原先直接注入方式的兼容
  const enhancedPrompt = [...systemPrompt]
  let reminders = ''

  // Step 0: Add GPT-5 Agent persistence support for coding tasks
  const modelManager = getModelManager()
  const modelProfile = modelManager.getModel('main')
  if (modelProfile && isGPT5Model(modelProfile.modelName)) {
    // Add coding-specific persistence instructions based on GPT-5 documentation
    const persistencePrompts = [
      "\n# Agent Persistence for Long-Running Coding Tasks",
      "You are working on a coding project that may involve multiple steps and iterations. Please maintain context and continuity throughout the session:",
      "- Remember architectural decisions and design patterns established earlier",
      "- Keep track of file modifications and their relationships", 
      "- Maintain awareness of the overall project structure and goals",
      "- Reference previous implementations when making related changes",
      "- Ensure consistency with existing code style and conventions",
      "- Build incrementally on previous work rather than starting from scratch"
    ]
    enhancedPrompt.push(...persistencePrompts)
  }

  // 只有当上下文存在时才处理
  const hasContext = Object.entries(context).length > 0

  if (hasContext) {
    // 步骤1: 直接注入 Kode 上下文到系统提示 - 对齐官方设计
    if (!skipContextReminders) {
      const kodeContext = generateKodeContext()
      if (kodeContext) {
        // 添加分隔符和标识，使项目文档在系统提示中更清晰
        enhancedPrompt.push('\n---\n# 项目上下文\n')
        enhancedPrompt.push(kodeContext)
        enhancedPrompt.push('\n---\n')
      }
    }

    // 步骤2: 生成其他动态提醒返回给调用方 - 保持现有动态提醒功能
    const reminderMessages = generateSystemReminders(hasContext, agentId)
    if (reminderMessages.length > 0) {
      reminders = reminderMessages.map(r => r.content).join('\n') + '\n'
    }

    // 步骤3: 添加其他上下文到系统提示
    enhancedPrompt.push(
      `\nAs you answer the user's questions, you can use the following context:\n`,
    )

    // 过滤掉已经由 Kode 上下文处理的项目文档（避免重复）
    const filteredContext = Object.fromEntries(
      Object.entries(context).filter(
        ([key]) => key !== 'projectDocs' && key !== 'userDocs',
      ),
    )

    enhancedPrompt.push(
      ...Object.entries(filteredContext).map(
        ([key, value]) => `<context name="${key}">${value}</context>`,
      ),
    )
  }

  return { systemPrompt: enhancedPrompt, reminders }
}

async function queryLLMWithPromptCaching(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number,
  tools: Tool[],
  signal: AbortSignal,
  options: {
    safeMode: boolean
    model: string
    prependCLISysprompt: boolean
    modelProfile?: ModelProfile | null
    toolUseContext?: ToolUseContext
  },
): Promise<AssistantMessage> {
  const config = getGlobalConfig()
  const modelManager = getModelManager()
  const toolUseContext = options.toolUseContext


  const modelProfile = options.modelProfile || modelManager.getModel('main')
  let provider: string

  if (modelProfile) {
    provider = modelProfile.provider || config.primaryProvider || 'anthropic'
  } else {
    provider = config.primaryProvider || 'anthropic'
  }

  // Use native Anthropic SDK for Anthropic and some Anthropic-compatible providers
  if (
    provider === 'anthropic' ||
    provider === 'bigdream' ||
    provider === 'opendev'
  ) {
    return queryAnthropicNative(
      messages,
      systemPrompt,
      maxThinkingTokens,
      tools,
      signal,
      { ...options, modelProfile, toolUseContext },
    )
  }

  // Use OpenAI-compatible interface for all other providers
  return queryOpenAI(messages, systemPrompt, maxThinkingTokens, tools, signal, {
    ...options,
    modelProfile,
    toolUseContext,
  })
}

async function queryAnthropicNative(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number,
  tools: Tool[],
  signal: AbortSignal,
  options?: {
    safeMode: boolean
    model: string
    prependCLISysprompt: boolean
    modelProfile?: ModelProfile | null
    toolUseContext?: ToolUseContext
  },
): Promise<AssistantMessage> {
  const config = getGlobalConfig()
  const modelManager = getModelManager()
  const toolUseContext = options?.toolUseContext


  const modelProfile = options?.modelProfile || modelManager.getModel('main')
  let anthropic: Anthropic | AnthropicBedrock | AnthropicVertex
  let model: string
  let provider: string

  // 🔍 Debug: 记录模型配置详情
  debugLogger.api('MODEL_CONFIG_ANTHROPIC', {
    modelProfileFound: !!modelProfile,
    modelProfileId: modelProfile?.modelName,
    modelProfileName: modelProfile?.name,
    modelProfileModelName: modelProfile?.modelName,
    modelProfileProvider: modelProfile?.provider,
    modelProfileBaseURL: modelProfile?.baseURL,
    modelProfileApiKeyExists: !!modelProfile?.apiKey,
    optionsModel: options?.model,
    requestId: getCurrentRequest()?.id,
  })

  if (modelProfile) {
    // 使用ModelProfile的完整配置
    model = modelProfile.modelName
    provider = modelProfile.provider || config.primaryProvider || 'anthropic'

    // 基于ModelProfile创建专用的API客户端
    if (
      modelProfile.provider === 'anthropic' ||
      modelProfile.provider === 'bigdream' ||
      modelProfile.provider === 'opendev'
    ) {
      const clientConfig: any = {
        apiKey: modelProfile.apiKey,
        dangerouslyAllowBrowser: true,
        maxRetries: 0,
        timeout: parseInt(process.env.API_TIMEOUT_MS || String(60 * 1000), 10),
        defaultHeaders: {
          'x-app': 'cli',
          'User-Agent': USER_AGENT,
        },
      }

      // 使用ModelProfile的baseURL而不是全局配置
      if (modelProfile.baseURL) {
        clientConfig.baseURL = modelProfile.baseURL
      }

      anthropic = new Anthropic(clientConfig)
    } else {
      // 其他提供商的处理逻辑
      anthropic = getAnthropicClient(model)
    }
  } else {
    // 🚨 降级：没有有效的ModelProfile时，应该抛出错误
    const errorDetails = {
      modelProfileExists: !!modelProfile,
      modelProfileModelName: modelProfile?.modelName,
      requestedModel: options?.model,
      requestId: getCurrentRequest()?.id,
    }
    debugLogger.error('ANTHROPIC_FALLBACK_ERROR', errorDetails)
    throw new Error(
      `No valid ModelProfile available for Anthropic provider. Please configure model through /model command. Debug: ${JSON.stringify(errorDetails)}`,
    )
  }

  // Prepend system prompt block for easy API identification
  if (options?.prependCLISysprompt) {
    // Log stats about first block for analyzing prefix matching config
    const [firstSyspromptBlock] = splitSysPromptPrefix(systemPrompt)

    systemPrompt = [getCLISyspromptPrefix(), ...systemPrompt]
  }

  const system: TextBlockParam[] = splitSysPromptPrefix(systemPrompt).map(
    _ => ({
      text: _,
      type: 'text',
    }),
  )

  const toolSchemas = await Promise.all(
    tools.map(async tool =>
      ({
        name: tool.name,
        description: typeof tool.description === 'function' 
          ? await tool.description() 
          : tool.description,
        input_schema:'inputJSONSchema' in tool && tool.inputJSONSchema
          ? tool.inputJSONSchema
          : zodToJsonSchema(tool.inputSchema),
      }) as unknown as Anthropic.Beta.Messages.BetaTool,
    )
  )

  const anthropicMessages = addCacheBreakpoints(messages)

  //  apply cache control
  const { systemBlocks: processedSystem, messageParams: processedMessages } = 
    applyCacheControlWithLimits(system, anthropicMessages)
  const startIncludingRetries = Date.now()

  // 记录系统提示构建过程
  logSystemPromptConstruction({
    basePrompt: systemPrompt.join('\n'),
    kodeContext: generateKodeContext() || '',
    reminders: [], // 这里可以从 generateSystemReminders 获取
    finalPrompt: systemPrompt.join('\n'),
  })

  let start = Date.now()
  let attemptNumber = 0
  let response

  try {
    response = await withRetry(async attempt => {
      attemptNumber = attempt
      start = Date.now()

      const params: Anthropic.Beta.Messages.MessageCreateParams = {
        model,
        max_tokens: getMaxTokensFromProfile(modelProfile),
        messages: processedMessages,
        system: processedSystem,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        tool_choice: toolSchemas.length > 0 ? { type: 'auto' } : undefined,
      }

      if (maxThinkingTokens > 0) {
        ;(params as any).extra_headers = {
          'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15',
        }
        ;(params as any).thinking = { max_tokens: maxThinkingTokens }
      }

      // 🔥 REAL-TIME API CALL DEBUG - 使用全局日志系统 (Anthropic Streaming)
      debugLogger.api('ANTHROPIC_API_CALL_START_STREAMING', {
        endpoint: modelProfile?.baseURL || 'DEFAULT_ANTHROPIC',
        model,
        provider,
        apiKeyConfigured: !!modelProfile?.apiKey,
        apiKeyPrefix: modelProfile?.apiKey
          ? modelProfile.apiKey.substring(0, 8)
          : null,
        maxTokens: params.max_tokens,
        temperature: MAIN_QUERY_TEMPERATURE,
        params: params,
        messageCount: params.messages?.length || 0,
        streamMode: true,
        toolsCount: toolSchemas.length,
        thinkingTokens: maxThinkingTokens,
        timestamp: new Date().toISOString(),
        modelProfileId: modelProfile?.modelName,
        modelProfileName: modelProfile?.name,
      })

      if (config.stream) {

        const stream = await anthropic.beta.messages.create({
          ...params,
          stream: true,
        }, {
          signal: signal // ← CRITICAL: Connect the AbortSignal to API call
        })

        let finalResponse: any | null = null
        let messageStartEvent: any = null
        const contentBlocks: any[] = []
        const inputJSONBuffers = new Map<number, string>()
        let usage: any = null
        let stopReason: string | null = null
        let stopSequence: string | null = null

        for await (const event of stream) {

          if (signal.aborted) {
            debugLogger.flow('STREAM_ABORTED', { 
              eventType: event.type,
              timestamp: Date.now() 
            })
            throw new Error('Request was cancelled')
          }
          
          switch (event.type) {
            case 'message_start':
              messageStartEvent = event
              finalResponse = {
                ...event.message,
                content: [], // Will be populated from content blocks
              }
              break
              
            case 'content_block_start':
              contentBlocks[event.index] = { ...event.content_block }
              // Initialize JSON buffer for tool_use blocks
              if (event.content_block.type === 'tool_use') {
                inputJSONBuffers.set(event.index, '')
              }
              break
              
            case 'content_block_delta':
              const blockIndex = event.index
              
              // Ensure content block exists
              if (!contentBlocks[blockIndex]) {
                contentBlocks[blockIndex] = {
                  type: event.delta.type === 'text_delta' ? 'text' : 'tool_use',
                  text: event.delta.type === 'text_delta' ? '' : undefined,
                }
                if (event.delta.type === 'input_json_delta') {
                  inputJSONBuffers.set(blockIndex, '')
                }
              }
              
              if (event.delta.type === 'text_delta') {
                contentBlocks[blockIndex].text += event.delta.text
              } else if (event.delta.type === 'input_json_delta') {
                const currentBuffer = inputJSONBuffers.get(blockIndex) || ''
                inputJSONBuffers.set(blockIndex, currentBuffer + event.delta.partial_json)
              }
              break
              
            case 'message_delta':
              if (event.delta.stop_reason) stopReason = event.delta.stop_reason
              if (event.delta.stop_sequence) stopSequence = event.delta.stop_sequence
              if (event.usage) usage = { ...usage, ...event.usage }
              break
              
            case 'content_block_stop':
              const stopIndex = event.index
              const block = contentBlocks[stopIndex]
              
              if (block?.type === 'tool_use' && inputJSONBuffers.has(stopIndex)) {
                const jsonStr = inputJSONBuffers.get(stopIndex)
                if (jsonStr) {
                  try {
                    block.input = JSON.parse(jsonStr)
                  } catch (error) {
                    debugLogger.error('JSON_PARSE_ERROR', {
                      blockIndex: stopIndex,
                      jsonStr,
                      error: error instanceof Error ? error.message : String(error)
                    })
                    block.input = {}
                  }
                  inputJSONBuffers.delete(stopIndex)
                }
              }
              break
              
            case 'message_stop':
              // Clear any remaining buffers
              inputJSONBuffers.clear()
              break
          }
          
          if (event.type === 'message_stop') {
            break
          }
        }

        if (!finalResponse || !messageStartEvent) {
          throw new Error('Stream ended without proper message structure')
        }

        // Construct the final response
        finalResponse = {
          ...messageStartEvent.message,
          content: contentBlocks.filter(Boolean),
          stop_reason: stopReason,
          stop_sequence: stopSequence,
          usage: {
            ...messageStartEvent.message.usage,
            ...usage,
          },
        }

        return finalResponse
      } else {
        // 🔥 REAL-TIME API CALL DEBUG - 使用全局日志系统 (Anthropic Non-Streaming)
        debugLogger.api('ANTHROPIC_API_CALL_START_NON_STREAMING', {
          endpoint: modelProfile?.baseURL || 'DEFAULT_ANTHROPIC',
          model,
          provider,
          apiKeyConfigured: !!modelProfile?.apiKey,
          apiKeyPrefix: modelProfile?.apiKey
            ? modelProfile.apiKey.substring(0, 8)
            : null,
          maxTokens: params.max_tokens,
          temperature: MAIN_QUERY_TEMPERATURE,
          messageCount: params.messages?.length || 0,
          streamMode: false,
          toolsCount: toolSchemas.length,
          thinkingTokens: maxThinkingTokens,
          timestamp: new Date().toISOString(),
          modelProfileId: modelProfile?.modelName,
          modelProfileName: modelProfile?.name,
        })


        return await anthropic.beta.messages.create(params, {
          signal: signal // ← CRITICAL: Connect the AbortSignal to API call
        })
      }
    }, { signal })

    debugLogger.api('ANTHROPIC_API_CALL_SUCCESS', {
      content: response.content
    })

    const ttftMs = start - Date.now()
    const durationMs = Date.now() - startIncludingRetries

    const content = response.content.map((block: ContentBlock) => {
      if (block.type === 'text') {
        return {
          type: 'text' as const,
          text: block.text,
        }
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input,
        }
      }
      return block
    })

    const assistantMessage: AssistantMessage = {
      message: {
        id: response.id,
        content,
        model: response.model,
        role: 'assistant',
        stop_reason: response.stop_reason,
        stop_sequence: response.stop_sequence,
        type: 'message',
        usage: response.usage,
      },
      type: 'assistant',
      uuid: nanoid() as UUID,
      durationMs,
      costUSD: 0, // Will be calculated below
    }

    // 记录完整的 LLM 交互调试信息 (Anthropic path)
    // 注意：Anthropic API将system prompt和messages分开，这里重构为完整的API调用视图
    const systemMessages = system.map(block => ({
      role: 'system',
      content: block.text,
    }))

    logLLMInteraction({
      systemPrompt: systemPrompt.join('\n'),
      messages: [...systemMessages, ...anthropicMessages],
      response: response,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : undefined,
      timing: {
        start: start,
        end: Date.now(),
      },
      apiFormat: 'anthropic',
    })

    // Calculate cost using native Anthropic usage data
    const inputTokens = response.usage.input_tokens
    const outputTokens = response.usage.output_tokens
    const cacheCreationInputTokens =
      response.usage.cache_creation_input_tokens ?? 0
    const cacheReadInputTokens = response.usage.cache_read_input_tokens ?? 0

    const costUSD =
      (inputTokens / 1_000_000) * getModelInputTokenCostUSD(model) +
      (outputTokens / 1_000_000) * getModelOutputTokenCostUSD(model) +
      (cacheCreationInputTokens / 1_000_000) *
        getModelInputTokenCostUSD(model) +
      (cacheReadInputTokens / 1_000_000) *
        (getModelInputTokenCostUSD(model) * 0.1) // Cache reads are 10% of input cost

    assistantMessage.costUSD = costUSD
    addToTotalCost(costUSD, durationMs)

    

    return assistantMessage
  } catch (error) {
    return getAssistantMessageFromError(error)
  }
}

function getAssistantMessageFromError(error: unknown): AssistantMessage {
  if (error instanceof Error && error.message.includes('prompt is too long')) {
    return createAssistantAPIErrorMessage(PROMPT_TOO_LONG_ERROR_MESSAGE)
  }
  if (
    error instanceof Error &&
    error.message.includes('Your credit balance is too low')
  ) {
    return createAssistantAPIErrorMessage(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE)
  }
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    return createAssistantAPIErrorMessage(INVALID_API_KEY_ERROR_MESSAGE)
  }
  if (error instanceof Error) {
    if (process.env.NODE_ENV === 'development') {
      debugLogger.error('ANTHROPIC_API_ERROR', {
        message: error.message,
        stack: error.stack,
      })
    }
    return createAssistantAPIErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
    )
  }
  return createAssistantAPIErrorMessage(API_ERROR_MESSAGE_PREFIX)
}

function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
): MessageParam[] {
  return messages.map((msg, index) => {
    return msg.type === 'user'
      ? userMessageToMessageParam(msg, index > messages.length - 3)
      : assistantMessageToMessageParam(msg, index > messages.length - 3)
  })
}

async function queryOpenAI(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number,
  tools: Tool[],
  signal: AbortSignal,
  options?: {
    safeMode: boolean
    model: string
    prependCLISysprompt: boolean
    modelProfile?: ModelProfile | null
    toolUseContext?: ToolUseContext
  },
): Promise<AssistantMessage> {
  const config = getGlobalConfig()
  const modelManager = getModelManager()
  const toolUseContext = options?.toolUseContext


  const modelProfile = options?.modelProfile || modelManager.getModel('main')
  let model: string

  // 🔍 Debug: 记录模型配置详情
  const currentRequest = getCurrentRequest()
  debugLogger.api('MODEL_CONFIG_OPENAI', {
    modelProfileFound: !!modelProfile,
    modelProfileId: modelProfile?.modelName,
    modelProfileName: modelProfile?.name,
    modelProfileModelName: modelProfile?.modelName,
    modelProfileProvider: modelProfile?.provider,
    modelProfileBaseURL: modelProfile?.baseURL,
    modelProfileApiKeyExists: !!modelProfile?.apiKey,
    optionsModel: options?.model,
    requestId: getCurrentRequest()?.id,
  })

  if (modelProfile) {
    model = modelProfile.modelName
  } else {
    model = options?.model || modelProfile?.modelName || ''
  }
  // Prepend system prompt block for easy API identification
  if (options?.prependCLISysprompt) {
    
    const [firstSyspromptBlock] = splitSysPromptPrefix(systemPrompt)

    systemPrompt = [getCLISyspromptPrefix() + systemPrompt] // some openai-like providers need the entire system prompt as a single block
  }

  const system: TextBlockParam[] = splitSysPromptPrefix(systemPrompt).map(
    _ => ({
      ...(PROMPT_CACHING_ENABLED
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
      text: _,
      type: 'text',
    }),
  )

  const toolSchemas = await Promise.all(
    tools.map(
      async _ =>
        ({
          type: 'function',
          function: {
            name: _.name,
            description: await _.prompt({
              safeMode: options?.safeMode,
            }),
            // Use tool's JSON schema directly if provided, otherwise convert Zod schema
            parameters:
              'inputJSONSchema' in _ && _.inputJSONSchema
                ? _.inputJSONSchema
                : zodToJsonSchema(_.inputSchema),
          },
        }) as OpenAI.ChatCompletionTool,
    ),
  )

  const openaiSystem = system.map(
    s =>
      ({
        role: 'system',
        content: s.text,
      }) as OpenAI.ChatCompletionMessageParam,
  )

  const openaiMessages = convertAnthropicMessagesToOpenAIMessages(messages)

  // 记录系统提示构建过程 (OpenAI path)
  logSystemPromptConstruction({
    basePrompt: systemPrompt.join('\n'),
    kodeContext: generateKodeContext() || '',
    reminders: [], // 这里可以从 generateSystemReminders 获取
    finalPrompt: systemPrompt.join('\n'),
  })

  let start = Date.now()

  type AdapterExecutionContext = {
    adapter: ReturnType<typeof ModelAdapterFactory.createAdapter>
    request: any
    shouldUseResponses: boolean
  }

  type QueryResult = {
    assistantMessage: AssistantMessage
    rawResponse?: any
    apiFormat: 'openai' | 'openai_responses'
  }

  let adapterContext: AdapterExecutionContext | null = null

  if (modelProfile && modelProfile.modelName) {
    debugLogger.api('CHECKING_ADAPTER_SYSTEM', {
      modelProfileName: modelProfile.modelName,
      modelName: modelProfile.modelName,
      provider: modelProfile.provider,
      requestId: getCurrentRequest()?.id,
    })

    const USE_NEW_ADAPTER_SYSTEM = process.env.USE_NEW_ADAPTERS !== 'false'

    if (USE_NEW_ADAPTER_SYSTEM) {
      const adapter = ModelAdapterFactory.createAdapter(modelProfile)
      const reasoningEffort = await getReasoningEffort(modelProfile, messages)
      const unifiedParams: UnifiedRequestParams = {
        messages: openaiMessages,
        systemPrompt: openaiSystem.map(s => s.content as string),
        tools,
        maxTokens: getMaxTokensFromProfile(modelProfile),
        stream: config.stream,
        reasoningEffort: reasoningEffort as any,
        temperature: isGPT5Model(model) ? 1 : MAIN_QUERY_TEMPERATURE,
        previousResponseId: toolUseContext?.responseState?.previousResponseId,
        verbosity: 'high',
      }

      adapterContext = {
        adapter,
        request: adapter.createRequest(unifiedParams),
        shouldUseResponses: ModelAdapterFactory.shouldUseResponsesAPI(
          modelProfile,
        ),
      }
    }
  }

  let queryResult: QueryResult
  let startIncludingRetries = Date.now()

  try {
    queryResult = await withRetry(async () => {
      start = Date.now()

      if (adapterContext) {
        if (adapterContext.shouldUseResponses) {
          const { callGPT5ResponsesAPI } = await import('./openai')
          const response = await callGPT5ResponsesAPI(
            modelProfile,
            adapterContext.request,
            signal,
          )
          const unifiedResponse = await adapterContext.adapter.parseResponse(
            response,
          )

          // Convert UnifiedResponse.toolCalls to tool_use content blocks
          const contentBlocks = [...(unifiedResponse.content || [])]

          if (unifiedResponse.toolCalls && unifiedResponse.toolCalls.length > 0) {
            for (const toolCall of unifiedResponse.toolCalls) {
              const tool = toolCall.function
              const toolName = tool?.name
              let toolArgs = {}
              try {
                toolArgs = tool?.arguments ? JSON.parse(tool.arguments) : {}
              } catch (e) {
                // Invalid JSON in tool arguments
              }

              contentBlocks.push({
                type: 'tool_use',
                input: toolArgs,
                name: toolName,
                id: toolCall.id?.length > 0 ? toolCall.id : nanoid(),
              })
            }
          }

          const assistantMsg: AssistantMessage = {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: contentBlocks,
              usage: {
                input_tokens: unifiedResponse.usage.promptTokens ?? 0,
                output_tokens: unifiedResponse.usage.completionTokens ?? 0,
                prompt_tokens: unifiedResponse.usage.promptTokens ?? 0,
                completion_tokens: unifiedResponse.usage.completionTokens ?? 0,
              },
            },
            costUSD: 0,
            durationMs: Date.now() - start,
            uuid: `${Date.now()}-${Math.random()
              .toString(36)
              .substr(2, 9)}` as any,
            responseId: unifiedResponse.responseId,
          }

          return {
            assistantMessage: assistantMsg,
            rawResponse: unifiedResponse,
            apiFormat: 'openai_responses',
          }
        }

        const s = await getCompletionWithProfile(
          modelProfile,
          adapterContext.request,
          0,
          10,
          signal,
        )
        let finalResponse
        if (config.stream) {
          finalResponse = await handleMessageStream(
            s as ChatCompletionStream,
            signal,
          )
        } else {
          finalResponse = s
        }

        const message = convertOpenAIResponseToAnthropic(finalResponse, tools)
        const assistantMsg: AssistantMessage = {
          type: 'assistant',
          message: message as any,
          costUSD: 0,
          durationMs: Date.now() - start,
          uuid: `${Date.now()}-${Math.random()
            .toString(36)
            .substr(2, 9)}` as any,
        }

        return {
          assistantMessage: assistantMsg,
          rawResponse: finalResponse,
          apiFormat: 'openai',
        }
      }

      const maxTokens = getMaxTokensFromProfile(modelProfile)
      const isGPT5 = isGPT5Model(model)

      const opts: OpenAI.ChatCompletionCreateParams = {
        model,
        ...(isGPT5
          ? { max_completion_tokens: maxTokens }
          : { max_tokens: maxTokens }),
        messages: [...openaiSystem, ...openaiMessages],
        temperature: isGPT5 ? 1 : MAIN_QUERY_TEMPERATURE,
      }
      if (config.stream) {
        ;(opts as OpenAI.ChatCompletionCreateParams).stream = true
        opts.stream_options = {
          include_usage: true,
        }
      }

      if (toolSchemas.length > 0) {
        opts.tools = toolSchemas
        opts.tool_choice = 'auto'
      }
      const reasoningEffort = await getReasoningEffort(modelProfile, messages)
      if (reasoningEffort) {
        opts.reasoning_effort = reasoningEffort
      }

      const completionFunction = isGPT5Model(modelProfile?.modelName || '')
        ? getGPT5CompletionWithProfile
        : getCompletionWithProfile
      const s = await completionFunction(modelProfile, opts, 0, 10, signal)
      let finalResponse
      if (opts.stream) {
        finalResponse = await handleMessageStream(
          s as ChatCompletionStream,
          signal,
        )
      } else {
        finalResponse = s
      }
      const message = convertOpenAIResponseToAnthropic(finalResponse, tools)
      const assistantMsg: AssistantMessage = {
        type: 'assistant',
        message: message as any,
        costUSD: 0,
        durationMs: Date.now() - start,
        uuid: `${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 9)}` as any,
      }
      return {
        assistantMessage: assistantMsg,
        rawResponse: finalResponse,
        apiFormat: 'openai',
      }
    }, { signal })
  } catch (error) {
    logError(error)
    return getAssistantMessageFromError(error)
  }

  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries

  const assistantMessage = queryResult.assistantMessage
  assistantMessage.message.content = normalizeContentFromAPI(
    assistantMessage.message.content || [],
  )

  const normalizedUsage = normalizeUsage(assistantMessage.message.usage)
  assistantMessage.message.usage = normalizedUsage

  const inputTokens = normalizedUsage.input_tokens ?? 0
  const outputTokens = normalizedUsage.output_tokens ?? 0
  const cacheReadInputTokens = normalizedUsage.cache_read_input_tokens ?? 0
  const cacheCreationInputTokens =
    normalizedUsage.cache_creation_input_tokens ?? 0

  const costUSD =
    (inputTokens / 1_000_000) * SONNET_COST_PER_MILLION_INPUT_TOKENS +
    (outputTokens / 1_000_000) * SONNET_COST_PER_MILLION_OUTPUT_TOKENS +
    (cacheReadInputTokens / 1_000_000) *
      SONNET_COST_PER_MILLION_PROMPT_CACHE_READ_TOKENS +
    (cacheCreationInputTokens / 1_000_000) *
      SONNET_COST_PER_MILLION_PROMPT_CACHE_WRITE_TOKENS

  addToTotalCost(costUSD, durationMsIncludingRetries)

  logLLMInteraction({
    systemPrompt: systemPrompt.join('\n'),
    messages: [...openaiSystem, ...openaiMessages],
    response: queryResult.rawResponse || assistantMessage.message,
    usage: {
      inputTokens,
      outputTokens,
    },
    timing: {
      start,
      end: Date.now(),
    },
    apiFormat: queryResult.apiFormat,
  })

  assistantMessage.costUSD = costUSD
  assistantMessage.durationMs = durationMs
  assistantMessage.uuid = assistantMessage.uuid || (randomUUID() as UUID)

  return assistantMessage
}

function getMaxTokensFromProfile(modelProfile: any): number {
  // Use ModelProfile maxTokens or reasonable default
  return modelProfile?.maxTokens || 8000
}

function normalizeUsage(usage?: any) {
  if (!usage) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
  }

  const inputTokens =
    usage.input_tokens ??
    usage.prompt_tokens ??
    usage.inputTokens ??
    0
  const outputTokens =
    usage.output_tokens ??
    usage.completion_tokens ??
    usage.outputTokens ??
    0
  const cacheReadInputTokens =
    usage.cache_read_input_tokens ??
    usage.prompt_token_details?.cached_tokens ??
    usage.cacheReadInputTokens ??
    0
  const cacheCreationInputTokens =
    usage.cache_creation_input_tokens ??
    usage.cacheCreatedInputTokens ??
    0

  return {
    ...usage,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
  }
}

function getModelInputTokenCostUSD(model: string): number {
  // Find the model in the models object
  for (const providerModels of Object.values(models)) {
    const modelInfo = providerModels.find((m: any) => m.model === model)
    if (modelInfo) {
      return modelInfo.input_cost_per_token || 0
    }
  }
  // Default fallback cost for unknown models
  return 0.000003 // Default to Claude 3 Haiku cost
}

function getModelOutputTokenCostUSD(model: string): number {
  // Find the model in the models object
  for (const providerModels of Object.values(models)) {
    const modelInfo = providerModels.find((m: any) => m.model === model)
    if (modelInfo) {
      return modelInfo.output_cost_per_token || 0
    }
  }
  // Default fallback cost for unknown models
  return 0.000015 // Default to Claude 3 Haiku cost
}

// New unified query functions for model pointer system
export async function queryModel(
  modelPointer: import('@utils/config').ModelPointerType,
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[] = [],
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  // Use queryLLM with the pointer directly
  return queryLLM(
    messages,
    systemPrompt,
    0, // maxThinkingTokens
    [], // tools
    signal || new AbortController().signal,
    {
      safeMode: false,
      model: modelPointer,
      prependCLISysprompt: true,
    },
  )
}

// Note: Use queryModel(pointer, ...) directly instead of these convenience functions

// Simplified query function using quick model pointer
export async function queryQuick({
  systemPrompt = [],
  userPrompt,
  assistantPrompt,
  enablePromptCaching = false,
  signal,
}: {
  systemPrompt?: string[]
  userPrompt: string
  assistantPrompt?: string
  enablePromptCaching?: boolean
  signal?: AbortSignal
}): Promise<AssistantMessage> {
  const messages = [
    {
      message: { role: 'user', content: userPrompt },
      type: 'user',
      uuid: randomUUID(),
    },
  ] as (UserMessage | AssistantMessage)[]

  return queryModel('quick', messages, systemPrompt, signal)
}
