import { last } from 'lodash-es'
import { Command } from '@commands'
import { getSystemPrompt } from '@constants/prompts'
import { getContext } from '@context'
import { getTotalCost } from '@costTracker'
import { Message, query } from '@query'
import { CanUseToolFn } from '@hooks/useCanUseTool'
import { Tool } from '@tool'
import { getModelManager } from '@utils/model'
import { setCwd } from './state'
import { getMessagesPath, overwriteLog } from './log'
import { createUserMessage } from './messages'

type Props = {
  commands: Command[]
  safeMode?: boolean
  hasPermissionsToUseTool: CanUseToolFn
  messageLogName: string
  prompt: string
  cwd: string
  tools: Tool[]
  verbose?: boolean
}

// Sends a single prompt to the Anthropic Messages API and returns the response.
// Assumes that claude is being used non-interactively -- will not
// ask the user for permissions or further input.
export async function ask({
  commands,
  safeMode,
  hasPermissionsToUseTool,
  messageLogName,
  prompt,
  cwd,
  tools,
  verbose = false,
}: Props): Promise<{
  resultText: string
  totalCost: number
  messageHistoryFile: string
}> {
  await setCwd(cwd)
  const message = createUserMessage(prompt)
  const messages: Message[] = [message]

  const [systemPrompt, context, model] = await Promise.all([
    getSystemPrompt(),
    getContext(),
    getModelManager().getModelName('main'),
  ])

  for await (const m of query(
    messages,
    systemPrompt,
    context,
    hasPermissionsToUseTool,
    {
      options: {
        commands,
        tools,
        verbose,
        safeMode,
        forkNumber: 0,
        messageLogName: 'unused',
        maxThinkingTokens: 0,
      },
      abortController: new AbortController(),
      messageId: undefined,
      readFileTimestamps: {},
      setToolJSX: () => {}, // No-op function for non-interactive use
    },
  )) {
    messages.push(m)
  }

  const result = last(messages)
  if (!result || result.type !== 'assistant') {
    throw new Error('Expected content to be an assistant message')
  }

  // Filter out thinking blocks from content
  const textContent = result.message.content.find(c => c.type === 'text')
  if (!textContent) {
    throw new Error(
      `Expected at least one text content item, but got ${JSON.stringify(
        result.message.content,
        null,
        2,
      )}`,
    )
  }

  // Write log that can be retrieved with `claude log`
  const messageHistoryFile = getMessagesPath(messageLogName, 0, 0)
  overwriteLog(messageHistoryFile, messages)

  return {
    resultText: textContent.text,
    totalCost: getTotalCost(),
    messageHistoryFile,
  }
}
