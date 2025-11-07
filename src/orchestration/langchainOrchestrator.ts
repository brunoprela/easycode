/**
 * LangChain-based orchestrator
 * Uses LangChain's agent framework for better orchestration
 */

import * as vscode from 'vscode';
import { ChatOllama } from '@langchain/ollama';
import { createAgent, tool } from 'langchain';
import { z } from 'zod';
import { MCPTools } from '../mcpTools';
import { ToolCall, ToolResult, CodebaseState, FileChange } from '../types';
import { MCPToolAdapter } from './mcpToolAdapter';
import { gatherCodeContext } from '../contextGatherer';
import { getAIResponse } from '../ollamaClient';

// Import message classes with require to avoid module resolution issues
let HumanMessage: any;
let AIMessage: any;
let ToolMessage: any;

try {
    const messagesModule = require('@langchain/core/messages');
    HumanMessage = messagesModule.HumanMessage;
    AIMessage = messagesModule.AIMessage;
    ToolMessage = messagesModule.ToolMessage;
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
        constructor(public content: string, public tool_call_id?: string) {
            this.tool_call_id = tool_call_id;
        }
        getType() { return 'tool'; }
        // Add status field to match LangChain's ToolMessage structure
        status?: 'success' | 'error' = 'success';
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
        this.tools = this.toolAdapter.toLangChainTools();
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

        // Enhanced system message with state-of-the-art features
        const enhancedSystemMessage = `${systemMessage}

You are an advanced AI coding assistant (like Cursor or GitHub Copilot) with deep codebase understanding and intelligent task execution.

${workspaceState !== 'No recent activity.' ? `CURRENT WORKSPACE STATE:\n${workspaceState}\n\n` : ''}

${additionalContext ? `CURRENT CONTEXT:\n${additionalContext}\n\n` : ''}

You are an advanced AI coding assistant with deep understanding of software development workflows. Your goal is to help users accomplish coding tasks by intelligently using the available tools.

## REASONING PROCESS (ReAct Pattern)

Think step-by-step about each task:

1. **OBSERVE**: Understand the current state
   - What files exist in the codebase?
   - What is the task asking for?
   - What context do you have?

2. **REASON**: Plan your approach
   - What information do you need?
   - Which files should you examine?
   - What changes need to be made?
   - What's the best way to accomplish this?

3. **ACT**: Execute tools based on your reasoning
   - Use tools to gather information
   - Use tools to make changes
   - Verify your work

4. **REFLECT**: After each tool execution
   - What did you learn?
   - What should you do next?
   - Are you making progress toward the goal?

## AVAILABLE TOOLS

${this.toolAdapter.getToolsDescription()}

## TOOL USAGE GUIDELINES

- **Understanding code**: Use read_file, analyze_code_structure, find_dependencies, get_code_context
- **Finding files**: Use list_files or search_files to explore the codebase
- **Making changes**: 
  - Use read_file FIRST to understand existing code
  - Use insert_code to add new code at a specific line
  - Use replace_code to replace a code block
  - Use search_replace for simple text replacements
  - Use write_file to create new files
- **Validation**: Use validate_syntax to check your changes
- **Testing**: Use run_tests or run_command for testing

## IMPORTANT PRINCIPLES

1. **Understand before modifying**: Always read files before editing them
2. **Make incremental changes**: Small, focused edits are better than large rewrites
3. **Verify your work**: Check syntax and test when appropriate
4. **Learn from results**: Use tool outputs to inform your next steps
5. **Think about the user's intent**: Understand what they're trying to accomplish, not just what they asked for

## TOOL USAGE

You have access to tools that can be called automatically. When you need to use a tool, call it naturally. The system will execute the tool and provide you with the result. You MUST then:
1. Read and understand the tool result
2. Decide what to do next based on the result
3. Execute the next tool or complete the task
4. DO NOT stop after one tool - keep going until the task is done

Example workflow:
- Tool 1: list_files -> See files listed
- Tool 2: read_file -> See file content  
- Tool 3: insert_code -> Modify file
- Tool 4: read_file -> Read another file if needed
- Continue until task complete

CRITICAL: Never stop after just one tool execution. Always continue until the task is complete. After each tool execution, immediately decide on the next step and execute it.
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
   - What information do you need?
   - Which files should you examine?
   - What changes need to be made?
   - What's the best way to accomplish this?

3. **ACT**: Execute tools based on your reasoning
   - Use tools to gather information
   - Use tools to make changes
   - Verify your work

4. **REFLECT**: After each tool execution
   - What did you learn?
   - What should you do next?
   - Are you making progress toward the goal?

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
                    temperature: 0.7,
                });
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

            // Use Ollama's native tool calling API for proper agent loop
            // This uses structured tool_calls instead of JSON parsing

            const systemPrompt = this.buildSystemPrompt(systemMessage, codeContext || undefined);

            // Convert LangChain tools to Ollama tool format
            const ollamaTools = this.convertToolsToOllamaFormat();

            // Build message history for agent loop
            const messages: any[] = [];

            // Initial user message with task
            messages.push({ role: 'user', content: task });

            // Main agent loop using Ollama's native tool calling
            let iterationCount = 0;
            const maxIterations = 50;

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
                    // Prepare messages for Ollama API
                    const ollamaMessages: any[] = [
                        { role: 'system', content: systemPrompt },
                        ...messages
                    ];

                    // Call Ollama API with native tool calling support
                    const response = await this.callOllamaWithTools(
                        ollamaMessages,
                        model,
                        ollamaUrl,
                        ollamaTools
                    );

                    // Handle response
                    if (response.message.content) {
                        onMessage('assistant', response.message.content);
                    }

                    // Add assistant message to history
                    const assistantMessage: any = {
                        role: 'assistant',
                        content: response.message.content || ''
                    };

                    // Handle tool calls if present
                    if (response.message.tool_calls && response.message.tool_calls.length > 0) {
                        assistantMessage.tool_calls = response.message.tool_calls;

                        // Execute all tool calls in parallel
                        const toolResults: any[] = [];
                        for (const toolCall of response.message.tool_calls) {
                            const toolResult = await this.executeOllamaToolCall(
                                toolCall,
                                onProgress,
                                onToolExecution,
                                onMessage
                            );
                            toolResults.push(toolResult);
                        }

                        // Add assistant message with tool calls
                        messages.push(assistantMessage);

                        // Add tool results to messages
                        for (const toolResult of toolResults) {
                            messages.push({
                                role: 'tool',
                                tool_name: toolResult.tool_name,
                                content: toolResult.content
                            });
                        }

                        // Continue loop - model will see tool results and continue
                        continue;
                    } else {
                        // No tool calls - add assistant message and check if done
                        messages.push(assistantMessage);

                        // Check if task is complete
                        const completionCheck = await this.checkTaskCompletion(task);
                        if (completionCheck.complete) {
                            onMessage('system', `✅ ${completionCheck.summary}`);
                            break;
                        }

                        // If model says it's done, stop
                        if (response.message.content && (
                            response.message.content.toLowerCase().includes('complete') ||
                            response.message.content.toLowerCase().includes('done') ||
                            response.message.content.toLowerCase().includes('finished')
                        )) {
                            onMessage('system', '✅ Model indicates task is complete.');
                            break;
                        }

                        // Otherwise continue (model might be reasoning)
                        continue;
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
            throw error;
        }
    }

    /**
     * Execute an Ollama tool call (from structured tool_calls response)
     */
    private async executeOllamaToolCall(
        toolCall: any,
        onProgress: (message: string) => void,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void,
        onMessage: (role: string, content: string) => void
    ): Promise<{ tool_name: string; content: string }> {
        const toolName = toolCall.function?.name || toolCall.name;
        const toolArgs = toolCall.function?.arguments || toolCall.arguments || {};

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

            // Return result in Ollama format
            return {
                tool_name: toolName,
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
                tool_name: toolName,
                content: `Error: ${error.message || 'Tool execution failed'}`
            };
        }
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
        // Remove JSON tool call patterns
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

            const toolResult: ToolResult = {
                success: result.success,
                content: result.content || '',
                error: result.error
            };

            onToolExecution(mcpToolCall, toolResult);
            onProgress(`✅ Completed: ${toolCall.name}`);

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
                // Intelligent guidance based on action type and state
                if (toolCall.name === 'read_file' && result.content) {
                    // Provide guidance based on file reading
                    const filePath = toolCall.arguments.file_path;
                    if (this.codebaseState.filesRead.has(filePath)) {
                        onMessage('system', `✅ File read: ${filePath} (already read previously)`);
                    } else {
                        onMessage('system', `✅ File read: ${filePath}`);
                    }
                    onMessage('system', '💡 File content retrieved. Analyze it and use the appropriate editing tools to make changes.');
                } else if (toolCall.name === 'list_files') {
                    onMessage('system', '✅ Files listed successfully');
                    onMessage('system', '💡 Files listed. Consider reading relevant files to understand the codebase structure.');
                } else if (['insert_code', 'replace_code', 'search_replace'].includes(toolCall.name)) {
                    const filePath = toolCall.arguments.file_path;
                    onMessage('system', `✅ File modified: ${filePath}`);
                    onMessage('system', '💡 File modified. Consider using validate_syntax to verify the changes are valid.');
                } else if (toolCall.name === 'run_command') {
                    onMessage('system', `✅ Command executed: ${toolCall.arguments.command.substring(0, 50)}...`);
                } else {
                    onMessage('system', `✅ ${toolCall.name} executed successfully`);
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
     * Detect if agent is stuck in a loop
     */
    private detectLoop(): boolean {
        if (this.recentActions.length < 3) return false;

        // Check for repeated actions
        const lastActions = this.recentActions.slice(-5).map(a => a.action);
        const uniqueActions = new Set(lastActions);

        // If we have very few unique actions, might be looping
        if (uniqueActions.size <= 2 && lastActions.length >= 5) {
            return true;
        }

        // Check for A->B->A pattern
        if (lastActions.length >= 3) {
            const [a, b, c] = lastActions.slice(-3);
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
    }

    /**
     * Cleanup resources
     */
    dispose(): void {
        this.agent = null;
        this.resetState();
    }
}
