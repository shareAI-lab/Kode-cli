import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { Box, Text } from 'ink'
import { join } from 'path'
import * as React from 'react'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool } from '@tool'
import { MEMORY_DIR } from '@utils/env'
import { resolveAgentId } from '@utils/agentStorage'
import { DESCRIPTION, PROMPT } from './prompt'
import {
  getMemorySnapshotManager,
  getPendingMemoriesStore,
} from '@utils/agentTools'

const inputSchema = z.strictObject({
  file_path: z
    .string()
    .optional()
    .describe('Optional path to a specific memory file to read'),
  use_snapshot: z
    .boolean()
    .optional()
    .describe('If true, use the cached memory snapshot (faster, may be slightly stale)'),
  include_pending: z
    .boolean()
    .optional()
    .describe('If true, include pending memories that have not been flushed yet'),
})

// Memory content loader function for snapshot manager
async function loadMemoriesContent(agentId: string): Promise<string | undefined> {
  const agentMemoryDir = join(MEMORY_DIR, 'agents', agentId)
  const indexPath = join(agentMemoryDir, 'index.md')

  if (!existsSync(indexPath)) {
    return undefined
  }

  return readFileSync(indexPath, 'utf-8')
}

export const MemoryReadTool = {
  name: 'MemoryRead',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  inputSchema,
  userFacingName() {
    return 'Read Memory'
  },
  async isEnabled() {
    // TODO: Gate with a setting or feature flag
    return false
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true // MemoryRead is read-only, safe for concurrent execution
  },
  needsPermissions() {
    return false
  },
  renderResultForAssistant({ content }) {
    return content
  },
  renderToolUseMessage(input) {
    return Object.entries(input)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ')
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output) {
    const preview = output.content.length > 100
      ? output.content.substring(0, 100) + '...'
      : output.content

    return (
      <Box justifyContent="space-between" overflowX="hidden" width="100%">
        <Box flexDirection="row">
          <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
          <Text>{preview}</Text>
        </Box>
      </Box>
    )
  },
  async validateInput({ file_path }, context) {
    const agentId = resolveAgentId(context?.agentId)
    const agentMemoryDir = join(MEMORY_DIR, 'agents', agentId)

    if (file_path) {
      const fullPath = join(agentMemoryDir, file_path)
      if (!fullPath.startsWith(agentMemoryDir)) {
        return { result: false, message: 'Invalid memory file path' }
      }
      if (!existsSync(fullPath)) {
        return { result: false, message: 'Memory file does not exist' }
      }
    }
    return { result: true }
  },
  async *call({ file_path, use_snapshot, include_pending }, context) {
    const agentId = resolveAgentId(context?.agentId)
    const agentMemoryDir = join(MEMORY_DIR, 'agents', agentId)
    mkdirSync(agentMemoryDir, { recursive: true })

    // If a specific file is requested, return its contents
    if (file_path) {
      const fullPath = join(agentMemoryDir, file_path)
      if (!existsSync(fullPath)) {
        throw new Error('Memory file does not exist')
      }
      const content = readFileSync(fullPath, 'utf-8')
      yield {
        type: 'result',
        data: {
          content,
        },
        resultForAssistant: this.renderResultForAssistant({ content }),
      }
      return
    }

    // Use snapshot if requested (faster, may be slightly stale)
    if (use_snapshot) {
      const snapshotManager = getMemorySnapshotManager(
        () => loadMemoriesContent(agentId)
      )
      // Use agentId as conversationId since ToolUseContext doesn't have conversationId
      const snapshot = await snapshotManager.getMemorySnapshot(agentId)

      if (snapshot) {
        let content = snapshot

        // Include pending memories if requested
        if (include_pending) {
          const pendingStore = getPendingMemoriesStore(agentId)
          const pendingMemories = pendingStore.listPending()
          if (pendingMemories.length > 0) {
            content += '\n\n--- Pending Memories ---\n'
            content += pendingMemories.map(m => m.content).join('\n\n')
          }
        }

        yield {
          type: 'result',
          data: { content },
          resultForAssistant: this.renderResultForAssistant({ content }),
        }
        return
      }
    }

    // Otherwise return the index and file list for this agent
    const files = readdirSync(agentMemoryDir, { recursive: true })
      .map(f => join(agentMemoryDir, f.toString()))
      .filter(f => !lstatSync(f).isDirectory())
      .map(f => `- ${f}`)
      .join('\n')

    const indexPath = join(agentMemoryDir, 'index.md')
    const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : ''

    const quotes = "'''"
    let content = `Here are the contents of the agent memory file, \`${indexPath}\`:
${quotes}
${index}
${quotes}

Files in the agent memory directory:
${files}`

    // Include pending memories if requested
    if (include_pending) {
      const pendingStore = getPendingMemoriesStore(agentId)
      const pendingMemories = pendingStore.listPending()
      if (pendingMemories.length > 0) {
        content += '\n\n--- Pending Memories ---\n'
        content += pendingMemories.map(m => `[${new Date(m.timestamp).toISOString()}] ${m.content}`).join('\n\n')
      }
    }

    yield {
      type: 'result',
      data: { content },
      resultForAssistant: this.renderResultForAssistant({ content }),
    }
  },
} satisfies Tool<typeof inputSchema, { content: string }>
