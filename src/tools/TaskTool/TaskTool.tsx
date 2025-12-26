import { TextBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import chalk from 'chalk'
import { last, memoize } from 'lodash-es'
import { EOL } from 'os'
import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { execSync } from 'child_process'
import { Tool, ValidationResult } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { getAgentPrompt } from '@constants/prompts'
import { getContext } from '@context'
import { hasPermissionsToUseTool } from '@permissions'
import { AssistantMessage, Message as MessageType, query } from '@query'
import { formatDuration, formatNumber } from '@utils/format'
import {
  getMessagesPath,
  getNextAvailableLogSidechainNumber,
  overwriteLog,
} from '@utils/log'
import { applyMarkdown } from '@utils/markdown'
import {
  createAssistantMessage,
  createUserMessage,
  getLastAssistantMessageId,
  INTERRUPT_MESSAGE,
  normalizeMessages,
} from '@utils/messages'
import { getModelManager } from '@utils/model'
import { getMaxThinkingTokens } from '@utils/thinking'
import { getTheme } from '@utils/theme'
import { generateAgentId } from '@utils/agentStorage'
import { debug as debugLogger } from '@utils/debugLogger'
import { getCwd } from '@utils/state'
import { getTaskTools, getPrompt } from './prompt'
import { TOOL_NAME } from './constants'
import { getActiveAgents, getAgentByType, getAvailableAgentTypes } from '@utils/agentLoader'
import {
  getSubAgentStateManager,
  SubAgentResult,
  SubAgentAnalyticsEvent,
  trackSubAgentEvent,
  isValidSubAgentColor,
  ValidSubAgentColor,
} from '@utils/subAgentStateManager'

/**
 * Get git diff for tracking changes made by sub-agent
 * Returns empty string if not in a git repo or no changes
 */
function getGitDiff(): string {
  try {
    const cwd = getCwd()
    // Get diff of both staged and unstaged changes
    const diff = execSync('git diff HEAD 2>/dev/null || git diff 2>/dev/null || echo ""', {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024, // 1MB max
      timeout: 5000,
    }).trim()
    return diff
  } catch (error) {
    // Not a git repo or git not available
    return ''
  }
}

/**
 * Get git status hash for detecting changes
 */
function getGitStatusHash(): string {
  try {
    const cwd = getCwd()
    // Get a quick hash of current git status
    const status = execSync('git status --porcelain 2>/dev/null || echo ""', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    return status
  } catch (error) {
    return ''
  }
}

const inputSchema = z.object({
  action: z
    .enum(['run', 'output'])
    .optional()
    .default('run')
    .describe(`Action to perform:
'run' - execute a sub-agent with the given instruction (default)
'output' - show the response and file changes made by a completed sub-agent`),
  description: z
    .string()
    .optional()
    .describe('A short (3-5 word) description of the task (required for run action)'),
  prompt: z
    .string()
    .optional()
    .describe('The task for the agent to perform (required for run action)'),
  name: z
    .string()
    .optional()
    .describe(`Name of the sub-agent. Names must be unique and contain no spaces.
For 'run': provide a name for the new agent (optional, auto-generated if not provided).
For 'output': provide the name of a completed agent to review (required).`),
  model_name: z
    .string()
    .optional()
    .describe(
      'Optional: Specific model name to use for this task. If not provided, uses the default task model pointer.',
    ),
  subagent_type: z
    .string()
    .optional()
    .describe(
      'The type of specialized agent to use for this task',
    ),
})

type TaskInput = z.infer<typeof inputSchema>

export const TaskTool = {
  async prompt({ safeMode }) {
    // Ensure agent prompts remain compatible with Claude Code `.claude` agent packs
    return await getPrompt(safeMode)
  },
  name: TOOL_NAME,
  async description() {
    // Ensure metadata stays compatible with Claude Code `.claude` agent packs
    return `Launch a new agent to handle complex, multi-step tasks autonomously.

**IMPORTANT: This tool can be run in parallel.** Multiple sub-agents can execute simultaneously with different names and instructions. Use parallel execution when you have multiple independent tasks that can be completed concurrently.

Available actions:
- **run** - Execute a sub-agent with the given instruction (waits for completion)
- **output** - Show the response and file changes (if any) made by a completed sub-agent`
  },
  inputSchema,

  async *call(
    { action = 'run', description, prompt, name, model_name, subagent_type }: TaskInput,
    {
      abortController,
      options: { safeMode = false, forkNumber, messageLogName, verbose },
      readFileTimestamps,
    },
  ): AsyncGenerator<
    | { type: 'result'; data: TextBlock[]; resultForAssistant?: string }
    | { type: 'progress'; content: any; normalizedMessages?: any[]; tools?: any[] },
    void,
    unknown
  > {
    const stateManager = getSubAgentStateManager()

    // Handle 'output' action - retrieve stored result
    if (action === 'output') {
      if (!name) {
        const errorMessage = "No agent name provided. See the agent name from the run result."
        yield {
          type: 'result',
          data: [{ type: 'text', text: errorMessage }] as TextBlock[],
          resultForAssistant: errorMessage,
        }
        return
      }

      const subAgentId = stateManager.findSubAgentIdByName(name)
      if (!subAgentId) {
        // List available agents
        const allResults = stateManager.getAllSubAgentStoredResults()
        const availableNames = Object.values(allResults).map(r => r.name).filter(Boolean)
        const errorMessage = availableNames.length > 0
          ? `Agent "${name}" not found. Available agents: ${availableNames.join(', ')}`
          : `Agent "${name}" not found. No completed agents available.`
        yield {
          type: 'result',
          data: [{ type: 'text', text: errorMessage }] as TextBlock[],
          resultForAssistant: errorMessage,
        }
        return
      }

      const storedResult = stateManager.getSubAgentStoredResult(subAgentId)
      if (!storedResult) {
        const errorMessage = `No stored result found for agent "${name}". Agent may not have completed yet.`
        yield {
          type: 'result',
          data: [{ type: 'text', text: errorMessage }] as TextBlock[],
          resultForAssistant: errorMessage,
        }
        return
      }

      // Build output with response and diff if available
      let output = storedResult.result
      if (storedResult.diff) {
        output += `\n\n## Changes Made\n${storedResult.diff}`
      }

      // Add metadata
      output += `\n\n---\nAgent: ${storedResult.name} (${storedResult.agentType})`
      output += `\nStatus: ${storedResult.status}`
      output += `\nTool calls: ${storedResult.toolCallCount}`
      output += `\nDuration: ${formatDuration(storedResult.durationMs)}`
      if (storedResult.model) {
        output += `\nModel: ${storedResult.model}`
      }

      yield {
        type: 'result',
        data: [{ type: 'text', text: output }] as TextBlock[],
        resultForAssistant: output,
      }
      return
    }

    // Handle 'run' action - execute sub-agent
    if (!description || !prompt) {
      const errorMessage = "Description and prompt are required for 'run' action."
      yield {
        type: 'result',
        data: [{ type: 'text', text: errorMessage }] as TextBlock[],
        resultForAssistant: errorMessage,
      }
      return
    }

    const startTime = Date.now()

    // Generate or validate agent name
    const agentName = name || `task-${Date.now()}`
    if (agentName.includes(' ')) {
      const errorMessage = `Agent name "${agentName}" cannot contain spaces.`
      yield {
        type: 'result',
        data: [{ type: 'text', text: errorMessage }] as TextBlock[],
        resultForAssistant: errorMessage,
      }
      return
    }

    // Check if name is already in use
    const existingId = stateManager.findSubAgentIdByName(agentName)
    if (existingId) {
      const errorMessage = `Agent name "${agentName}" is already in use. Please choose a different name.`
      yield {
        type: 'result',
        data: [{ type: 'text', text: errorMessage }] as TextBlock[],
        resultForAssistant: errorMessage,
      }
      return
    }

    // Default to general-purpose if no subagent_type specified
    const agentType = subagent_type || 'general-purpose'

    // Apply subagent configuration
    let effectivePrompt = prompt
    let effectiveModel = model_name || 'task'
    let toolFilter = null
    let temperature = undefined
    let agentColor: ValidSubAgentColor | undefined = undefined

    // Load agent configuration dynamically
    if (agentType) {
      const agentConfig = await getAgentByType(agentType)

      if (!agentConfig) {
        // If agent type not found, return helpful message instead of throwing
        const availableTypes = await getAvailableAgentTypes()
        const helpMessage = `Agent type '${agentType}' not found.\n\nAvailable agents:\n${availableTypes.map(t => `  - ${t}`).join('\n')}\n\nUse /agents command to manage agent configurations.`

        yield {
          type: 'result',
          data: [{ type: 'text', text: helpMessage }] as TextBlock[],
          resultForAssistant: helpMessage,
        }
        return
      }

      // Apply system prompt if configured
      if (agentConfig.systemPrompt) {
        effectivePrompt = `${agentConfig.systemPrompt}\n\n${prompt}`
      }

      // Apply model if not overridden by model_name parameter
      if (!model_name && agentConfig.model_name) {
        // Support inherit: keep pointer-based default
        if (agentConfig.model_name !== 'inherit') {
          effectiveModel = agentConfig.model_name as string
        }
      }

      // Store tool filter for later application
      toolFilter = agentConfig.tools

      // Apply color if configured
      if (agentConfig.color && isValidSubAgentColor(agentConfig.color)) {
        agentColor = agentConfig.color
      }

      // Apply temperature if configured in agent config
      if (agentConfig.temperature !== undefined) {
        temperature = agentConfig.temperature
      }
    }

    // Capture git status before agent execution for diff tracking
    const gitStatusBefore = getGitStatusHash()

    const messages: MessageType[] = [createUserMessage(effectivePrompt)]
    let tools = await getTaskTools(safeMode)

    // Apply tool filtering if specified by subagent config
    if (toolFilter) {
      // Back-compat: ['*'] means all tools
      const isAllArray = Array.isArray(toolFilter) && toolFilter.length === 1 && toolFilter[0] === '*'
      if (toolFilter === '*' || isAllArray) {
        // no-op, keep all tools
      } else if (Array.isArray(toolFilter)) {
        tools = tools.filter(tool => toolFilter.includes(tool.name))
      }
    }

    // Resolve model - supports both direct model names and pointers (main, task, etc.)
    const modelManager = getModelManager()
    const resolvedModel = modelManager.resolveModel(effectiveModel)
    const modelToUse = resolvedModel?.modelName || effectiveModel

    // Generate unique Task ID for this task execution
    const taskId = generateAgentId()

    // Track sub-agent start
    trackSubAgentEvent(
      SubAgentAnalyticsEvent.STARTED,
      taskId,
      agentName,
      agentType,
      {
        model: modelToUse,
        color: agentColor,
      }
    )

    // Display initial task information with separate progress lines
    const colorPrefix = agentColor ? `[${agentColor}] ` : ''
    yield {
      type: 'progress',
      content: createAssistantMessage(`${colorPrefix}Starting agent: ${agentName} (${agentType})`),
      normalizedMessages: normalizeMessages(messages),
      tools,
    }

    yield {
      type: 'progress',
      content: createAssistantMessage(`Using model: ${modelToUse}`),
      normalizedMessages: normalizeMessages(messages),
      tools,
    }

    yield {
      type: 'progress',
      content: createAssistantMessage(`Task: ${description}`),
      normalizedMessages: normalizeMessages(messages),
      tools,
    }

    yield {
      type: 'progress',
      content: createAssistantMessage(`Prompt: ${prompt.length > 150 ? prompt.substring(0, 150) + '...' : prompt}`),
      normalizedMessages: normalizeMessages(messages),
      tools,
    }

    const [taskPrompt, context, maxThinkingTokens] = await Promise.all([
      getAgentPrompt(),
      getContext(),
      getMaxThinkingTokens(messages),
    ])

    // Inject model context to prevent self-referential expert consultations
    taskPrompt.push(`\nIMPORTANT: You are currently running as ${modelToUse}. You do not need to consult ${modelToUse} via AskExpertModel since you ARE ${modelToUse}. Complete tasks directly using your capabilities.`)

    let toolCallCount = 0
    let errorCount = 0
    let collectedDiff = ''

    const getSidechainNumber = memoize(() =>
      getNextAvailableLogSidechainNumber(messageLogName, forkNumber),
    )

    // Build query options, adding temperature if specified
    const queryOptions = {
      safeMode,
      forkNumber,
      messageLogName,
      tools,
      commands: [],
      verbose,
      maxThinkingTokens,
      model: modelToUse,
    }

    // Add temperature if specified by subagent config
    if (temperature !== undefined) {
      queryOptions['temperature'] = temperature
    }

    let wasInterrupted = false
    let finalError: Error | null = null

    try {
      for await (const message of query(
        messages,
        taskPrompt,
        context,
        hasPermissionsToUseTool,
        {
          abortController,
          options: queryOptions,
          messageId: getLastAssistantMessageId(messages),
          agentId: taskId,
          readFileTimestamps,
          setToolJSX: () => {}, // No-op implementation for TaskTool
        },
      )) {
        messages.push(message)

        overwriteLog(
          getMessagesPath(messageLogName, forkNumber, getSidechainNumber()),
          messages.filter(_ => _.type !== 'progress'),
        )

        if (message.type !== 'assistant') {
          continue
        }

        const normalizedMessages = normalizeMessages(messages)

        // Process tool uses and text content for better visibility
        for (const content of message.message.content) {
          if (content.type === 'text' && content.text && content.text !== INTERRUPT_MESSAGE) {
            // Show agent's reasoning/responses
            const preview = content.text.length > 200 ? content.text.substring(0, 200) + '...' : content.text
            yield {
              type: 'progress',
              content: createAssistantMessage(`${preview}`),
              normalizedMessages,
              tools,
            }
          } else if (content.type === 'tool_use') {
            toolCallCount++

            // Track tool call for analytics
            trackSubAgentEvent(
              SubAgentAnalyticsEvent.TOOL_CALLED,
              taskId,
              agentName,
              agentType,
              { toolCallCount }
            )

            // Show which tool is being used with agent context
            const toolMessage = normalizedMessages.find(
              _ =>
                _.type === 'assistant' &&
                _.message.content[0]?.type === 'tool_use' &&
                _.message.content[0].id === content.id,
            ) as AssistantMessage

            if (toolMessage) {
              // Clone and modify the message to show agent context
              const modifiedMessage = {
                ...toolMessage,
                message: {
                  ...toolMessage.message,
                  content: toolMessage.message.content.map(c => {
                    if (c.type === 'tool_use' && c.id === content.id) {
                      // Add agent context to tool name display
                      return {
                        ...c,
                        name: c.name // Keep original name, UI will handle display
                      }
                    }
                    return c
                  })
                }
              }

              yield {
                type: 'progress',
                content: modifiedMessage,
                normalizedMessages,
                tools,
              }
            }
          }
        }

        // Check for interrupt
        if (message.message.content.some(_ => _.type === 'text' && _.text === INTERRUPT_MESSAGE)) {
          wasInterrupted = true
        }
      }
    } catch (error) {
      finalError = error instanceof Error ? error : new Error(String(error))
      errorCount++
    }

    const completedAt = Date.now()
    const durationMs = completedAt - startTime

    const normalizedMessages = normalizeMessages(messages)
    const lastMessage = last(messages)

    // Determine final status
    let status: SubAgentResult['status'] = 'completed'
    if (wasInterrupted) {
      status = 'interrupted'
    } else if (finalError) {
      status = 'failed'
    }

    // Extract result text
    let resultText = ''
    if (lastMessage?.type === 'assistant') {
      resultText = lastMessage.message.content
        .filter(_ => _.type === 'text' && _.text !== INTERRUPT_MESSAGE)
        .map(_ => (_ as any).text)
        .join('\n')
    }

    // Capture git diff if changes were made during agent execution
    const gitStatusAfter = getGitStatusHash()
    if (gitStatusBefore !== gitStatusAfter) {
      // Changes detected, capture the diff
      collectedDiff = getGitDiff()
    }

    // Store result in state manager
    const subAgentResult: SubAgentResult = {
      name: agentName,
      agentType,
      result: resultText,
      diff: collectedDiff || undefined,
      requestId: taskId,
      toolCallCount,
      errorCount,
      startedAt: startTime,
      completedAt,
      durationMs,
      model: modelToUse,
      color: agentColor,
      status,
    }
    stateManager.setSubAgentStoredResult(taskId, subAgentResult)

    // Track completion/failure/interrupt
    if (wasInterrupted) {
      trackSubAgentEvent(
        SubAgentAnalyticsEvent.INTERRUPTED,
        taskId,
        agentName,
        agentType,
        { durationMs, toolCallCount, errorCount }
      )
    } else if (finalError) {
      trackSubAgentEvent(
        SubAgentAnalyticsEvent.FAILED,
        taskId,
        agentName,
        agentType,
        { durationMs, toolCallCount, errorCount, errorMessage: finalError.message }
      )
    } else {
      trackSubAgentEvent(
        SubAgentAnalyticsEvent.COMPLETED,
        taskId,
        agentName,
        agentType,
        { durationMs, toolCallCount, errorCount, model: modelToUse, color: agentColor }
      )
    }

    if (lastMessage?.type !== 'assistant') {
      throw finalError || new Error('Last message was not an assistant message')
    }

    // Handle interrupt case
    if (wasInterrupted) {
      yield {
        type: 'result',
        data: [{ type: 'text', text: INTERRUPT_MESSAGE }] as TextBlock[],
        resultForAssistant: `Agent "${agentName}" was interrupted.`,
      }
      return
    }

    // Show completion summary
    const result = [
      toolCallCount === 1 ? '1 tool use' : `${toolCallCount} tool uses`,
      formatNumber(
        (lastMessage.message.usage.cache_creation_input_tokens ?? 0) +
          (lastMessage.message.usage.cache_read_input_tokens ?? 0) +
          lastMessage.message.usage.input_tokens +
          lastMessage.message.usage.output_tokens,
      ) + ' tokens',
      formatDuration(durationMs),
    ]
    yield {
      type: 'progress',
      content: createAssistantMessage(`Agent "${agentName}" completed (${result.join(' · ')})`),
      normalizedMessages,
      tools,
    }

    // Output is an AssistantMessage, but since TaskTool is a tool, it needs
    // to serialize its response to UserMessage-compatible content.
    const data = lastMessage.message.content.filter(_ => _.type === 'text')

    // Append agent name to result for tracking
    const resultForAssistant = `[Agent: ${agentName}]\n${this.renderResultForAssistant(data)}`

    yield {
      type: 'result',
      data,
      resultForAssistant,
    }
  },

  isReadOnly() {
    return true // for now...
  },
  isConcurrencySafe() {
    return true // Task tool supports concurrent execution in official implementation
  },
  async validateInput(input: TaskInput, context) {
    const action = input.action || 'run'

    // Validate 'output' action
    if (action === 'output') {
      if (!input.name) {
        return {
          result: false,
          message: "Name is required for 'output' action. Provide the name of a completed agent.",
        }
      }
      return { result: true }
    }

    // Validate 'run' action
    if (!input.description || typeof input.description !== 'string') {
      return {
        result: false,
        message: "Description is required for 'run' action and must be a string",
      }
    }
    if (!input.prompt || typeof input.prompt !== 'string') {
      return {
        result: false,
        message: "Prompt is required for 'run' action and must be a string",
      }
    }

    // Validate name if provided
    if (input.name && input.name.includes(' ')) {
      return {
        result: false,
        message: `Agent name "${input.name}" cannot contain spaces`,
      }
    }

    // Model validation - use resolveModel to support both model names AND pointers
    if (input.model_name) {
      const modelManager = getModelManager()

      // First try to resolve as pointer or model name
      const resolveResult = modelManager.resolveModelWithInfo(input.model_name)

      if (!resolveResult.success) {
        // Model not found as pointer or direct name
        const availableModels = modelManager.getAllAvailableModelNames()
        const pointers = ['main', 'task', 'reasoning', 'quick']

        return {
          result: false,
          message: resolveResult.error || `Model '${input.model_name}' does not exist. Available models: ${availableModels.join(', ')}. Available pointers: ${pointers.join(', ')}`,
          meta: {
            model_name: input.model_name,
            availableModels,
            pointers,
          },
        }
      }
    }

    // Validate subagent_type if provided
    if (input.subagent_type) {
      const availableTypes = await getAvailableAgentTypes()
      if (!availableTypes.includes(input.subagent_type)) {
        return {
          result: false,
          message: `Agent type '${input.subagent_type}' does not exist. Available types: ${availableTypes.join(', ')}`,
          meta: {
            subagent_type: input.subagent_type,
            availableTypes,
          },
        }
      }
    }

    return { result: true }
  },
  async isEnabled() {
    return true
  },
  userFacingName(input?: TaskInput) {
    // Return agent name with proper prefix
    const agentType = input?.subagent_type || 'general-purpose'
    return `agent-${agentType}`
  },
  needsPermissions() {
    return false
  },
  renderResultForAssistant(data: TextBlock[]) {
    return data.map(block => block.type === 'text' ? block.text : '').join('\n')
  },
  renderToolUseMessage(input: TaskInput, { verbose }) {
    const { action = 'run', description, prompt, name, model_name, subagent_type } = input

    // Handle 'output' action display
    if (action === 'output') {
      return `Retrieving output for agent: ${name || 'unknown'}`
    }

    if (!description || !prompt) return null

    const modelManager = getModelManager()
    const defaultTaskModel = modelManager.getModelName('task')
    const actualModel = model_name || defaultTaskModel
    const agentType = subagent_type || 'general-purpose'
    const agentName = name || 'unnamed'
    const promptPreview =
      prompt.length > 80 ? prompt.substring(0, 80) + '...' : prompt

    const theme = getTheme()

    if (verbose) {
      return (
        <Box flexDirection="column">
          <Text>
            [{agentType}] {agentName} ({actualModel}): {description}
          </Text>
          <Box
            paddingLeft={2}
            borderLeftStyle="single"
            borderLeftColor={theme.secondaryBorder}
          >
            <Text color={theme.secondaryText}>{promptPreview}</Text>
          </Box>
        </Box>
      )
    }

    // Simple display: agent type, name, model and description
    return `[${agentType}] ${agentName} (${actualModel}): ${description}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(content) {
    const theme = getTheme()

    if (Array.isArray(content)) {
      const textBlocks = content.filter(block => block.type === 'text')
      const totalLength = textBlocks.reduce(
        (sum, block) => sum + block.text.length,
        0,
      )
      // Use exact match for interrupt detection, not .includes()
      const isInterrupted = content.some(
        block =>
          block.type === 'text' && block.text === INTERRUPT_MESSAGE,
      )

      if (isInterrupted) {
        // Match original system interrupt rendering exactly
        return (
          <Box flexDirection="row">
            <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
            <Text color={theme.error}>Interrupted by user</Text>
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between" width="100%">
            <Box flexDirection="row">
              <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
              <Text>Task completed</Text>
              {textBlocks.length > 0 && (
                <Text color={theme.secondaryText}>
                  {' '}
                  ({totalLength} characters)
                </Text>
              )}
            </Box>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="row">
        <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
        <Text color={theme.secondaryText}>Task completed</Text>
      </Box>
    )
  },
} satisfies Tool<typeof inputSchema, TextBlock[]>
