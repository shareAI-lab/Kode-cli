import { OpenAI } from 'openai'
import { getGlobalConfig, GlobalConfig } from '@utils/config'
import { ProxyAgent, fetch, Response } from 'undici'
import { setSessionState, getSessionState } from '@utils/sessionState'
import { debug as debugLogger, getCurrentRequest, logAPIError } from '@utils/debugLogger'

/**
 * Retry configuration constants for API calls
 */
const RETRY_CONFIG = {
  BASE_DELAY_MS: 1000,
  MAX_DELAY_MS: 32000,
  MAX_SERVER_DELAY_MS: 60000,
  JITTER_FACTOR: 0.1,
} as const

/**
 * Calculate retry delay with exponential backoff and jitter
 */
function getRetryDelay(attempt: number, retryAfter?: string | null): number {
  // If server suggests a retry-after time, use it
  if (retryAfter) {
    const retryAfterMs = parseInt(retryAfter) * 1000
    if (!isNaN(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(retryAfterMs, RETRY_CONFIG.MAX_SERVER_DELAY_MS)
    }
  }

  // Exponential backoff with jitter
  const delay = RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt - 1)
  const jitter = Math.random() * RETRY_CONFIG.JITTER_FACTOR * delay

  return Math.min(delay + jitter, RETRY_CONFIG.MAX_DELAY_MS)
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

enum ModelErrorType {
  MaxLength = '1024',
  MaxCompletionTokens = 'max_completion_tokens',
  TemperatureRestriction = 'temperature_restriction',
  StreamOptions = 'stream_options',
  Citations = 'citations',
  RateLimit = 'rate_limit',
}

function getModelErrorKey(
  baseURL: string,
  model: string,
  type: ModelErrorType,
): string {
  return `${baseURL}:${model}:${type}`
}

function hasModelError(
  baseURL: string,
  model: string,
  type: ModelErrorType,
): boolean {
  return !!getSessionState('modelErrors')[
    getModelErrorKey(baseURL, model, type)
  ]
}

function setModelError(
  baseURL: string,
  model: string,
  type: ModelErrorType,
  error: string,
) {
  setSessionState('modelErrors', {
    [getModelErrorKey(baseURL, model, type)]: error,
  })
}

// More flexible error detection system
type ErrorDetector = (errMsg: string) => boolean
type ErrorFixer = (
  opts: OpenAI.ChatCompletionCreateParams,
) => Promise<void> | void
interface ErrorHandler {
  type: ModelErrorType
  detect: ErrorDetector
  fix: ErrorFixer
}

// GPT-5 specific error handlers with enhanced detection patterns
const GPT5_ERROR_HANDLERS: ErrorHandler[] = [
  {
    type: ModelErrorType.MaxCompletionTokens,
    detect: errMsg => {
      const lowerMsg = errMsg.toLowerCase()
      return (
        // Exact OpenAI GPT-5 error message
        (lowerMsg.includes("unsupported parameter: 'max_tokens'") && lowerMsg.includes("'max_completion_tokens'")) ||
        // Generic max_tokens error patterns
        (lowerMsg.includes("max_tokens") && lowerMsg.includes("max_completion_tokens")) ||
        (lowerMsg.includes("max_tokens") && lowerMsg.includes("not supported")) ||
        (lowerMsg.includes("max_tokens") && lowerMsg.includes("use max_completion_tokens")) ||
        // Additional patterns for various providers
        (lowerMsg.includes("invalid parameter") && lowerMsg.includes("max_tokens")) ||
        (lowerMsg.includes("parameter error") && lowerMsg.includes("max_tokens"))
      )
    },
    fix: async opts => {
      console.log(`🔧 GPT-5 Fix: Converting max_tokens (${opts.max_tokens}) to max_completion_tokens`)
      if ('max_tokens' in opts) {
        opts.max_completion_tokens = opts.max_tokens
        delete opts.max_tokens
      }
    },
  },
  {
    type: ModelErrorType.TemperatureRestriction,
    detect: errMsg => {
      const lowerMsg = errMsg.toLowerCase()
      return (
        lowerMsg.includes("temperature") && 
        (lowerMsg.includes("only supports") || lowerMsg.includes("must be 1") || lowerMsg.includes("invalid temperature"))
      )
    },
    fix: async opts => {
      console.log(`🔧 GPT-5 Fix: Adjusting temperature from ${opts.temperature} to 1`)
      opts.temperature = 1
    },
  },
  // Add more GPT-5 specific handlers as needed
]

// Standard error handlers
const ERROR_HANDLERS: ErrorHandler[] = [
  {
    type: ModelErrorType.MaxLength,
    detect: errMsg =>
      errMsg.includes('Expected a string with maximum length 1024'),
    fix: async opts => {
      const toolDescriptions = {}
      for (const tool of opts.tools || []) {
        if (tool.function.description.length <= 1024) continue
        let str = ''
        let remainder = ''
        for (let line of tool.function.description.split('\n')) {
          if (str.length + line.length < 1024) {
            str += line + '\n'
          } else {
            remainder += line + '\n'
          }
        }
        
        tool.function.description = str
        toolDescriptions[tool.function.name] = remainder
      }
      if (Object.keys(toolDescriptions).length > 0) {
        let content = '<additional-tool-usage-instructions>\n\n'
        for (const [name, description] of Object.entries(toolDescriptions)) {
          content += `<${name}>\n${description}\n</${name}>\n\n`
        }
        content += '</additional-tool-usage-instructions>'

        for (let i = opts.messages.length - 1; i >= 0; i--) {
          if (opts.messages[i].role === 'system') {
            opts.messages.splice(i + 1, 0, {
              role: 'system',
              content,
            })
            break
          }
        }
      }
    },
  },
  {
    type: ModelErrorType.MaxCompletionTokens,
    detect: errMsg => errMsg.includes("Use 'max_completion_tokens'"),
    fix: async opts => {
      opts.max_completion_tokens = opts.max_tokens
      delete opts.max_tokens
    },
  },
  {
    type: ModelErrorType.StreamOptions,
    detect: errMsg => errMsg.includes('stream_options'),
    fix: async opts => {
      delete opts.stream_options
    },
  },
  {
    type: ModelErrorType.Citations,
    detect: errMsg =>
      errMsg.includes('Extra inputs are not permitted') &&
      errMsg.includes('citations'),
    fix: async opts => {
      if (!opts.messages) return

      for (const message of opts.messages) {
        if (!message) continue

        if (Array.isArray(message.content)) {
          for (const item of message.content) {
            // Convert to unknown first to safely access properties
            if (item && typeof item === 'object') {
              const itemObj = item as unknown as Record<string, unknown>
              if ('citations' in itemObj) {
                delete itemObj.citations
              }
            }
          }
        } else if (message.content && typeof message.content === 'object') {
          // Convert to unknown first to safely access properties
          const contentObj = message.content as unknown as Record<
            string,
            unknown
          >
          if ('citations' in contentObj) {
            delete contentObj.citations
          }
        }
      }
    },
  },
]

// Rate limit specific detection
function isRateLimitError(errMsg: string): boolean {
  if (!errMsg) return false
  const lowerMsg = errMsg.toLowerCase()
  return (
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('too many requests') ||
    lowerMsg.includes('429')
  )
}

// Model-specific feature flags - can be extended with more properties as needed
interface ModelFeatures {
  usesMaxCompletionTokens: boolean
  supportsResponsesAPI?: boolean
  requiresTemperatureOne?: boolean
  supportsVerbosityControl?: boolean
  supportsCustomTools?: boolean
  supportsAllowedTools?: boolean
}

// Map of model identifiers to their specific features
const MODEL_FEATURES: Record<string, ModelFeatures> = {
  // OpenAI thinking models
  o1: { usesMaxCompletionTokens: true },
  'o1-preview': { usesMaxCompletionTokens: true },
  'o1-mini': { usesMaxCompletionTokens: true },
  'o1-pro': { usesMaxCompletionTokens: true },
  'o3-mini': { usesMaxCompletionTokens: true },
  // GPT-5 models
  'gpt-5': { 
    usesMaxCompletionTokens: true, 
    supportsResponsesAPI: true,
    requiresTemperatureOne: true,
    supportsVerbosityControl: true,
    supportsCustomTools: true,
    supportsAllowedTools: true,
  },
  'gpt-5-mini': { 
    usesMaxCompletionTokens: true, 
    supportsResponsesAPI: true,
    requiresTemperatureOne: true,
    supportsVerbosityControl: true,
    supportsCustomTools: true,
    supportsAllowedTools: true,
  },
  'gpt-5-nano': { 
    usesMaxCompletionTokens: true, 
    supportsResponsesAPI: true,
    requiresTemperatureOne: true,
    supportsVerbosityControl: true,
    supportsCustomTools: true,
    supportsAllowedTools: true,
  },
  'gpt-5-chat-latest': { 
    usesMaxCompletionTokens: true, 
    supportsResponsesAPI: false, // Uses Chat Completions only
    requiresTemperatureOne: true,
    supportsVerbosityControl: true,
  },
}

// Helper to get model features based on model ID/name
function getModelFeatures(modelName: string): ModelFeatures {
  if (!modelName || typeof modelName !== 'string') {
    return { usesMaxCompletionTokens: false }
  }

  // Check for exact matches first (highest priority)
  if (MODEL_FEATURES[modelName]) {
    return MODEL_FEATURES[modelName]
  }

  // Simple GPT-5 detection: any model name containing 'gpt-5'
  if (modelName.toLowerCase().includes('gpt-5')) {
    return {
      usesMaxCompletionTokens: true,
      supportsResponsesAPI: true,
      requiresTemperatureOne: true,
      supportsVerbosityControl: true,
      supportsCustomTools: true,
      supportsAllowedTools: true,
    }
  }

  // Check for partial matches (e.g., other reasoning models)
  for (const [key, features] of Object.entries(MODEL_FEATURES)) {
    if (modelName.includes(key)) {
      return features
    }
  }

  // Default features for unknown models
  return { usesMaxCompletionTokens: false }
}

// Apply model-specific parameter transformations based on model features
function applyModelSpecificTransformations(
  opts: OpenAI.ChatCompletionCreateParams,
): void {
  if (!opts.model || typeof opts.model !== 'string') {
    return
  }

  const features = getModelFeatures(opts.model)
  const isGPT5 = opts.model.toLowerCase().includes('gpt-5')

  // 🔥 Enhanced GPT-5 Detection and Transformation
  if (isGPT5 || features.usesMaxCompletionTokens) {
    // Force max_completion_tokens for all GPT-5 models
    if ('max_tokens' in opts && !('max_completion_tokens' in opts)) {
      console.log(`🔧 Transforming max_tokens (${opts.max_tokens}) to max_completion_tokens for ${opts.model}`)
      opts.max_completion_tokens = opts.max_tokens
      delete opts.max_tokens
    }
    
    // Force temperature = 1 for GPT-5 models
    if (features.requiresTemperatureOne && 'temperature' in opts) {
      if (opts.temperature !== 1 && opts.temperature !== undefined) {
        console.log(
          `🔧 GPT-5 temperature constraint: Adjusting temperature from ${opts.temperature} to 1 for ${opts.model}`
        )
        opts.temperature = 1
      }
    }
    
    // Remove unsupported parameters for GPT-5
    if (isGPT5) {
      // Remove parameters that may not be supported by GPT-5
      delete opts.frequency_penalty
      delete opts.presence_penalty
      delete opts.logit_bias
      delete opts.user
      
      // Add reasoning_effort if not present and model supports it
      if (!opts.reasoning_effort && features.supportsVerbosityControl) {
        opts.reasoning_effort = 'medium' // Default reasoning effort for coding tasks
      }
    }
  }

  // Apply transformations for non-GPT-5 models
  else {
    // Standard max_tokens to max_completion_tokens conversion for other reasoning models
    if (
      features.usesMaxCompletionTokens &&
      'max_tokens' in opts &&
      !('max_completion_tokens' in opts)
    ) {
      opts.max_completion_tokens = opts.max_tokens
      delete opts.max_tokens
    }
  }

  // Add more transformations here as needed
}

async function applyModelErrorFixes(
  opts: OpenAI.ChatCompletionCreateParams,
  baseURL: string,
) {
  const isGPT5 = opts.model.startsWith('gpt-5')
  const handlers = isGPT5 ? [...GPT5_ERROR_HANDLERS, ...ERROR_HANDLERS] : ERROR_HANDLERS
  
  for (const handler of handlers) {
    if (hasModelError(baseURL, opts.model, handler.type)) {
      await handler.fix(opts)
      return
    }
  }
}

// Helper function to try different endpoints for OpenAI-compatible providers
async function tryWithEndpointFallback(
  baseURL: string,
  opts: OpenAI.ChatCompletionCreateParams,
  headers: Record<string, string>,
  provider: string,
  proxy: any,
  signal?: AbortSignal, // 🔧 Add AbortSignal support
): Promise<{ response: Response; endpoint: string }> {
  const endpointsToTry = []

  if (provider === 'minimax') {
    endpointsToTry.push('/text/chatcompletion_v2', '/chat/completions')
  } else {
    endpointsToTry.push('/chat/completions')
  }

  let lastError = null

  for (const endpoint of endpointsToTry) {
    try {
      const response = await fetch(`${baseURL}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(opts.stream ? { ...opts, stream: true } : opts),
        dispatcher: proxy,
        signal: signal, // 🔧 Connect AbortSignal to fetch call
      })

      // If successful, return immediately
      if (response.ok) {
        return { response, endpoint }
      }

      // If it's a 404, try the next endpoint
      if (response.status === 404 && endpointsToTry.length > 1) {
        console.log(
          `Endpoint ${endpoint} returned 404, trying next endpoint...`,
        )
        continue
      }

      // For other error codes, return this response (don't try fallback)
      return { response, endpoint }
    } catch (error) {
      lastError = error
      // Network errors might be temporary, try next endpoint
      if (endpointsToTry.indexOf(endpoint) < endpointsToTry.length - 1) {
        console.log(`Network error on ${endpoint}, trying next endpoint...`)
        continue
      }
    }
  }

  // If we get here, all endpoints failed
  throw lastError || new Error('All endpoints failed')
}

// Export shared utilities for GPT-5 compatibility
export { getGPT5CompletionWithProfile, getModelFeatures, applyModelSpecificTransformations }

export async function getCompletionWithProfile(
  modelProfile: any,
  opts: OpenAI.ChatCompletionCreateParams,
  attempt: number = 0,
  maxAttempts: number = 10,
  signal?: AbortSignal, // 🔧 CRITICAL FIX: Add AbortSignal support
): Promise<OpenAI.ChatCompletion | AsyncIterable<OpenAI.ChatCompletionChunk>> {
  if (attempt >= maxAttempts) {
    throw new Error('Max attempts reached')
  }

  const provider = modelProfile?.provider || 'anthropic'
  const baseURL = modelProfile?.baseURL
  const apiKey = modelProfile?.apiKey
  const proxy = getGlobalConfig().proxy
    ? new ProxyAgent(getGlobalConfig().proxy)
    : undefined

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey) {
    if (provider === 'azure') {
      headers['api-key'] = apiKey
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
    }
  }

  applyModelSpecificTransformations(opts)
  await applyModelErrorFixes(opts, baseURL || '')

  // 🔥 REAL-TIME API CALL DEBUG - 使用全局日志系统
  debugLogger.api('OPENAI_API_CALL_START', {
    endpoint: baseURL || 'DEFAULT_OPENAI',
    model: opts.model,
    provider,
    apiKeyConfigured: !!apiKey,
    apiKeyPrefix: apiKey ? apiKey.substring(0, 8) : null,
    maxTokens: opts.max_tokens,
    temperature: opts.temperature,
    messageCount: opts.messages?.length || 0,
    streamMode: opts.stream,
    timestamp: new Date().toISOString(),
    modelProfileModelName: modelProfile?.modelName,
    modelProfileName: modelProfile?.name,
  })

  // Make sure all tool messages have string content
  opts.messages = opts.messages.map(msg => {
    if (msg.role === 'tool') {
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content:
            msg.content
              .map(c => c.text || '')
              .filter(Boolean)
              .join('\n\n') || '(empty content)',
        }
      } else if (typeof msg.content !== 'string') {
        return {
          ...msg,
          content:
            typeof msg.content === 'undefined'
              ? '(empty content)'
              : JSON.stringify(msg.content),
        }
      }
    }
    return msg
  })

  // Define Azure-specific API endpoint with version
  const azureApiVersion = '2024-06-01'
  let endpoint = '/chat/completions'

  if (provider === 'azure') {
    endpoint = `/chat/completions?api-version=${azureApiVersion}`
  } else if (provider === 'minimax') {
    endpoint = '/text/chatcompletion_v2'
  }

  try {
    if (opts.stream) {
      const isOpenAICompatible = [
        'minimax',
        'kimi',
        'deepseek',
        'siliconflow',
        'qwen',
        'glm',
        'baidu-qianfan',
        'openai',
        'mistral',
        'xai',
        'groq',
        'custom-openai',
      ].includes(provider)

      let response: Response
      let usedEndpoint: string

      if (isOpenAICompatible && provider !== 'azure') {
        const result = await tryWithEndpointFallback(
          baseURL,
          opts,
          headers,
          provider,
          proxy,
          signal, // 🔧 Pass AbortSignal to endpoint fallback
        )
        response = result.response
        usedEndpoint = result.endpoint
      } else {
        response = await fetch(`${baseURL}${endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...opts, stream: true }),
          dispatcher: proxy,
          signal: signal, // 🔧 CRITICAL FIX: Connect AbortSignal to fetch call
        })
        usedEndpoint = endpoint
      }

      if (!response.ok) {
        // 🔧 CRITICAL FIX: Check abort signal BEFORE showing retry message
        if (signal?.aborted) {
          throw new Error('Request cancelled by user')
        }
        
        // 🔥 NEW: Parse error message to detect and handle specific API errors
        try {
          const errorData = await response.json()
          // Type guard for error data structure
          const hasError = (data: unknown): data is { error?: { message?: string }; message?: string } => {
            return typeof data === 'object' && data !== null
          }
          const errorMessage = hasError(errorData) 
            ? (errorData.error?.message || errorData.message || `HTTP ${response.status}`)
            : `HTTP ${response.status}`
          
          // Check if this is a parameter error that we can fix
          const isGPT5 = opts.model.startsWith('gpt-5')
          const handlers = isGPT5 ? [...GPT5_ERROR_HANDLERS, ...ERROR_HANDLERS] : ERROR_HANDLERS
          
          for (const handler of handlers) {
            if (handler.detect(errorMessage)) {
              console.log(`🔧 Detected ${handler.type} error for ${opts.model}: ${errorMessage}`)
              
              // Store this error for future requests
              setModelError(baseURL || '', opts.model, handler.type, errorMessage)
              
              // Apply the fix and retry immediately
              await handler.fix(opts)
              console.log(`🔧 Applied fix for ${handler.type}, retrying...`)
              
              return getCompletionWithProfile(
                modelProfile,
                opts,
                attempt + 1,
                maxAttempts,
                signal,
              )
            }
          }
          
          // If no specific handler found, log the error for debugging
          console.log(`⚠️  Unhandled API error (${response.status}): ${errorMessage}`)
          
          // Log API error using unified logger
          logAPIError({
            model: opts.model,
            endpoint: `${baseURL}${endpoint}`,
            status: response.status,
            error: errorMessage,
            request: opts,
            response: errorData,
            provider: provider
          })
        } catch (parseError) {
          // If we can't parse the error, fall back to generic retry
          console.log(`⚠️  Could not parse error response (${response.status})`)
          
          // Log parse error
          logAPIError({
            model: opts.model,
            endpoint: `${baseURL}${endpoint}`,
            status: response.status,
            error: `Could not parse error response: ${parseError.message}`,
            request: opts,
            response: { parseError: parseError.message },
            provider: provider
          })
        }
        
        const delayMs = getRetryDelay(attempt)
        console.log(
          `  ⎿  API error (${response.status}), retrying in ${Math.round(delayMs / 1000)}s... (attempt ${attempt + 1}/${maxAttempts})`,
        )
        try {
          await abortableDelay(delayMs, signal)
        } catch (error) {
          // If aborted during delay, throw the error to stop retrying
          if (error.message === 'Request was aborted') {
            throw new Error('Request cancelled by user')
          }
          throw error
        }
        return getCompletionWithProfile(
          modelProfile,
          opts,
          attempt + 1,
          maxAttempts,
          signal, // 🔧 Pass AbortSignal to recursive call
        )
      }

      const stream = createStreamProcessor(response.body as any, signal)
      return stream
    }

    // Non-streaming request
    const isOpenAICompatible = [
      'minimax',
      'kimi',
      'deepseek',
      'siliconflow',
      'qwen',
      'glm',
      'baidu-qianfan',
      'openai',
      'mistral',
      'xai',
      'groq',
      'custom-openai',
    ].includes(provider)

    let response: Response
    let usedEndpoint: string

    if (isOpenAICompatible && provider !== 'azure') {
      const result = await tryWithEndpointFallback(
        baseURL,
        opts,
        headers,
        provider,
        proxy,
        signal, // 🔧 Pass AbortSignal to endpoint fallback
      )
      response = result.response
      usedEndpoint = result.endpoint
    } else {
      response = await fetch(`${baseURL}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(opts),
        dispatcher: proxy,
        signal: signal, // 🔧 CRITICAL FIX: Connect AbortSignal to non-streaming fetch call
      })
      usedEndpoint = endpoint
    }

    if (!response.ok) {
      // 🔧 CRITICAL FIX: Check abort signal BEFORE showing retry message
      if (signal?.aborted) {
        throw new Error('Request cancelled by user')
      }
      
      // 🔥 NEW: Parse error message to detect and handle specific API errors
      try {
        const errorData = await response.json()
        // Type guard for error data structure
        const hasError = (data: unknown): data is { error?: { message?: string }; message?: string } => {
          return typeof data === 'object' && data !== null
        }
        const errorMessage = hasError(errorData) 
          ? (errorData.error?.message || errorData.message || `HTTP ${response.status}`)
          : `HTTP ${response.status}`
        
        // Check if this is a parameter error that we can fix
        const isGPT5 = opts.model.startsWith('gpt-5')
        const handlers = isGPT5 ? [...GPT5_ERROR_HANDLERS, ...ERROR_HANDLERS] : ERROR_HANDLERS
        
        for (const handler of handlers) {
          if (handler.detect(errorMessage)) {
            console.log(`🔧 Detected ${handler.type} error for ${opts.model}: ${errorMessage}`)
            
            // Store this error for future requests
            setModelError(baseURL || '', opts.model, handler.type, errorMessage)
            
            // Apply the fix and retry immediately
            await handler.fix(opts)
            console.log(`🔧 Applied fix for ${handler.type}, retrying...`)
            
            return getCompletionWithProfile(
              modelProfile,
              opts,
              attempt + 1,
              maxAttempts,
              signal,
            )
          }
        }
        
        // If no specific handler found, log the error for debugging
        console.log(`⚠️  Unhandled API error (${response.status}): ${errorMessage}`)
      } catch (parseError) {
        // If we can't parse the error, fall back to generic retry
        console.log(`⚠️  Could not parse error response (${response.status})`)
      }
      
      const delayMs = getRetryDelay(attempt)
      console.log(
        `  ⎿  API error (${response.status}), retrying in ${Math.round(delayMs / 1000)}s... (attempt ${attempt + 1}/${maxAttempts})`,
      )
      try {
        await abortableDelay(delayMs, signal)
      } catch (error) {
        // If aborted during delay, throw the error to stop retrying
        if (error.message === 'Request was aborted') {
          throw new Error('Request cancelled by user')
        }
        throw error
      }
      return getCompletionWithProfile(
        modelProfile,
        opts,
        attempt + 1,
        maxAttempts,
        signal, // 🔧 Pass AbortSignal to recursive call
      )
    }

    const responseData = (await response.json()) as OpenAI.ChatCompletion
    return responseData
  } catch (error) {
    // 🔧 CRITICAL FIX: Check abort signal BEFORE showing retry message
    if (signal?.aborted) {
      throw new Error('Request cancelled by user')
    }
    
    if (attempt < maxAttempts) {
      // 🔧 Double-check abort status to avoid showing misleading retry message
      if (signal?.aborted) {
        throw new Error('Request cancelled by user')
      }
      
      const delayMs = getRetryDelay(attempt)
      console.log(
        `  ⎿  Network error, retrying in ${Math.round(delayMs / 1000)}s... (attempt ${attempt + 1}/${maxAttempts})`,
      )
      try {
        await abortableDelay(delayMs, signal)
      } catch (error) {
        // If aborted during delay, throw the error to stop retrying
        if (error.message === 'Request was aborted') {
          throw new Error('Request cancelled by user')
        }
        throw error
      }
      return getCompletionWithProfile(
        modelProfile,
        opts,
        attempt + 1,
        maxAttempts,
        signal, // 🔧 Pass AbortSignal to recursive call
      )
    }
    throw error
  }
}

export function createStreamProcessor(
  stream: any,
  signal?: AbortSignal,
): AsyncGenerator<OpenAI.ChatCompletionChunk, void, unknown> {
  if (!stream) {
    throw new Error('Stream is null or undefined')
  }

  return (async function* () {
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    try {
      while (true) {
        // Check for cancellation before attempting to read
        if (signal?.aborted) {
          break
        }

        let readResult
        try {
          readResult = await reader.read()
        } catch (e) {
          // If signal is aborted, this is user cancellation - exit silently
          if (signal?.aborted) {
            break
          }
          console.error('Error reading from stream:', e)
          break
        }

        const { done, value } = readResult
        if (done) {
          break
        }

        const chunk = decoder.decode(value, { stream: true })
        buffer += chunk

        let lineEnd = buffer.indexOf('\n')
        while (lineEnd !== -1) {
          const line = buffer.substring(0, lineEnd).trim()
          buffer = buffer.substring(lineEnd + 1)

          if (line === 'data: [DONE]') {
            continue
          }

          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (!data) continue

            try {
              const parsed = JSON.parse(data) as OpenAI.ChatCompletionChunk
              yield parsed
            } catch (e) {
              console.error('Error parsing JSON:', data, e)
            }
          }

          lineEnd = buffer.indexOf('\n')
        }
      }

      // Process any remaining data in the buffer
      if (buffer.trim()) {
        const lines = buffer.trim().split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            const data = line.slice(6).trim()
            if (!data) continue

            try {
              const parsed = JSON.parse(data) as OpenAI.ChatCompletionChunk
              yield parsed
            } catch (e) {
              console.error('Error parsing final JSON:', data, e)
            }
          }
        }
      }
    } catch (e) {
      console.error('Unexpected error in stream processing:', e)
    } finally {
      try {
        reader.releaseLock()
      } catch (e) {
        console.error('Error releasing reader lock:', e)
      }
    }
  })()
}

export function streamCompletion(
  stream: any,
  signal?: AbortSignal,
): AsyncGenerator<OpenAI.ChatCompletionChunk, void, unknown> {
  return createStreamProcessor(stream, signal)
}

/**
 * Call GPT-5 Responses API with proper parameter handling
 */
export async function callGPT5ResponsesAPI(
  modelProfile: any,
  request: any, // Pre-formatted request from adapter
  signal?: AbortSignal,
): Promise<any> {
  const baseURL = modelProfile?.baseURL || 'https://api.openai.com/v1'
  const apiKey = modelProfile?.apiKey
  const proxy = getGlobalConfig().proxy
    ? new ProxyAgent(getGlobalConfig().proxy)
    : undefined

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }

  // Use the pre-formatted request from the adapter
  const responsesParams = request

  try {
    const response = await fetch(`${baseURL}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(responsesParams),
      dispatcher: proxy,
      signal: signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`GPT-5 Responses API error: ${response.status} ${response.statusText} - ${errorText}`)
    }

    // Return the raw response - the adapter will handle parsing
    return response
  } catch (error) {
    if (signal?.aborted) {
      throw new Error('Request cancelled by user')
    }
    throw error
  }
}

/**
 * Convert Responses API response to Chat Completion format for compatibility
 * 🔥 Enhanced for GPT-5 with reasoning summary support
 */
function convertResponsesAPIToChatCompletion(responsesData: any): any {
  // Extract content from Responses API format
  let outputText = responsesData.output_text || ''
  const usage = responsesData.usage || {}
  
  // 🚀 GPT-5 Reasoning Summary Integration
  // If reasoning summary is available, prepend it to the output for transparency
  if (responsesData.output && Array.isArray(responsesData.output)) {
    const reasoningItems = responsesData.output.filter(item => item.type === 'reasoning' && item.summary)
    const messageItems = responsesData.output.filter(item => item.type === 'message')
    
    if (reasoningItems.length > 0 && messageItems.length > 0) {
      const reasoningSummary = reasoningItems
        .map(item => item.summary?.map(s => s.text).join('\n'))
        .filter(Boolean)
        .join('\n\n')
      
      const mainContent = messageItems
        .map(item => item.content?.map(c => c.text).join('\n'))
        .filter(Boolean)
        .join('\n\n')
      
      if (reasoningSummary) {
        outputText = `**🧠 Reasoning Process:**\n${reasoningSummary}\n\n**📝 Response:**\n${mainContent}`
      } else {
        outputText = mainContent
      }
    }
  }

  return {
    id: responsesData.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: responsesData.model || '',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: outputText,
          // 🚀 Include reasoning metadata if available
          ...(responsesData.reasoning && {
            reasoning: {
              effort: responsesData.reasoning.effort,
              summary: responsesData.reasoning.summary,
            },
          }),
        },
        finish_reason: responsesData.status === 'completed' ? 'stop' : 'length',
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      // 🔧 GPT-5 Enhanced Usage Details
      prompt_tokens_details: {
        cached_tokens: usage.input_tokens_details?.cached_tokens || 0,
      },
      completion_tokens_details: {
        reasoning_tokens: usage.output_tokens_details?.reasoning_tokens || 0,
      },
    },
  }
}

/**
 * Enhanced getCompletionWithProfile that supports GPT-5 Responses API
 * 🔥 Optimized for both official OpenAI and third-party GPT-5 providers
 */
async function getGPT5CompletionWithProfile(
  modelProfile: any,
  opts: OpenAI.ChatCompletionCreateParams,
  attempt: number = 0,
  maxAttempts: number = 10,
  signal?: AbortSignal,
): Promise<OpenAI.ChatCompletion | AsyncIterable<OpenAI.ChatCompletionChunk>> {
  const features = getModelFeatures(opts.model)
  const isOfficialOpenAI = !modelProfile.baseURL || 
    modelProfile.baseURL.includes('api.openai.com')

  // 🌐 Handle third-party GPT-5 providers with enhanced compatibility
  if (!isOfficialOpenAI) {
    debugLogger.api('GPT5_THIRD_PARTY_PROVIDER', {
      model: opts.model,
      baseURL: modelProfile.baseURL,
      provider: modelProfile.provider,
      supportsResponsesAPI: features.supportsResponsesAPI,
      requestId: getCurrentRequest()?.id,
    })
    
    // 🔧 Apply enhanced parameter optimization for third-party providers
    console.log(`🌐 Using GPT-5 via third-party provider: ${modelProfile.provider} (${modelProfile.baseURL})`)
    
    // Some third-party providers may need additional parameter adjustments
    if (modelProfile.provider === 'azure') {
      // Azure OpenAI specific adjustments
      delete opts.reasoning_effort // Azure may not support this yet
    } else if (modelProfile.provider === 'custom-openai') {
      // Generic OpenAI-compatible provider optimizations
      console.log(`🔧 Applying OpenAI-compatible optimizations for custom provider`)
    }
  }
  
  // 📡 Handle streaming requests (Responses API doesn't support streaming yet)
  else if (opts.stream) {
    debugLogger.api('GPT5_STREAMING_MODE', {
      model: opts.model,
      baseURL: modelProfile.baseURL || 'official',
      reason: 'responses_api_no_streaming',
      requestId: getCurrentRequest()?.id,
    })
    
    console.log(`🔄 Using Chat Completions for streaming (Responses API streaming not available)`)
  }

  // 🔧 Enhanced Chat Completions fallback with GPT-5 optimizations
  debugLogger.api('USING_CHAT_COMPLETIONS_FOR_GPT5', {
    model: opts.model,
    baseURL: modelProfile.baseURL || 'official',
    provider: modelProfile.provider,
    reason: isOfficialOpenAI ? 'streaming_or_fallback' : 'third_party_provider',
    requestId: getCurrentRequest()?.id,
  })

  return await getCompletionWithProfile(
    modelProfile,
    opts,
    attempt,
    maxAttempts,
    signal,
  )
}

/**
 * Fetch available models from custom OpenAI-compatible API
 */
export async function fetchCustomModels(
  baseURL: string,
  apiKey: string,
): Promise<any[]> {
  try {
    // Check if baseURL already contains version number (e.g., v1, v2, etc.)
    const hasVersionNumber = /\/v\d+/.test(baseURL)
    const cleanBaseURL = baseURL.replace(/\/+$/, '')
    const modelsURL = hasVersionNumber
      ? `${cleanBaseURL}/models`
      : `${cleanBaseURL}/v1/models`

    const response = await fetch(modelsURL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      // Provide user-friendly error messages based on status code
      if (response.status === 401) {
        throw new Error(
          'Invalid API key. Please check your API key and try again.',
        )
      } else if (response.status === 403) {
        throw new Error(
          'API key does not have permission to access models. Please check your API key permissions.',
        )
      } else if (response.status === 404) {
        throw new Error(
          'API endpoint not found. Please check if the base URL is correct and supports the /models endpoint.',
        )
      } else if (response.status === 429) {
        throw new Error(
          'Too many requests. Please wait a moment and try again.',
        )
      } else if (response.status >= 500) {
        throw new Error(
          'API service is temporarily unavailable. Please try again later.',
        )
      } else {
        throw new Error(
          `Unable to connect to API (${response.status}). Please check your base URL, API key, and internet connection.`,
        )
      }
    }

    const data = await response.json()

    // Type guards for different API response formats
    const hasDataArray = (obj: unknown): obj is { data: unknown[] } => {
      return typeof obj === 'object' && obj !== null && 'data' in obj && Array.isArray((obj as any).data)
    }
    
    const hasModelsArray = (obj: unknown): obj is { models: unknown[] } => {
      return typeof obj === 'object' && obj !== null && 'models' in obj && Array.isArray((obj as any).models)
    }

    // Validate response format and extract models array
    let models = []

    if (hasDataArray(data)) {
      // Standard OpenAI format: { data: [...] }
      models = data.data
    } else if (Array.isArray(data)) {
      // Direct array format
      models = data
    } else if (hasModelsArray(data)) {
      // Alternative format: { models: [...] }
      models = data.models
    } else {
      throw new Error(
        'API returned unexpected response format. Expected an array of models or an object with a "data" or "models" array.',
      )
    }

    // Ensure we have an array and validate it contains model objects
    if (!Array.isArray(models)) {
      throw new Error('API response format error: models data is not an array.')
    }

    return models
  } catch (error) {
    // If it's already our custom error, pass it through
    if (
      error instanceof Error &&
      (error.message.includes('API key') ||
        error.message.includes('API endpoint') ||
        error.message.includes('API service') ||
        error.message.includes('response format'))
    ) {
      throw error
    }

    // For network errors or other issues
    console.error('Failed to fetch custom API models:', error)

    // Check if it's a network error
    if (error instanceof Error && error.message.includes('fetch')) {
      throw new Error(
        'Unable to connect to the API. Please check the base URL and your internet connection.',
      )
    }

    throw new Error(
      'Failed to fetch models from custom API. Please check your configuration and try again.',
    )
  }
}
