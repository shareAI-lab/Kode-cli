import { type Tool } from '@tool'
import { getTools, getReadOnlyTools } from '@tools'
import { TaskTool } from './TaskTool'
import { BashTool } from '@tools/BashTool/BashTool'
import { FileWriteTool } from '@tools/FileWriteTool/FileWriteTool'
import { FileEditTool } from '@tools/FileEditTool/FileEditTool'
import { NotebookEditTool } from '@tools/NotebookEditTool/NotebookEditTool'
import { GlobTool } from '@tools/GlobTool/GlobTool'
import { FileReadTool } from '@tools/FileReadTool/FileReadTool'
import { getModelManager } from '@utils/model'
import { getActiveAgents } from '@utils/agentLoader'

export async function getTaskTools(safeMode: boolean): Promise<Tool[]> {
  // No recursive tasks, yet..
  return (await (!safeMode ? getTools() : getReadOnlyTools())).filter(
    _ => _.name !== TaskTool.name,
  )
}

export async function getPrompt(safeMode: boolean): Promise<string> {
  // Maintain compatibility with Claude Code `.claude` agent descriptions
  const agents = await getActiveAgents()
  
  // Format exactly as in original: (Tools: tool1, tool2)
  const agentDescriptions = agents.map(agent => {
    const toolsStr = Array.isArray(agent.tools) 
      ? agent.tools.join(', ')
      : '*'
    return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsStr})`
  }).join('\n')
  
  // Keep the wording aligned so shared `.claude` agent packs behave identically
  return `Launch a new agent to handle complex, multi-step tasks autonomously.

**IMPORTANT: This tool can be run in parallel.** Multiple sub-agents can execute simultaneously with different names and instructions. Use parallel execution when you have multiple independent tasks that can be completed concurrently.

Available actions:
- **run** - Execute a sub-agent with the given instruction (default, waits for completion)
- **output** - Show the response and file changes (if any) made by a completed sub-agent

Available agent types and the tools they have access to:
${agentDescriptions}

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

When to use the Agent tool:
- When you are instructed to execute custom slash commands. Use the Agent tool with the slash command invocation as the entire prompt. The slash command can take arguments. For example: Task(description="Check the file", prompt="/check-file path/to/file.py")
- When you need to run multiple independent tasks in parallel

When NOT to use the Agent tool:
- If you want to read a specific file path, use the ${FileReadTool.name} or ${GlobTool.name} tool instead of the Agent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the ${GlobTool.name} tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FileReadTool.name} tool instead of the Agent tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
3. Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
4. The agent's outputs should generally be trusted
5. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
6. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
7. Give each agent a unique name using the 'name' parameter for easier tracking and to retrieve results later with the 'output' action.
8. Use the 'output' action to retrieve detailed results (including file changes) from a previously completed agent.

Example usage:

<example_agent_descriptions>
"code-reviewer": use this agent after you are done writing a signficant piece of code
"greeting-responder": use this agent when to respond to user greetings with a friendly joke
</example_agent_description>

<example>
user: "Please write a function that checks if a number is prime"
assistant: Sure let me write a function that checks if a number is prime
assistant: First let me use the ${FileWriteTool.name} tool to write a function that checks if a number is prime
assistant: I'm going to use the ${FileWriteTool.name} tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a signficant piece of code was written and the task was completed, now use the code-reviewer agent to review the code
</commentary>
assistant: Now let me use the code-reviewer agent to review the code
assistant: Uses the Task tool to launch the code-reviewer agent with name="prime-review"
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the Task tool to launch the greeting-responder agent"
</example>

<example>
user: "Run tests and lint checks in parallel"
<commentary>
These are independent tasks that can run concurrently
</commentary>
assistant: I'll run both tasks in parallel using named agents
assistant: Uses Task tool twice in the same message:
- Task(action="run", name="test-runner", description="Run tests", prompt="...", subagent_type="general-purpose")
- Task(action="run", name="lint-checker", description="Run linting", prompt="...", subagent_type="general-purpose")
After both complete, can use Task(action="output", name="test-runner") to see detailed test results
</example>`
}
