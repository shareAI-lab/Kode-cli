import { Tool } from './Tool'
import { TaskTool } from './tools/TaskTool/TaskTool'
import { ArchitectTool } from './tools/ArchitectTool/ArchitectTool'
import { BashTool } from './tools/BashTool/BashTool'
import { AskExpertModelTool } from './tools/AskExpertModelTool/AskExpertModelTool'
import { FileEditTool } from './tools/FileEditTool/FileEditTool'
import { FileReadTool } from './tools/FileReadTool/FileReadTool'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool'
import { GlobTool } from './tools/GlobTool/GlobTool'
import { GrepTool } from './tools/GrepTool/GrepTool'
import { LSTool } from './tools/lsTool/lsTool'
import { MemoryReadTool } from './tools/MemoryReadTool/MemoryReadTool'
import { MemoryWriteTool } from './tools/MemoryWriteTool/MemoryWriteTool'
import { MultiEditTool } from './tools/MultiEditTool/MultiEditTool'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool'
import { NotebookReadTool } from './tools/NotebookReadTool/NotebookReadTool'
import { ThinkTool } from './tools/ThinkTool/ThinkTool'
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool'
import { URLFetcherTool } from './tools/URLFetcherTool/URLFetcherTool'
import { getMCPTools } from './services/mcpClient'
import { memoize } from 'lodash-es'

const ANT_ONLY_TOOLS = [MemoryReadTool as unknown as Tool, MemoryWriteTool as unknown as Tool]

// Function to avoid circular dependencies that break bun
export const getAllTools = (): Tool[] => {
  return [
    TaskTool as unknown as Tool,
    AskExpertModelTool as unknown as Tool,
    BashTool as unknown as Tool,
    GlobTool as unknown as Tool,
    GrepTool as unknown as Tool,
    LSTool as unknown as Tool,
    FileReadTool as unknown as Tool,
    FileEditTool as unknown as Tool,
    MultiEditTool as unknown as Tool,
    FileWriteTool as unknown as Tool,
    NotebookReadTool as unknown as Tool,
    NotebookEditTool as unknown as Tool,
    ThinkTool as unknown as Tool,
    TodoWriteTool as unknown as Tool,
    WebSearchTool as unknown as Tool,
    URLFetcherTool as unknown as Tool,
    ...ANT_ONLY_TOOLS,
  ]
}

export const getTools = memoize(
  async (enableArchitect?: boolean): Promise<Tool[]> => {
    const tools = [...getAllTools(), ...(await getMCPTools())]

    // Only include Architect tool if enabled via config or CLI flag
    if (enableArchitect) {
      tools.push(ArchitectTool as unknown as Tool)
    }

    const isEnabled = await Promise.all(tools.map(tool => tool.isEnabled()))
    return tools.filter((_, i) => isEnabled[i])
  },
)

export const getReadOnlyTools = memoize(async (): Promise<Tool[]> => {
  const tools = getAllTools().filter(tool => tool.isReadOnly())
  const isEnabled = await Promise.all(tools.map(tool => tool.isEnabled()))
  return tools.filter((_, index) => isEnabled[index])
})
