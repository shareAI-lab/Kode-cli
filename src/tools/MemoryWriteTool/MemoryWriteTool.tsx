import { mkdirSync, writeFileSync } from 'fs'
import { Box, Text } from 'ink'
import { dirname, join } from 'path'
import * as React from 'react'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool } from '@tool'
import { MEMORY_DIR } from '@utils/env'
import { resolveAgentId } from '@utils/agentStorage'
import { recordFileEdit } from '@services/fileFreshness'
import { DESCRIPTION, PROMPT } from './prompt'
import {
  getPendingMemoriesStore,
  getMemoryUpdateManager,
} from '@utils/agentTools'

const inputSchema = z.strictObject({
  file_path: z.string().describe('Path to the memory file to write'),
  content: z.string().describe('Content to write to the file'),
  use_pending: z
    .boolean()
    .optional()
    .describe('If true, store as pending memory to be flushed later (default: false, writes immediately)'),
})

export const MemoryWriteTool = {
  name: 'MemoryWrite',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  inputSchema,
  userFacingName() {
    return 'Write Memory'
  },
  async isEnabled() {
    // TODO: Gate with a setting or feature flag
    return false
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false // MemoryWrite modifies state, not safe for concurrent execution
  },
  needsPermissions() {
    return false
  },
  renderResultForAssistant(content) {
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
    const message = typeof output === 'string' ? output : 'Updated memory'
    return (
      <Box justifyContent="space-between" overflowX="hidden" width="100%">
        <Box flexDirection="row">
          <Text>{'  '}⎿ {message}</Text>
        </Box>
      </Box>
    )
  },
  async validateInput({ file_path }, context) {
    const agentId = resolveAgentId(context?.agentId)
    const agentMemoryDir = join(MEMORY_DIR, 'agents', agentId)
    const fullPath = join(agentMemoryDir, file_path)
    if (!fullPath.startsWith(agentMemoryDir)) {
      return { result: false, message: 'Invalid memory file path' }
    }
    return { result: true }
  },
  async *call({ file_path, content, use_pending }, context) {
    const agentId = resolveAgentId(context?.agentId)
    const agentMemoryDir = join(MEMORY_DIR, 'agents', agentId)
    const fullPath = join(agentMemoryDir, file_path)

    // If using pending storage, add to pending store instead of writing immediately
    if (use_pending) {
      const pendingStore = getPendingMemoriesStore(agentId)
      const memoryEntry = {
        id: randomUUID(),
        content,
        version: 1,
      }
      await pendingStore.append(memoryEntry)

      // Notify listeners that memory has been updated
      const updateManager = getMemoryUpdateManager()
      updateManager.notifyMemoryHasUpdates()

      yield {
        type: 'result',
        data: `Added to pending memories (${pendingStore.pendingCount} pending)`,
        resultForAssistant: `Memory added to pending queue. ${pendingStore.pendingCount} memories awaiting flush.`,
      }
      return
    }

    // Write immediately
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')

    // Record Agent edit operation for file freshness tracking
    recordFileEdit(fullPath, content)

    // Notify listeners that memory has been updated
    const updateManager = getMemoryUpdateManager()
    updateManager.notifyMemoryHasUpdates()

    yield {
      type: 'result',
      data: 'Saved',
      resultForAssistant: 'Saved',
    }
  },
} satisfies Tool<typeof inputSchema, string>
