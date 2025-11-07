/**
 * LangChain-based orchestrator
 * Uses LangChain's agent framework for better orchestration
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ChatOllama } from '@langchain/ollama';
import { createAgent, tool } from 'langchain';
import { z } from 'zod';
import { MCPTools } from '../mcpTools';
import { ToolCall, ToolResult, CodebaseState, FileChange, SubAgent, SubAgentResult } from '../types';
import { MCPToolAdapter } from './mcpToolAdapter';
import { gatherCodeContext } from '../contextGatherer';
import { getAIResponse } from '../ollamaClient';
import { CodeAnalyzer } from './codeAnalyzer';

// Import message classes with require to avoid module resolution issues
let HumanMessage: any;
let AIMessage: any;
let ToolMessage: any;
let SystemMessage: any;

try {
    const messagesModule = require('@langchain/core/messages');
    HumanMessage = messagesModule.HumanMessage;
    AIMessage = messagesModule.AIMessage;
    ToolMessage = messagesModule.ToolMessage;
    SystemMessage = messagesModule.SystemMessage;
} catch {
    // Fallback: create simple message-like objects
    HumanMessage = class {
        constructor(public content: string) { }
        getType() { return 'human'; }
    };
    AIMessage = class {
        constructor(public content: string) { }
        getType() { return 'ai'; }
    };
    ToolMessage = class {
        constructor(public content: string, public tool_call_id?: string, public name?: string) {
            this.tool_call_id = tool_call_id;
            this.name = name;
        }
        getType() { return 'tool'; }
        // Add status field to match LangChain's ToolMessage structure
        status?: 'success' | 'error' = 'success';
    };
    SystemMessage = class {
        constructor(public content: string) { }
        getType() { return 'system'; }
    };
}

/**
 * Enhanced LangChain-based orchestrator with state-of-the-art features
 * Similar to Cursor and GitHub Copilot
 */
export class LangChainOrchestrator {
    private mcpTools: MCPTools;
    private toolAdapter: MCPToolAdapter;
    private llm: ChatOllama;
    private tools: ReturnType<typeof tool>[];
    private modelWithTools: any; // Model with tools bound using bind_tools()
    private agent: ReturnType<typeof createAgent> | null = null;
    private maxIterations: number = 50; // Increased for complex tasks
    private maxExecutionTime: number = 10 * 60 * 1000; // 10 minutes for complex tasks
    public currentModel: string;
    public currentUrl: string;

    // State tracking (like Cursor/Copilot)
    private codebaseState: CodebaseState = {
        filesRead: new Set<string>(),
        filesModified: new Set<string>(),
        testsRun: 0,
        testsPassed: 0,
        errors: []
    };
    private fileChanges: FileChange[] = [];
    private conversationHistory: Array<{ role: string; content: string; timestamp: Date }> = [];
    private recentActions: Array<{ action: string; timestamp: number }> = [];
    private todos: Array<{ task: string; status: 'pending' | 'in_progress' | 'completed' }> = [];

    // State-of-the-art features (Deep Agents inspired)
    private readonly LARGE_RESULT_THRESHOLD = 50000; // ~20k tokens (rough estimate: 1 token ≈ 2.5 chars)
    private readonly MAX_MESSAGES_BEFORE_SUMMARIZATION = 50;
    private readonly MESSAGES_TO_KEEP_INTACT = 6;
    private toolResultCache: Map<string, string> = new Map(); // Cache for evicted large results

    // Subagent system
    private subagents: Map<string, SubAgent> = new Map();
    private readonly GENERAL_PURPOSE_SUBAGENT_NAME = 'general-purpose';

    constructor(mcpTools: MCPTools, model: string, ollamaUrl: string) {
        this.mcpTools = mcpTools;
        this.toolAdapter = new MCPToolAdapter(mcpTools);
        this.currentModel = model;
        this.currentUrl = ollamaUrl;

        // Initialize Ollama LLM with optimized settings for code tasks
        this.llm = new ChatOllama({
            model,
            baseUrl: ollamaUrl,
            temperature: 0.2, // Lower temperature for more deterministic, focused code generation
            topK: 40,
            topP: 0.9,
            numCtx: 8192, // Larger context window for better code understanding
        });

        // Create LangChain tools using the adapter
        const mcpToolsList = this.toolAdapter.toLangChainTools();

        // Add planning tool (write_todos) similar to Deep Agents
        const planningTool = tool(
            async ({ todos: todoList }: { todos: Array<{ task: string; status?: 'pending' | 'in_progress' | 'completed' }> }) => {
                // Update todos list
                this.todos = todoList.map(t => ({
                    task: t.task,
                    status: t.status || 'pending'
                }));

                // Format todos for display
                const formatted = this.todos.map((t, i) => {
                    const statusIcon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⏳';
                    return `${i + 1}. ${statusIcon} ${t.task}`;
                }).join('\n');

                return `Todo list updated:\n\n${formatted}`;
            },
            {
                name: 'write_todos',
                description: 'Create or update a todo list to break down complex tasks into discrete steps. Use this for planning multi-step tasks. Each todo should be a clear, actionable step.',
                schema: z.object({
                    todos: z.array(z.object({
                        task: z.string().describe('A clear, actionable task description'),
                        status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('The status of this task')
                    })).describe('List of todos/tasks to track')
                }),
            }
        );

        // Add advanced code analysis tool
        const analyzeCodeTool = tool(
            async ({ file_path }: { file_path: string }) => {
                try {
                    // Resolve file path relative to workspace
                    const workspaceFolders = require('vscode').workspace.workspaceFolders;
                    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || process.cwd();
                    const fullPath = path.isAbsolute(file_path)
                        ? file_path
                        : path.join(workspaceRoot, file_path);

                    const content = require('fs').readFileSync(fullPath, 'utf-8');
                    const summary = CodeAnalyzer.getCodeSummary(fullPath, content);

                    // Also detect duplicates
                    const duplicates = CodeAnalyzer.detectDuplicateEndpoints(fullPath, content);
                    if (duplicates.length > 0) {
                        return `${summary}\n\n⚠️ ISSUES FOUND:\n${duplicates.map(d =>
                            `- ${d.type}: ${d.occurrences.length} duplicate occurrences at lines ${d.occurrences.map(o => o.line).join(', ')}`
                        ).join('\n')}\n\nACTION REQUIRED: Remove the duplicate endpoint(s) using replace_code or search_replace.`;
                    }

                    return summary;
                } catch (error: any) {
                    return `Error analyzing file: ${error.message}. Make sure the file path is correct (can be relative to workspace root or absolute path).`;
                }
            },
            {
                name: 'analyze_code',
                description: 'Perform deep code analysis on a file. Understands code structure, detects duplicates, endpoints, functions, and classes. Use this FIRST when checking for duplicates or understanding code structure - it automatically detects and reports issues. Works with any file path (relative or absolute).',
                schema: z.object({
                    file_path: z.string().describe('The path to the file to analyze (can be relative to workspace root or absolute path)')
                }),
            }
        );

        // Initialize general-purpose subagent (always available)
        this.subagents.set(this.GENERAL_PURPOSE_SUBAGENT_NAME, {
            name: this.GENERAL_PURPOSE_SUBAGENT_NAME,
            description: 'A general-purpose subagent for context isolation. Use this to delegate complex multi-step tasks that would clutter the main agent\'s context. The subagent will work independently and return a concise summary.',
            systemPrompt: 'You are a helpful assistant that completes tasks efficiently. Work independently and return concise, actionable results.',
            tools: [] // All tools available
        });

        // Add task delegation tool (for subagents)
        const taskTool = tool(
            async ({ name, task }: { name: string; task: string }) => {
                return await this.executeSubagentTask(name, task);
            },
            {
                name: 'task',
                description: `Delegate a task to a subagent for context isolation. Available subagents:
- ${this.GENERAL_PURPOSE_SUBAGENT_NAME}: Use for any complex multi-step task that would clutter context. Always available.
${Array.from(this.subagents.values())
                        .filter(sa => sa.name !== this.GENERAL_PURPOSE_SUBAGENT_NAME)
                        .map(sa => `- ${sa.name}: ${sa.description}`)
                        .join('\n')}

Use subagents when:
- A task requires many tool calls that would fill up context
- You need to keep the main conversation focused on high-level coordination
- The task is complex and multi-step

The subagent will work independently and return a concise summary.`,
                schema: z.object({
                    name: z.string().describe('The name of the subagent to delegate to'),
                    task: z.string().describe('The task description for the subagent to complete')
                }),
            }
        );

        this.tools = [...mcpToolsList, planningTool, analyzeCodeTool, taskTool];

        // Bind tools to the model using LangChain's bindTools() method
        // This enables native tool calling support
        this.modelWithTools = this.llm.bindTools(this.tools);
    }

    /**
     * Create LangChain tools from MCPTools (deprecated - use MCPToolAdapter instead)
     */
    private createLangChainTools(): ReturnType<typeof tool>[] {
        return [
            // File operations
            tool(
                async ({ file_path }: { file_path: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'read_file',
                        arguments: { file_path }
                    });
                    return result.success ? (result.content || 'Success') : `Error: ${result.error || 'Unknown error'}`;
                },
                {
                    name: 'read_file',
                    description: 'Read the contents of a file',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file to read'),
                    }),
                }
            ),
            tool(
                async ({ file_path, content }: { file_path: string; content: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'write_file',
                        arguments: { file_path, content }
                    });
                    return result.success ? 'File written successfully' : `Error: ${result.error || 'Unknown error'}`;
                },
                {
                    name: 'write_file',
                    description: 'Write or create a file',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file to write'),
                        content: z.string().describe('The content to write to the file'),
                    }),
                }
            ),
            tool(
                async ({ directory_path }: { directory_path: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'list_files',
                        arguments: { directory_path }
                    });
                    return result.success ? (result.content || 'Empty directory') : `Error: ${result.error || 'Unknown error'}`;
                },
                {
                    name: 'list_files',
                    description: 'List files in a directory',
                    schema: z.object({
                        directory_path: z.string().describe('The path to the directory to list'),
                    }),
                }
            ),
            tool(
                async ({ file_path, search, replace }: { file_path: string; search: string; replace: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'search_replace',
                        arguments: { file_path, search, replace }
                    });
                    return result.success ? 'Search and replace completed' : `Error: ${result.error || 'Unknown error'}`;
                },
                {
                    name: 'search_replace',
                    description: 'Search and replace text in a file',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file'),
                        search: z.string().describe('The text to search for'),
                        replace: z.string().describe('The text to replace with'),
                    }),
                }
            ),
            tool(
                async ({ pattern, directory }: { pattern: string; directory?: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'search_files',
                        arguments: { pattern, directory: directory || '.' }
                    });
                    return result.success ? (result.content || 'No files found') : `Error: ${result.error || 'Unknown error'}`;
                },
                {
                    name: 'search_files',
                    description: 'Search for files by pattern',
                    schema: z.object({
                        pattern: z.string().describe('The file pattern to search for (e.g., "*.ts")'),
                        directory: z.string().optional().describe('The directory to search in (default: current directory)'),
                    }),
                }
            ),
            // Code operations
            tool(
                async ({ file_path, start_line, end_line }: { file_path: string; start_line: number; end_line: number }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'read_file_lines',
                        arguments: { file_path, start_line, end_line }
                    });
                    return result.success ? (result.content || '') : `Error: ${result.error || 'Unknown error'}`;
                },
                {
                    name: 'read_file_lines',
                    description: 'Read specific lines from a file',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file'),
                        start_line: z.number().describe('The starting line number (1-indexed)'),
                        end_line: z.number().describe('The ending line number (1-indexed)'),
                    }),
                }
            ),
            // Command execution
            tool(
                async ({ command, cwd }: { command: string; cwd?: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'run_command',
                        arguments: { command, cwd: cwd || '.' }
                    });
                    return result.success ? (result.content || 'Command executed successfully') : `Error: ${result.error || 'Unknown error'}`;
                },
                {
                    name: 'run_command',
                    description: 'Execute a shell command',
                    schema: z.object({
                        command: z.string().describe('The command to execute'),
                        cwd: z.string().optional().describe('The working directory (default: current directory)'),
                    }),
                }
            ),
            tool(
                async ({ file_path, language }: { file_path: string; language?: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'validate_syntax',
                        arguments: { file_path, language: language || 'auto' }
                    });
                    return result.success ? 'Syntax is valid' : `Error: ${result.error || 'Syntax error'}`;
                },
                {
                    name: 'validate_syntax',
                    description: 'Validate code syntax',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file to validate'),
                        language: z.string().optional().describe('The programming language (auto-detected if not specified)'),
                    }),
                }
            ),
            // Advanced file operations
            tool(
                async ({ file_path }: { file_path: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'get_file_info',
                        arguments: { file_path }
                    });
                    return result.success ? (result.content || 'File info retrieved') : `Error: ${result.error || 'Unknown error'}`;
                },
                {
                    name: 'get_file_info',
                    description: 'Get file metadata (size, modified date, type)',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file'),
                    }),
                }
            ),
            tool(
                async ({ file_path, patch }: { file_path: string; patch: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'apply_patch',
                        arguments: { file_path, patch }
                    });
                    return result.success ? 'Patch applied successfully' : `Error: ${result.error || 'Failed to apply patch'}`;
                },
                {
                    name: 'apply_patch',
                    description: 'Apply a unified diff patch to a file',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file to patch'),
                        patch: z.string().describe('The unified diff patch to apply'),
                    }),
                }
            ),
            // Code manipulation tools
            tool(
                async ({ file_path, line_number, code }: { file_path: string; line_number: number; code: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'insert_code',
                        arguments: { file_path, line_number, code }
                    });
                    return result.success ? 'Code inserted successfully' : `Error: ${result.error || 'Failed to insert code'}`;
                },
                {
                    name: 'insert_code',
                    description: 'Insert code at a specific line number in a file',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file'),
                        line_number: z.number().describe('The line number to insert at (1-indexed)'),
                        code: z.string().describe('The code to insert'),
                    }),
                }
            ),
            tool(
                async ({ file_path, start_line, end_line, new_code }: { file_path: string; start_line: number; end_line: number; new_code: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'replace_code',
                        arguments: { file_path, start_line, end_line, new_code }
                    });
                    return result.success ? 'Code replaced successfully' : `Error: ${result.error || 'Failed to replace code'}`;
                },
                {
                    name: 'replace_code',
                    description: 'Replace a code block between start_line and end_line with new code',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file'),
                        start_line: z.number().describe('The starting line number (1-indexed)'),
                        end_line: z.number().describe('The ending line number (1-indexed)'),
                        new_code: z.string().describe('The new code to replace with'),
                    }),
                }
            ),
            tool(
                async ({ file_path, function_name }: { file_path: string; function_name: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'extract_function',
                        arguments: { file_path, function_name }
                    });
                    return result.success ? (result.content || 'Function extracted') : `Error: ${result.error || 'Failed to extract function'}`;
                },
                {
                    name: 'extract_function',
                    description: 'Extract a function definition from a file',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file'),
                        function_name: z.string().describe('The name of the function to extract'),
                    }),
                }
            ),
            tool(
                async ({ pattern, file_path, language }: { pattern: string; file_path?: string; language?: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'find_code_pattern',
                        arguments: { pattern, file_path, language }
                    });
                    return result.success ? (result.content || 'Pattern not found') : `Error: ${result.error || 'Failed to search pattern'}`;
                },
                {
                    name: 'find_code_pattern',
                    description: 'Find code patterns using regex in a file',
                    schema: z.object({
                        pattern: z.string().describe('The regex pattern to search for'),
                        file_path: z.string().optional().describe('The path to the file (optional)'),
                        language: z.string().optional().describe('The programming language (optional)'),
                    }),
                }
            ),
            // Code understanding tools
            tool(
                async ({ file_path }: { file_path: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'analyze_code_structure',
                        arguments: { file_path }
                    });
                    return result.success ? (result.content || 'Analysis complete') : `Error: ${result.error || 'Failed to analyze code'}`;
                },
                {
                    name: 'analyze_code_structure',
                    description: 'Analyze code structure (functions, classes, imports)',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file to analyze'),
                    }),
                }
            ),
            tool(
                async ({ file_path }: { file_path: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'find_dependencies',
                        arguments: { file_path }
                    });
                    return result.success ? (result.content || 'No dependencies found') : `Error: ${result.error || 'Failed to find dependencies'}`;
                },
                {
                    name: 'find_dependencies',
                    description: 'Find file dependencies and imports',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file'),
                    }),
                }
            ),
            tool(
                async ({ symbol, file_path }: { symbol: string; file_path?: string }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'find_usages',
                        arguments: { symbol, file_path }
                    });
                    return result.success ? (result.content || 'No usages found') : `Error: ${result.error || 'Failed to find usages'}`;
                },
                {
                    name: 'find_usages',
                    description: 'Find where a symbol is used',
                    schema: z.object({
                        symbol: z.string().describe('The symbol to search for'),
                        file_path: z.string().optional().describe('The file to search in (optional, searches all files if not specified)'),
                    }),
                }
            ),
            tool(
                async ({ file_path, line_number }: { file_path: string; line_number: number }) => {
                    const result = await this.mcpTools.executeTool({
                        name: 'get_code_context',
                        arguments: { file_path, line_number }
                    });
                    return result.success ? (result.content || 'Context retrieved') : `Error: ${result.error || 'Failed to get context'}`;
                },
                {
                    name: 'get_code_context',
                    description: 'Get context around a specific line number',
                    schema: z.object({
                        file_path: z.string().describe('The path to the file'),
                        line_number: z.number().describe('The line number to get context around'),
                    }),
                }
            ),
        ];
    }

    /**
     * Initialize the agent
     */
    private async initializeAgent(systemMessage: string, additionalContext?: string): Promise<ReturnType<typeof createAgent>> {
        if (this.agent) {
            return this.agent;
        }

        const workspaceState = this.getWorkspaceStateSummary();

        // State-of-the-art system prompt - Natural, reasoning-focused, like Cursor/Copilot
        const enhancedSystemMessage = `${systemMessage}

You are an expert AI coding assistant, similar to Cursor or GitHub Copilot. You help developers write, edit, and understand code through natural conversation and intelligent code manipulation.

${workspaceState !== 'No recent activity.' ? `CURRENT WORKSPACE STATE:\n${workspaceState}\n\n` : ''}

${additionalContext ? `CURRENT CONTEXT:\n${additionalContext}\n\n` : ''}

## Your Approach

Work like a senior developer pair-programming with the user:

1. **Understand Context First**: When given a task, start by understanding the codebase structure. Use list_files to explore, analyze_code to understand code structure and detect issues, or read_file for full file content. Adapt to whatever structure the codebase has.

2. **Reason About Solutions**: Think through the problem naturally. What needs to change? Why? What's the best approach? For complex tasks, break them down using write_todos.

3. **Take Action**: Make changes directly using the appropriate tools. When you understand what needs to be done, do it. Don't just describe what you'll do - actually execute the changes.

4. **Verify and Iterate**: After making changes, verify they work. Re-read the file, re-analyze it, check syntax, test if appropriate, and refine as needed.

## Code Understanding

You have access to advanced code analysis tools:
- **analyze_code**: Deep code analysis that understands structure, detects duplicates, lists endpoints/functions/classes. Use this FIRST when you need to understand code structure or check for issues like duplicates. It automatically detects and reports problems.
- **read_file**: Read full file contents when you need to see the full code
- **analyze_code_structure**: Analyze code structure and dependencies

When to use analyze_code:
- When checking for duplicates or code issues
- When understanding what endpoints/functions/classes exist in a file
- When analyzing code structure before making changes
- When the user asks you to "check", "verify", "review", or mentions duplicates

The analyze_code tool automatically detects issues and shows you exactly where they are, making it much faster than manually reading and analyzing code.

## Working with Code

When editing code, follow these principles:
- **Understand first**: Use analyze_code to understand structure and detect issues, then read_file for full content when needed
- **Targeted edits**: Use replace_code or search_replace for specific changes (removing duplicates, fixing issues). Use write_file for creating new files or complete rewrites
- **Incremental changes**: Make small, focused edits rather than large rewrites
- **Preserve style**: Match existing code style and patterns
- **Verify**: Check syntax and test your changes when appropriate
- **Explain**: Describe what you changed and why

For fixing issues like duplicates:
- Use analyze_code to automatically detect the issue
- The tool will show you exactly where the problem is
- Use replace_code or search_replace to fix it (these are better for targeted edits than write_file)
- Remove the entire problematic block, not just part of it

## Available Tools

${this.toolAdapter.getToolsDescription()}

### Task Delegation (Subagents)

You have access to a \`task\` tool for delegating work to subagents. This is useful for:
- Complex multi-step tasks that would clutter your context
- Tasks requiring many tool calls (e.g., exploring a large codebase, running multiple analyses)
- Keeping your main conversation focused on high-level coordination

Use \`task(name="general-purpose", task="...")\` to delegate complex tasks. The subagent will work independently in isolated context and return a concise summary.

**Available subagents:**
- **general-purpose**: Always available. Use for any complex multi-step task that would clutter context. The subagent will complete the task independently and return a summary.

## Workflow Patterns

**When checking for duplicates or issues**:
1. Use analyze_code FIRST on the file in question to automatically detect duplicates, issues, and understand structure
2. Review the analysis output - it will highlight any issues found
3. Read the file to see the exact code if needed
4. Use replace_code or search_replace to fix the issue (NOT write_file for targeted edits)
5. Verify the fix by re-reading or re-analyzing the file

**When exploring a codebase**:
1. Use list_files to understand the project structure
2. Use read_file or analyze_code to examine specific files
3. Look for entry points, configuration files, or relevant code
4. Provide specific instructions based on what you discover

**When making changes**:
1. Understand the code structure first (analyze_code for structure, read_file for full content)
2. Use the appropriate editing tool (replace_code, search_replace, insert_code, or write_file)
3. Make focused, incremental changes
4. Verify your changes work

## Principles

- Be conversational and helpful
- Explain your reasoning as you work
- Make changes incrementally and show progress
- Verify your work
- Think about the user's intent, not just literal requests
- Use tools naturally as part of your workflow
`;

        // Create agent - LangChain v1.0 API
        // The agent will automatically execute tools when the model makes tool calls
        this.agent = createAgent({
            model: this.llm,
            tools: this.tools,
            prompt: enhancedSystemMessage,
        } as any);

        return this.agent;
    }

    /**
     * Build system prompt for ReAct loop
     */
    private buildSystemPrompt(baseSystemMessage: string, codeContext?: string): string {
        const workspaceState = this.getWorkspaceStateSummary();

        return `${baseSystemMessage}

${this.toolAdapter.getToolsDescription()}

## REASONING PROCESS (ReAct Pattern)

Think step-by-step about each task:

1. **OBSERVE**: Understand the current state
   - What files exist in the codebase?
   - What is the task asking for?
   - What context do you have?

2. **REASON**: Plan your approach
   - For complex, multi-step tasks, use the write_todos tool to break down the work into discrete steps
   - What information do you need?
   - Which files should you examine?
   - What changes need to be made?
   - What's the best way to accomplish this?

3. **ACT**: Execute tools based on your reasoning
   - Use tools to gather information
   - Use tools to make changes
   - Verify your work
   - Update todo status as you progress

4. **REFLECT**: After each tool execution
   - What did you learn?
   - What should you do next?
   - Are you making progress toward the goal?
   - Update todos to reflect completed steps

${workspaceState !== 'No recent activity.' ? `CURRENT WORKSPACE STATE:\n${workspaceState}\n\n` : ''}

${codeContext ? `CURRENT CODEBASE CONTEXT:\n${codeContext}\n\n` : ''}

## TOOL CALL FORMAT

When you decide to use a tool, output it as JSON:
{"name": "tool_name", "arguments": {"arg1": "value1", "arg2": "value2"}}

The tools will execute automatically. After a tool executes, you will see its result. You MUST then:
1. Read and understand the tool result
2. Decide what to do next based on the result
3. Execute the next tool or complete the task
4. DO NOT stop after one tool - keep going until the task is done

CRITICAL: After each tool result, immediately decide on the next step and execute it. Don't pause or stop.`;
    }

    /**
     * Get AI message class
     */
    private getAIMessageClass(): any {
        return AIMessage;
    }

    /**
     * Get Tool message class
     */
    private getToolMessageClass(): any {
        return ToolMessage;
    }

    /**
     * Get SystemMessage class (for creating system messages)
     */
    private getSystemMessageClass(): any {
        try {
            const messagesModule = require('@langchain/core/messages');
            return messagesModule.SystemMessage;
        } catch {
            return SystemMessage;
        }
    }

    /**
     * Orchestrate a task using LangChain
     */
    async orchestrate(
        task: string,
        systemMessage: string,
        model: string,
        ollamaUrl: string,
        onProgress: (message: string) => void,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void,
        onMessage: (role: string, content: string) => void
    ): Promise<void> {
        const startTime = Date.now();

        try {
            // Update LLM if model or URL changed
            if (this.currentModel !== model || this.currentUrl !== ollamaUrl) {
                this.currentModel = model;
                this.currentUrl = ollamaUrl;
                this.llm = new ChatOllama({
                    model,
                    baseUrl: ollamaUrl,
                    temperature: 0.2, // Lower temperature for more deterministic code generation
                    topK: 40,
                    topP: 0.9,
                    numCtx: 8192,
                });
                // Rebind tools to the new model
                this.modelWithTools = this.llm.bindTools(this.tools);
                this.agent = null; // Reset agent to recreate with new model
            }

            // Reset state for new task
            this.resetState();

            // Execute the task with advanced ReAct-style planning
            // Step 1: Gather comprehensive context (like Cursor does)
            onProgress('Analyzing codebase...');
            const codeContext = await gatherCodeContext();

            // Initialize agent with context
            onProgress('Initializing LangChain agent...');
            const agent = await this.initializeAgent(systemMessage, codeContext || undefined);

            // Use LangChain's native tool calling with bind_tools()
            // This is the proper way to use tools with LangChain models

            const systemPrompt = this.buildSystemPrompt(systemMessage, codeContext || undefined);

            // Build message history using LangChain message types
            const messages: any[] = [];

            // Add system message
            messages.push(new SystemMessage(systemPrompt));

            // Initial user message with task
            messages.push(new HumanMessage(task));

            // Main agent loop using Ollama's native tool calling
            // LangChain's bindTools() converts tools to Ollama format and handles message conversion
            // Ollama format: { role: "tool", tool_name: "...", content: "..." }
            // LangChain format: ToolMessage(content, tool_call_id, name)
            // LangChain automatically converts between formats when calling Ollama API
            let iterationCount = 0;
            const maxIterations = 50;

            // Track message history for summarization
            let totalMessageTokens = 0; // Rough estimate

            while (iterationCount < maxIterations && Date.now() - startTime < this.maxExecutionTime) {
                iterationCount++;

                // Check for loops
                if (this.detectLoop()) {
                    onMessage('system', '⚠️ Detected potential loop. Considering if task is complete...');
                    const completionCheck = await this.checkTaskCompletion(task);
                    if (completionCheck.complete) {
                        onMessage('system', `✅ ${completionCheck.summary}`);
                        break;
                    }
                }

                onProgress(`Iteration ${iterationCount}/${maxIterations}...`);

                try {
                    // Use LangChain's model.invoke() with bound tools
                    // LangChain's bindTools() automatically converts tools to Ollama format
                    // and handles the conversion between LangChain and Ollama message formats
                    const response = await this.modelWithTools.invoke(messages);

                    // Debug: Log response structure
                    console.log('LangChain response:', JSON.stringify({
                        hasContent: !!response.content,
                        contentLength: typeof response.content === 'string' ? response.content.length : 0,
                        hasToolCalls: !!response.tool_calls,
                        toolCallsCount: response.tool_calls?.length || 0,
                        toolCalls: response.tool_calls?.map((tc: any) => ({
                            name: tc.name,
                            args: tc.args,
                            id: tc.id
                        }))
                    }, null, 2));

                    // Handle tool calls if present (LangChain format: response.tool_calls)
                    const toolCalls = response.tool_calls || [];
                    const hasNativeToolCalls = toolCalls.length > 0;

                    // Get content from LangChain AIMessage
                    const content = typeof response.content === 'string'
                        ? response.content
                        : (Array.isArray(response.content)
                            ? response.content.map((c: any) => c.text || c).join('')
                            : String(response.content || ''));

                    // Check for JSON tool calls in content (fallback for models that don't support native tool calling)
                    const jsonToolCall = this.parseJSONToolCallWithPosition(content);
                    const hasJSONToolCall = jsonToolCall && jsonToolCall.toolCall;

                    if (hasNativeToolCalls) {
                        // Model wants to call tools (native tool calling via LangChain)

                        // Show reasoning/thinking if any
                        if (content && content.trim()) {
                            onMessage('assistant', content);
                        }

                        // Add the AI message with tool calls to history
                        messages.push(response);

                        // Execute all tool calls and create ToolMessage objects
                        const toolMessages: any[] = [];
                        for (const toolCall of toolCalls) {
                            // Execute the tool
                            const toolResult = await this.executeLangChainToolCall(
                                toolCall,
                                onProgress,
                                onToolExecution,
                                onMessage
                            );

                            // Create ToolMessage with tool_call_id and name to link result to call
                            // LangChain ToolMessage format: { content, tool_call_id, name }
                            // LangChain will automatically convert this to Ollama format:
                            // { role: "tool", tool_name: name, content: content }
                            // when calling the Ollama API in the next iteration
                            const ToolMessageClass = this.getToolMessageClass();
                            const toolCallId = toolCall.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                            const toolMessage = new ToolMessageClass(
                                toolResult.content,
                                toolCallId,
                                toolCall.name
                            );
                            toolMessages.push(toolMessage);
                        }

                        // Add tool results to messages (LangChain format: ToolMessage objects)
                        messages.push(...toolMessages);

                        // Estimate token usage and summarize if needed (Deep Agents feature)
                        totalMessageTokens += this.estimateTokens(JSON.stringify(toolMessages));
                        if (messages.length > this.MAX_MESSAGES_BEFORE_SUMMARIZATION) {
                            await this.summarizeConversationHistory(messages, onMessage);
                            totalMessageTokens = this.estimateTokens(JSON.stringify(messages));
                        }

                        // Continue loop - model will see tool results and continue
                        continue;
                    } else if (hasJSONToolCall && jsonToolCall.toolCall) {
                        // Model output JSON tool call in text (fallback for models without native support)
                        console.log('Found JSON tool call in text, parsing and executing...');

                        // Show content without the JSON tool call
                        const cleanContent = this.filterToolCallJSON(content);
                        if (cleanContent.trim()) {
                            onMessage('assistant', cleanContent);
                        }

                        // Execute the parsed tool call
                        const toolCall = jsonToolCall.toolCall;
                        const toolResult = await this.executeLangChainToolCall(
                            {
                                name: toolCall.name,
                                args: toolCall.arguments,
                                id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                            },
                            onProgress,
                            onToolExecution,
                            onMessage
                        );

                        // Add assistant message to history (create AIMessage with clean content)
                        const AIMessageClass = this.getAIMessageClass();
                        const assistantMessage = new AIMessageClass(cleanContent);
                        messages.push(assistantMessage);

                        // Create ToolMessage with tool_call_id and name
                        const ToolMessageClass = this.getToolMessageClass();
                        const toolCallId = (toolCall as any).id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                        const toolMessage = new ToolMessageClass(
                            toolResult.content,
                            toolCallId,
                            toolCall.name
                        );
                        messages.push(toolMessage);

                        // Estimate token usage and summarize if needed (Deep Agents feature)
                        totalMessageTokens += this.estimateTokens(JSON.stringify(toolMessage));
                        if (messages.length > this.MAX_MESSAGES_BEFORE_SUMMARIZATION) {
                            await this.summarizeConversationHistory(messages, onMessage);
                            totalMessageTokens = this.estimateTokens(JSON.stringify(messages));
                        }

                        // Continue loop - model will see tool result and continue
                        continue;
                    } else {
                        // No tool calls - model is giving a final answer

                        // Show the response only if it's meaningful (not empty or generic)
                        const isGenericResponse = content.toLowerCase().includes('feel free to let me know') ||
                            content.toLowerCase().includes('if you have any questions') ||
                            content.toLowerCase().includes('additional information') ||
                            (content.trim().length < 20 && !content.includes('✅') && !content.includes('❌'));

                        if (content.trim() && !isGenericResponse) {
                            // Only show if it's a real response, not a generic placeholder
                            onMessage('assistant', content);

                            // Add the AI message to history
                            messages.push(response);

                            // If it's a meaningful response, we're done
                            break;
                        } else if (iterationCount === 1 && !hasNativeToolCalls && !hasJSONToolCall) {
                            // First iteration and no tool calls - model isn't using tools when it should
                            // Add a nudge to use tools
                            onMessage('system', '💡 Hint: Use tools to explore the codebase. Try list_files to see what files exist.');

                            // Add a system message encouraging tool use
                            messages.push({
                                role: 'user',
                                content: 'Please use the available tools to explore the codebase and help me with the task. Start by using list_files to see what files exist.'
                            });

                            // Continue to give model another chance
                            continue;
                        } else {
                            // Generic or empty response - check if task is complete
                            const completionCheck = await this.checkTaskCompletion(task);
                            if (completionCheck.complete) {
                                onMessage('system', `✅ ${completionCheck.summary}`);
                                break;
                            }

                            // If we've tried multiple times and still no tool calls, break
                            if (iterationCount >= 3) {
                                onMessage('system', '⚠️ Model is not using tools. Please try rephrasing your request to be more specific.');
                                break;
                            }

                            // Otherwise continue (model might be reasoning)
                            continue;
                        }
                    }
                } catch (error: any) {
                    onMessage('system', `⚠️ Error in iteration ${iterationCount}: ${error.message}`);
                    break;
                }
            }

            if (iterationCount >= maxIterations) {
                onMessage('system', '⏱️ Maximum iterations reached.');
            }

            return; // Successfully completed agent loop
        } catch (error: any) {
            onMessage('system', `⚠️ Error in LangChain orchestration: ${error.message}`);

            // Check for timeout
            if (error.message?.includes('timeout') || Date.now() - startTime > this.maxExecutionTime) {
                onMessage('system', '⏱️ Task execution timed out.');
            }

            throw error;
        }
    }

    /**
     * Convert LangChain tools to Ollama tool format
     */
    private convertToolsToOllamaFormat(): any[] {
        return this.toolAdapter.getAllToolDefinitions().map(def => {
            // Convert Zod schema to JSON Schema for Ollama
            const jsonSchema = this.zodToJsonSchema(def.schema);

            return {
                type: 'function',
                function: {
                    name: def.name,
                    description: def.description,
                    parameters: jsonSchema
                }
            };
        });
    }

    /**
     * Convert Zod schema to JSON Schema format
     */
    private zodToJsonSchema(zodSchema: z.ZodObject<any>): any {
        try {
            // Try to use Zod's built-in JSON schema conversion if available
            // Otherwise, manually extract schema information
            const shape = zodSchema.shape;
            const properties: any = {};
            const required: string[] = [];

            for (const [key, value] of Object.entries(shape)) {
                const zodType = value as any;
                const field = this.zodTypeToJsonSchema(zodType);
                properties[key] = field;

                // Check if field is optional - check _def for typeName
                const def = zodType._def || {};
                const typeName = def.typeName || '';

                if (!typeName.includes('Optional') && !typeName.includes('ZodDefault')) {
                    required.push(key);
                }
            }

            return {
                type: 'object',
                properties,
                ...(required.length > 0 && { required })
            };
        } catch (error) {
            // Fallback: return a simple object schema
            console.warn('Error converting Zod schema to JSON Schema:', error);
            return {
                type: 'object',
                properties: {}
            };
        }
    }

    /**
     * Convert a Zod type to JSON Schema type
     */
    private zodTypeToJsonSchema(zodType: any): any {
        try {
            const def = zodType._def || {};
            const typeName = def.typeName || '';

            // Handle ZodString
            if (typeName === 'ZodString') {
                const schema: any = { type: 'string' };
                if (def.description) {
                    schema.description = def.description;
                }
                return schema;
            }

            // Handle ZodNumber
            if (typeName === 'ZodNumber') {
                const schema: any = { type: 'number' };
                if (def.description) {
                    schema.description = def.description;
                }
                return schema;
            }

            // Handle ZodBoolean
            if (typeName === 'ZodBoolean') {
                const schema: any = { type: 'boolean' };
                if (def.description) {
                    schema.description = def.description;
                }
                return schema;
            }

            // Handle ZodArray
            if (typeName === 'ZodArray') {
                const innerType = def.type;
                return {
                    type: 'array',
                    items: innerType ? this.zodTypeToJsonSchema(innerType) : { type: 'string' }
                };
            }

            // Handle ZodOptional
            if (typeName === 'ZodOptional') {
                const innerType = def.innerType;
                return innerType ? this.zodTypeToJsonSchema(innerType) : { type: 'string' };
            }

            // Handle ZodObject (nested)
            if (typeName === 'ZodObject') {
                return this.zodToJsonSchema(zodType as z.ZodObject<any>);
            }

            // Default to string
            return { type: 'string' };
        } catch (error) {
            console.warn('Error converting Zod type to JSON Schema:', error);
            return { type: 'string' };
        }
    }

    /**
     * Call Ollama API with native tool calling support
     */
    private async callOllamaWithTools(
        messages: any[],
        model: string,
        ollamaUrl: string,
        tools: any[]
    ): Promise<any> {
        const axios = require('axios');

        try {
            // Log what we're sending (for debugging)
            console.log(`Calling Ollama with ${tools.length} tools, ${messages.length} messages`);

            const response = await axios.post(
                `${ollamaUrl}/api/chat`,
                {
                    model,
                    messages,
                    tools,
                    stream: false,
                    options: {
                        temperature: 0.2,
                        top_p: 0.9,
                    }
                },
                {
                    timeout: 300000, // 5 minutes
                    validateStatus: (status: number) => status < 500
                }
            );

            if (response.data.error) {
                throw new Error(response.data.error);
            }

            if (!response.data.message) {
                throw new Error('Invalid response from Ollama API: missing message');
            }

            // Check if tool_calls exists (some models might not support it)
            if (!response.data.message.tool_calls && tools.length > 0) {
                console.warn('Model response does not contain tool_calls. The model might not support tool calling.');
            }

            return response.data;
        } catch (error: any) {
            if (error.response?.status === 404) {
                throw new Error(`Ollama API not found at ${ollamaUrl}. Make sure Ollama is running.`);
            } else if (error.code === 'ECONNREFUSED') {
                throw new Error(`Cannot connect to Ollama at ${ollamaUrl}. Make sure Ollama is running (try: ollama serve).`);
            } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
                throw new Error(`Cannot resolve host for ${ollamaUrl}. Check your Ollama URL.`);
            } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
                throw new Error(`Connection to Ollama timed out. The model may be too large or slow.`);
            }

            // Log the full error for debugging
            console.error('Ollama API error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Execute a LangChain tool call (from response.tool_calls)
     * Returns content string for ToolMessage
     */
    private async executeLangChainToolCall(
        toolCall: any,
        onProgress: (message: string) => void,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void,
        onMessage: (role: string, content: string) => void
    ): Promise<{ content: string }> {
        // LangChain tool calls have format: { name: string, args: object, id: string }
        const toolName = toolCall.name;
        const toolArgs = toolCall.args || {};

        if (!toolName) {
            throw new Error('Tool call missing name');
        }

        onProgress(`🔧 Executing: ${toolName}...`);

        // Convert to ToolCall format for execution
        const mcpToolCall: ToolCall = {
            name: toolName,
            arguments: toolArgs
        };

        try {
            // Execute the tool via MCPTools
            const result = await this.mcpTools.executeTool(mcpToolCall);

            const toolResult: ToolResult = {
                success: result.success,
                content: result.content || '',
                error: result.error
            };

            onToolExecution(mcpToolCall, toolResult);
            onProgress(`✅ Completed: ${toolName}`);

            // Update state tracking
            this.updateState(mcpToolCall, toolResult);

            // Show result to user with intelligent guidance
            if (result.success) {
                onMessage('system', `✅ ${toolName} executed successfully`);
            } else {
                onMessage('system', `❌ ${toolName} failed: ${result.error || 'Unknown error'}`);
            }

            // Return content for ToolMessage (LangChain format)
            return {
                content: result.success
                    ? (result.content || 'Success')
                    : `Error: ${result.error || 'Unknown error'}`
            };
        } catch (error: any) {
            const toolResult: ToolResult = {
                success: false,
                content: '',
                error: error.message || 'Tool execution failed'
            };
            onToolExecution(mcpToolCall, toolResult);
            onProgress(`❌ Failed: ${toolName}`);
            onMessage('system', `❌ ${toolName} error: ${error.message}`);

            return {
                content: `Error: ${error.message || 'Tool execution failed'}`
            };
        }
    }

    /**
     * Execute an Ollama tool call (from structured tool_calls response) - DEPRECATED
     * Use executeLangChainToolCall instead
     */
    private async executeOllamaToolCall(
        toolCall: any,
        onProgress: (message: string) => void,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void,
        onMessage: (role: string, content: string) => void
    ): Promise<{ tool_name: string; content: string }> {
        // Convert Ollama format to LangChain format and call executeLangChainToolCall
        const langchainToolCall = {
            name: toolCall.function?.name || toolCall.name,
            args: toolCall.function?.arguments || toolCall.arguments || {},
            id: toolCall.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };

        const result = await this.executeLangChainToolCall(
            langchainToolCall,
            onProgress,
            onToolExecution,
            onMessage
        );

        return {
            tool_name: langchainToolCall.name,
            content: result.content
        };
    }

    /**
     * Parse JSON tool call from text output with position information
     */
    private parseJSONToolCallWithPosition(content: string): { toolCall: { name: string; arguments: any } | null; start: number; end: number } | null {
        const jsonStart = content.indexOf('{');
        if (jsonStart === -1) return null;

        // Find complete JSON by counting braces
        let braceCount = 0;
        let inString = false;
        let escapeNext = false;
        let jsonEnd = -1;

        for (let i = jsonStart; i < content.length; i++) {
            const char = content[i];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }

        if (jsonEnd === -1) return null; // Not complete yet

        try {
            const jsonStr = content.substring(jsonStart, jsonEnd);
            const parsed = JSON.parse(jsonStr);
            if (parsed.name && parsed.arguments && typeof parsed.name === 'string') {
                return {
                    toolCall: {
                        name: parsed.name,
                        arguments: parsed.arguments
                    },
                    start: jsonStart,
                    end: jsonEnd
                };
            }
        } catch (e) {
            // Not valid JSON yet
        }

        return null;
    }

    /**
     * Parse JSON tool call from text output
     * Returns the tool call object if found, null otherwise
     */
    private parseJSONToolCall(content: string): { name: string; arguments: any } | null {
        // Look for JSON tool call pattern: { "name": "...", "arguments": {...} }
        // Need to handle nested JSON in arguments
        const jsonStart = content.indexOf('{');
        if (jsonStart === -1) return null;

        // Try to find a complete JSON object by counting braces
        let braceCount = 0;
        let inString = false;
        let escapeNext = false;
        let jsonEnd = -1;

        for (let i = jsonStart; i < content.length; i++) {
            const char = content[i];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }

        if (jsonEnd === -1) return null; // Not complete yet

        try {
            const jsonStr = content.substring(jsonStart, jsonEnd);
            const parsed = JSON.parse(jsonStr);
            if (parsed.name && parsed.arguments && typeof parsed.name === 'string') {
                return {
                    name: parsed.name,
                    arguments: parsed.arguments
                };
            }
        } catch (e) {
            // Not valid JSON yet, keep accumulating
        }

        return null;
    }

    /**
     * Filter out JSON tool calls from content to show only natural language
     */
    private filterToolCallJSON(content: string): string {
        // Remove JSON tool call patterns - handle nested JSON in arguments
        // First try to find and remove complete JSON objects
        const jsonMatch = this.parseJSONToolCallWithPosition(content);
        if (jsonMatch && jsonMatch.toolCall) {
            // Remove the JSON from the content
            const before = content.substring(0, jsonMatch.start).trim();
            const after = content.substring(jsonMatch.end).trim();
            // Combine, removing any extra whitespace/newlines
            return (before + ' ' + after).replace(/\s+/g, ' ').trim();
        }

        // Fallback: simple regex (may not handle nested JSON well)
        return content.replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[^}]*\}\s*\}/g, '').trim();
    }

    /**
     * Execute a parsed tool call with validation and guidance
     */
    private async executeParsedToolCall(
        toolCall: { name: string; arguments: any },
        onProgress: (message: string) => void,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void,
        onMessage: (role: string, content: string) => void
    ): Promise<ToolResult | null> {
        // Validate tool usage - guide away from inappropriate commands
        // (rest of method continues below)
        if (toolCall.name === 'run_command' && toolCall.arguments?.command) {
            const command = toolCall.arguments.command.toLowerCase().trim();
            // Block inappropriate commands for code editing tasks
            const inappropriateCommands = ['echo', 'cat', 'print', 'console.log'];
            const isInappropriate = inappropriateCommands.some(cmd =>
                command === cmd || command.startsWith(cmd + ' ') || command.startsWith(cmd + '$')
            );

            // Allow legitimate commands
            const allowedCommands = ['install', 'test', 'run', 'build', 'compile', 'npm', 'pip', 'python', 'node', 'uvicorn', 'fastapi'];
            const isAllowed = allowedCommands.some(cmd => command.includes(cmd));

            if (isInappropriate && !isAllowed) {
                const errorMsg = `❌ Blocked inappropriate command: "${toolCall.arguments.command}"

For code editing tasks like "add an endpoint", you should NOT run random commands.
Instead, follow this workflow:

1. PLAN: First explain what you'll do
2. DISCOVER: Use list_files or search_files to find the FastAPI files
3. READ: Use read_file to read the main.py or app.py file
4. EDIT: Use insert_code or replace_code to add the endpoint
5. VERIFY: Use validate_syntax to check your changes

Use run_command ONLY for:
- Installing dependencies (pip install, npm install)
- Running tests or servers (uvicorn, npm test)
- Build commands

Now, please start over: Find the FastAPI file, read it, then add the endpoint.`;

                onMessage('system', errorMsg);
                const errorResult: ToolResult = { success: false, content: '', error: errorMsg };
                onToolExecution(
                    { name: toolCall.name, arguments: toolCall.arguments },
                    errorResult
                );
                return errorResult;
            }
        }

        onProgress(`🔧 Executing: ${toolCall.name}...`);

        // Convert to ToolCall format
        const mcpToolCall: ToolCall = {
            name: toolCall.name,
            arguments: toolCall.arguments
        };

        try {
            // Execute the tool via MCPTools
            const result = await this.mcpTools.executeTool(mcpToolCall);

            // Large tool result eviction (Deep Agents feature)
            // If result is too large, write it to a file and return a reference
            let finalContent = result.content || '';
            let wasEvicted = false;

            if (result.success && finalContent.length > this.LARGE_RESULT_THRESHOLD) {
                // Result is too large - evict it to a file
                const cacheKey = `tool_result_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const evictionFilePath = `.easycode_cache/${cacheKey}.txt`;

                try {
                    // Write large result to cache file
                    const fs = require('fs');
                    const vscode = require('vscode');
                    // Get workspace root
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || process.cwd();
                    const cacheDir = path.join(workspaceRoot, '.easycode_cache');
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }
                    const fullPath = path.join(cacheDir, `${cacheKey}.txt`);
                    fs.writeFileSync(fullPath, finalContent, 'utf-8');

                    // Store reference in cache
                    this.toolResultCache.set(cacheKey, fullPath);

                    // Replace content with concise reference
                    const originalLength = finalContent.length;
                    finalContent = `[Large result evicted to file: ${evictionFilePath}]\n\nResult preview (first 1000 chars):\n${finalContent.substring(0, 1000)}...\n\nTo read the full result, use: read_file("${evictionFilePath}")`;
                    wasEvicted = true;
                    onMessage('system', `💾 Large tool result (${Math.round(originalLength / 1000)}k chars) evicted to ${evictionFilePath} to save context space.`);
                } catch (evictionError: any) {
                    // If eviction fails, continue with full content
                    console.warn('Failed to evict large tool result:', evictionError);
                }
            }

            const toolResult: ToolResult = {
                success: result.success,
                content: finalContent,
                error: result.error
            };

            onToolExecution(mcpToolCall, toolResult);
            onProgress(`✅ Completed: ${toolCall.name}${wasEvicted ? ' (large result evicted)' : ''}`);

            // Update state tracking (before checking results)
            this.updateState(mcpToolCall, toolResult);

            // Track conversation for context
            this.conversationHistory.push({
                role: 'tool',
                content: `${toolCall.name}(${JSON.stringify(toolCall.arguments).substring(0, 100)}) -> ${result.success ? 'success' : 'error'}`,
                timestamp: new Date()
            });

            // Keep conversation history manageable (last 50 entries)
            if (this.conversationHistory.length > 50) {
                this.conversationHistory = this.conversationHistory.slice(-50);
            }

            // Check for loops
            if (this.detectLoop()) {
                onMessage('system', '⚠️ Detected potential loop in actions. Consider a different approach or check if the task is already complete.');
            }

            // Show result to user with intelligent guidance
            if (result.success) {
                // Natural, conversational feedback (like Cursor/Copilot)
                if (toolCall.name === 'analyze_code' && result.content) {
                    const filePath = toolCall.arguments.file_path;
                    onMessage('system', `✅ Analyzed ${filePath}`);
                    // If duplicates detected, the analyze_code tool already includes this in its output
                } else if (toolCall.name === 'read_file') {
                    const filePath = toolCall.arguments.file_path;
                    onMessage('system', `✅ Read ${filePath}`);
                } else if (toolCall.name === 'list_files') {
                    onMessage('system', '✅ Files listed');
                } else if (['insert_code', 'replace_code', 'search_replace', 'write_file'].includes(toolCall.name)) {
                    const filePath = toolCall.arguments.file_path;
                    onMessage('system', `✅ Updated ${filePath}`);
                } else if (toolCall.name === 'run_command') {
                    onMessage('system', `✅ Command executed`);
                } else {
                    onMessage('system', `✅ ${toolCall.name} completed`);
                }
            } else {
                onMessage('system', `❌ ${toolCall.name} failed: ${result.error || 'Unknown error'}`);

                // Provide helpful error recovery guidance (like Cursor does)
                const errorMsg = result.error || '';
                if (errorMsg.includes('not found') || errorMsg.includes('does not exist') || errorMsg.includes('ENOENT')) {
                    onMessage('system', '💡 File not found. Use list_files or search_files to find the correct file path.');
                } else if (errorMsg.includes('syntax') || errorMsg.includes('invalid') || errorMsg.includes('SyntaxError')) {
                    onMessage('system', '💡 Syntax error detected. Review the code and fix the issue, or use validate_syntax to check specific files.');
                } else if (errorMsg.includes('permission') || errorMsg.includes('EACCES')) {
                    onMessage('system', '💡 Permission denied. Check file permissions or try a different file.');
                } else if (errorMsg.includes('already exists') || errorMsg.includes('EEXIST')) {
                    onMessage('system', '💡 File already exists. Consider reading it first, then modifying it if needed.');
                }
            }

            // Return the result
            return toolResult;
        } catch (error: any) {
            const toolResult: ToolResult = {
                success: false,
                content: '',
                error: error.message || 'Tool execution failed'
            };
            onToolExecution(mcpToolCall, toolResult);
            onProgress(`❌ Failed: ${toolCall.name}`);
            onMessage('system', `❌ ${toolCall.name} error: ${error.message}`);
            return toolResult;
        }
    }

    /**
     * Get workspace state summary for context
     */
    private getWorkspaceStateSummary(): string {
        const parts: string[] = [];

        if (this.codebaseState.filesRead.size > 0) {
            parts.push(`Files recently read: ${Array.from(this.codebaseState.filesRead).slice(-5).join(', ')}`);
        }

        if (this.codebaseState.filesModified.size > 0) {
            parts.push(`Files recently modified: ${Array.from(this.codebaseState.filesModified).slice(-5).join(', ')}`);
        }

        if (this.codebaseState.errors.length > 0) {
            parts.push(`Recent errors: ${this.codebaseState.errors.slice(-3).join('; ')}`);
        }

        if (this.fileChanges.length > 0) {
            const recentChanges = this.fileChanges.slice(-3);
            parts.push(`Recent changes: ${recentChanges.map(c => `${c.path} (${c.type})`).join(', ')}`);
        }

        return parts.length > 0 ? parts.join('\n') : 'No recent activity.';
    }

    /**
     * Update codebase state after tool execution
     */
    private updateState(toolCall: ToolCall, result: ToolResult): void {
        // Track file operations
        if (toolCall.name === 'read_file' && toolCall.arguments.file_path) {
            this.codebaseState.filesRead.add(toolCall.arguments.file_path);
        }

        if (['write_file', 'insert_code', 'replace_code', 'search_replace'].includes(toolCall.name) && toolCall.arguments.file_path) {
            this.codebaseState.filesModified.add(toolCall.arguments.file_path);

            // Track file changes
            const change: FileChange = {
                path: toolCall.arguments.file_path,
                type: 'modified',
                timestamp: new Date(),
            };
            this.fileChanges.push(change);

            // Keep only recent changes (last 20)
            if (this.fileChanges.length > 20) {
                this.fileChanges = this.fileChanges.slice(-20);
            }
        }

        // Track errors
        if (!result.success && result.error) {
            this.codebaseState.errors.push(result.error);
            // Keep only recent errors (last 10)
            if (this.codebaseState.errors.length > 10) {
                this.codebaseState.errors = this.codebaseState.errors.slice(-10);
            }
        }

        // Track actions for loop detection
        const actionKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments).substring(0, 100)}`;
        this.recentActions.push({
            action: actionKey,
            timestamp: Date.now()
        });

        // Keep only recent actions (last 20)
        if (this.recentActions.length > 20) {
            this.recentActions = this.recentActions.slice(-20);
        }
    }

    /**
     * Get a normalized action key for loop detection
     */
    private getActionKey(action: string): string {
        // Normalize action strings for comparison
        // Extract tool name from action string (e.g., "read_file(file_path: ...)" -> "read_file")
        const match = action.match(/^([a-z_]+)/);
        return match ? match[1] : action;
    }

    /**
     * Detect if agent is stuck in a loop
     */
    private detectLoop(): boolean {
        // More lenient loop detection - allow exploration
        if (this.recentActions.length < 5) return false;

        const lastActions = this.recentActions.slice(-5);
        const actionKeys = lastActions.map(a => this.getActionKey(a.action));

        // Check for immediate repetition (same action 4+ times in a row)
        const uniqueActions = new Set(actionKeys.slice(-4));
        if (uniqueActions.size === 1) {
            // Same action 4+ times in a row - likely a loop
            return true;
        }

        // Check for A->B->A->B pattern (oscillating between two actions)
        if (actionKeys.length >= 4) {
            const pattern = actionKeys.slice(-4);
            if (pattern[0] === pattern[2] && pattern[1] === pattern[3] && pattern[0] !== pattern[1]) {
                return true;
            }
        }

        // Allow list_files and read_file to repeat a few times during exploration
        // But if we're doing the same read_file multiple times without making changes, that's a loop
        const readFileCount = actionKeys.filter(k => k === 'read_file').length;
        if (readFileCount >= 3 && this.codebaseState.filesModified.size === 0 && actionKeys.length >= 4) {
            // Reading files multiple times without making changes - likely stuck
            return true;
        }

        // Check for A->B->A pattern (simpler oscillation)
        if (actionKeys.length >= 3) {
            const [a, b, c] = actionKeys.slice(-3);
            if (a === c && a !== b) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if task appears to be complete (like Cursor does)
     */
    private async checkTaskCompletion(task: string): Promise<{ complete: boolean; summary: string }> {
        const taskLower = task.toLowerCase();

        // For "remove" or "fix" tasks, we need to ensure the file was actually modified
        if (taskLower.includes('remove') || taskLower.includes('delete') || taskLower.includes('fix') || taskLower.includes('duplicate')) {
            // Don't mark as complete unless we've actually modified files
            if (this.codebaseState.filesModified.size === 0) {
                return { complete: false, summary: 'Task not complete: No files modified yet. Please make the requested changes immediately.' };
            }
            // If we modified files, check if we're done
            if (this.codebaseState.filesModified.size > 0 && this.codebaseState.errors.length === 0) {
                return {
                    complete: true,
                    summary: `Task appears complete: ${this.codebaseState.filesModified.size} file(s) modified successfully.`
                };
            }
        }

        // Check for common completion indicators
        if (taskLower.includes('add') || taskLower.includes('create')) {
            // For "add endpoint" or "create file" tasks, check if files were modified
            if (this.codebaseState.filesModified.size > 0) {
                return {
                    complete: true,
                    summary: `Task appears complete: ${this.codebaseState.filesModified.size} file(s) modified.`
                };
            }
        }

        // Check if we've made meaningful progress
        if (this.codebaseState.filesModified.size > 0 && this.codebaseState.errors.length === 0) {
            return {
                complete: true,
                summary: `Task appears complete: Changes made successfully with no errors.`
            };
        }

        return { complete: false, summary: '' };
    }

    /**
     * Estimate token count (rough approximation: 1 token ≈ 4 characters)
     */
    private estimateTokens(text: string): number {
        // Rough approximation: 1 token ≈ 4 characters
        return Math.ceil(text.length / 4);
    }

    /**
     * Summarize old conversation history (Deep Agents feature)
     * Keeps recent messages intact, summarizes older ones
     */
    private async summarizeConversationHistory(
        messages: any[],
        onMessage: (role: string, content: string) => void
    ): Promise<void> {
        if (messages.length <= this.MAX_MESSAGES_BEFORE_SUMMARIZATION) {
            return;
        }

        // Keep the most recent messages intact
        const recentMessages = messages.slice(-this.MESSAGES_TO_KEEP_INTACT);
        const oldMessages = messages.slice(0, messages.length - this.MESSAGES_TO_KEEP_INTACT);

        // Summarize old messages
        // Note: In a production Deep Agents setup, this would call the LLM to create a proper summary
        // For now, we use a simple truncation approach to prevent context window saturation
        try {
            // Extract key information from old messages for a concise summary
            const keyInfo: string[] = [];
            oldMessages.forEach((msg) => {
                const role = msg.getType ? msg.getType() : (msg.role || 'unknown');
                const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

                // Extract tool calls
                if (role === 'ai' && (msg as any).tool_calls) {
                    const toolCalls = (msg as any).tool_calls || [];
                    toolCalls.forEach((tc: any) => {
                        if (tc.name) keyInfo.push(`Tool: ${tc.name}(${JSON.stringify(tc.args || {}).substring(0, 100)})`);
                    });
                }

                // Extract file operations from tool messages
                if (role === 'tool' && content.includes('file')) {
                    const fileMatch = content.match(/(read|write|edit|analyze).*?['"]([^'"]+)['"]/i);
                    if (fileMatch) {
                        keyInfo.push(`File operation: ${fileMatch[1]} ${fileMatch[2]}`);
                    }
                }
            });

            // Create a summary message
            const summaryLines = keyInfo.length > 0
                ? keyInfo.slice(0, 10).join('\n') // Keep top 10 key items
                : `${oldMessages.length} messages from earlier conversation`;
            const summaryContent = `[Previous conversation summarized: ${oldMessages.length} messages compressed]\n\nKey actions from earlier conversation:\n${summaryLines}\n\n[Recent conversation continues below...]`;
            const SystemMessageClass = this.getSystemMessageClass();
            const summaryMessage = new SystemMessageClass(summaryContent);

            // Replace old messages with summary
            messages.splice(0, oldMessages.length, summaryMessage);

            onMessage('system', `💾 Compressed ${oldMessages.length} old messages to save context space.`);
        } catch (error: any) {
            // If summarization fails, just truncate old messages
            console.warn('Failed to summarize conversation history:', error);
            messages.splice(0, oldMessages.length);
        }
    }

    /**
     * Execute a task using a subagent (Deep Agents feature)
     * Subagents work in isolated context and return concise results
     */
    private async executeSubagentTask(subagentName: string, task: string): Promise<string> {
        // Find the subagent
        const subagent = this.subagents.get(subagentName);
        if (!subagent) {
            return `Error: Subagent "${subagentName}" not found. Available subagents: ${Array.from(this.subagents.keys()).join(', ')}`;
        }

        try {
            // Create an isolated orchestrator instance for the subagent
            // This ensures context isolation - the subagent's work doesn't clutter the main agent's context
            const subagentOrchestrator = new LangChainOrchestrator(
                this.mcpTools,
                subagent.model || this.currentModel,
                this.currentUrl
            );

            // Configure subagent with its specific tools if specified
            // For now, we'll use all tools (can be optimized later to filter by subagent.tools)

            // Build system prompt for subagent
            const subagentSystemPrompt = `${subagent.systemPrompt}

IMPORTANT: 
- Work independently and complete the task
- Return a concise summary of your work, not raw data or intermediate results
- Keep your response focused and actionable
- Do NOT include detailed tool outputs or intermediate steps in your final response`;

            // Execute the task in isolated context
            // We'll use a simplified execution that captures the final result
            let finalResult = '';
            let executionError: string | null = null;

            await subagentOrchestrator.orchestrate(
                task,
                subagentSystemPrompt,
                subagent.model || this.currentModel,
                this.currentUrl,
                (progress) => {
                    // Progress updates from subagent (can be logged but not shown to main agent)
                    console.log(`[Subagent ${subagentName}] ${progress}`);
                },
                (toolCall, result) => {
                    // Tool executions from subagent (isolated, not shown to main agent)
                    console.log(`[Subagent ${subagentName}] Tool: ${toolCall.name}`);
                },
                (role, content) => {
                    // Messages from subagent - capture the final assistant message as the result
                    // Note: We overwrite finalResult each time to get the latest message
                    // (The orchestrator uses updateLastAssistantMessage which updates the same message)
                    if (role === 'assistant') {
                        finalResult = content; // Always use the latest assistant message
                    }
                    if (role === 'system' && content.includes('❌')) {
                        executionError = content;
                    }
                }
            );

            // Return concise result to main agent
            if (executionError) {
                return `Subagent "${subagentName}" encountered an error: ${executionError}\n\nTask: ${task}`;
            }

            if (!finalResult || finalResult.trim().length === 0) {
                return `Subagent "${subagentName}" completed the task but returned no result.\n\nTask: ${task}`;
            }

            // Ensure the result is concise (subagents should return summaries, not raw data)
            const maxResultLength = 2000; // Keep subagent results concise
            if (finalResult.length > maxResultLength) {
                return `Subagent "${subagentName}" completed the task. Summary:\n\n${finalResult.substring(0, maxResultLength)}...\n\n[Result truncated - subagent returned ${finalResult.length} characters]`;
            }

            return `Subagent "${subagentName}" completed the task:\n\n${finalResult}`;
        } catch (error: any) {
            return `Error executing subagent "${subagentName}": ${error.message}\n\nTask: ${task}`;
        }
    }

    /**
     * Add a custom subagent (for future extensibility)
     */
    public addSubagent(subagent: SubAgent): void {
        if (subagent.name === this.GENERAL_PURPOSE_SUBAGENT_NAME) {
            throw new Error(`Cannot override the built-in "${this.GENERAL_PURPOSE_SUBAGENT_NAME}" subagent`);
        }
        this.subagents.set(subagent.name, subagent);

        // Update task tool description to include new subagent
        // (In a more sophisticated implementation, we'd dynamically update the tool)
        console.log(`Added subagent: ${subagent.name}`);
    }

    /**
     * Get available subagents
     */
    public getSubagents(): SubAgent[] {
        return Array.from(this.subagents.values());
    }

    /**
     * Reset state for new task
     */
    private resetState(): void {
        this.codebaseState = {
            filesRead: new Set<string>(),
            filesModified: new Set<string>(),
            testsRun: 0,
            testsPassed: 0,
            errors: []
        };
        this.fileChanges = [];
        this.recentActions = [];
        this.toolResultCache.clear();
    }

    /**
     * Cleanup resources
     */
    dispose(): void {
        this.agent = null;
        this.resetState();
    }
}
