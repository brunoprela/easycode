import * as vscode from 'vscode';
import { MCPTools } from '../mcpTools';
import { ToolCall, ToolResult, ExecutionPlan, PlanStep, ExecutionState, ToolExecution, FileChange } from '../types';

// Extended interfaces specific to AdvancedOrchestrator
export interface ExtendedExecutionState extends ExecutionState {
    conversationHistory: any[];
    context: Map<string, any>;
}

export interface ExtendedPlanStep extends PlanStep {
    id: string;
    retryCount: number;
    maxRetries: number;
}

export interface ExtendedToolExecution extends ToolExecution {
    id: string;
    timestamp: Date;
}

export interface ExtendedFileChange extends FileChange {
    operation: 'create' | 'modify' | 'delete';
    before: string | null;
    after: string | null;
    timestamp: Date;
}

export class AdvancedOrchestrator {
    private mcpTools: MCPTools;
    private state: ExecutionState;
    private maxIterations: number = 20;
    private reflectionThreshold: number = 3; // Reflect after N failures

    constructor(mcpTools: MCPTools) {
        this.mcpTools = mcpTools;
        this.state = {
            plan: null,
            currentStep: 0,
            toolHistory: [],
            fileChanges: [],
            errors: [],
            conversationHistory: [],
            context: new Map()
        } as ExtendedExecutionState;
    }

    /**
     * Main orchestration method - coordinates planning, execution, and reflection
     */
    async orchestrate(
        userMessage: string,
        systemMessage: string,
        model: string,
        ollamaUrl: string,
        onProgress: (message: string) => void,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void,
        onMessage: (role: string, content: string) => void
    ): Promise<void> {
        const messages: any[] = [
            { role: 'system', content: this.buildEnhancedSystemMessage(systemMessage) },
            { role: 'user', content: userMessage }
        ];

        let iteration = 0;
        let consecutiveFailures = 0;

        while (iteration < this.maxIterations) {
            iteration++;
            const status = this.state.plan ? 'executing' : 'planning';
            onProgress(`Iteration ${iteration}/${this.maxIterations} - ${status}`);

            try {
                // Get AI response first
                const response = await this.getAIResponse(messages, model, ollamaUrl);
                messages.push({ role: 'assistant', content: response });

                // Parse and execute tools from response
                const toolCalls = this.mcpTools.parseToolCalls(response);

                if (toolCalls.length > 0) {
                    // Tools found - execute them directly (skip planning for direct tool usage)
                    const results = await this.executeToolsParallel(toolCalls, onProgress, onToolExecution);

                    // Add results to conversation
                    const toolResultsText = this.formatToolResults(toolCalls, results);
                    messages.push({
                        role: 'user',
                        content: `Tool execution results:\n${toolResultsText}\n\nContinue with the task. If more steps are needed, use tools to complete them.`
                    });

                    onMessage('system', `🔧 Executed ${toolCalls.length} tool(s)`);
                    consecutiveFailures = 0; // Reset on successful tool execution
                } else {
                    // No tools - check if we need planning or if task is complete
                    const hasActionKeywords = /(?:create|make|write|add|run|execute|install|build|start|implement|refactor)/i.test(response);

                    if (hasActionKeywords && !this.state.plan) {
                        // Task requires action but no plan - create one
                        await this.planningPhase(messages, model, ollamaUrl, onMessage);
                    } else if (this.state.plan) {
                        // Execute planned steps
                        const executed = await this.executionPhase(model, ollamaUrl, onProgress, onToolExecution, onMessage);

                        if (executed) {
                            consecutiveFailures = 0;
                        } else {
                            consecutiveFailures++;
                        }
                    } else {
                        // No tools and no plan - check completion
                        const completionCheck = await this.checkTaskCompletion(response, messages, model, ollamaUrl);
                        if (completionCheck.complete) {
                            onMessage('assistant', response);
                            break;
                        } else {
                            // Task not complete but no tools - prompt for action
                            messages.push({
                                role: 'user',
                                content: 'Please use the available tools to actually perform the actions. Don\'t just describe - execute using tools.'
                            });
                        }
                    }
                }

                // Reflection phase (after failures)
                if (consecutiveFailures >= this.reflectionThreshold) {
                    await this.reflectionPhase(messages, model, ollamaUrl, onMessage);
                    consecutiveFailures = 0; // Reset after reflection
                }

            } catch (error: any) {
                this.state.errors.push(error);
                consecutiveFailures++;

                if (consecutiveFailures >= this.reflectionThreshold) {
                    await this.reflectionPhase(messages, model, ollamaUrl, onMessage);
                }

                onMessage('system', `⚠️ Error: ${error.message}`);
            }
        }

        // Final summary
        if (this.state.fileChanges.length > 0) {
            const summary = this.generateExecutionSummary();
            onMessage('system', summary);
        }
    }

    /**
     * Planning phase - AI creates an execution plan
     */
    private async planningPhase(
        messages: any[],
        model: string,
        ollamaUrl: string,
        onMessage: (role: string, content: string) => void
    ): Promise<void> {
        const planningPrompt = `Analyze the task and create a detailed execution plan. Break it down into specific steps with tool calls.

Format your plan as:
PLAN:
1. Step description - tool_name(args)
2. Step description - tool_name(args)
...

Consider:
- Dependencies between steps
- Error handling
- Validation steps
- File operations needed

Current context:
${this.getContextSummary()}

Tool history (last 5):
${this.getRecentToolHistory(5)}`;

        messages.push({ role: 'user', content: planningPrompt });
        const planResponse = await this.getAIResponse(messages, model, ollamaUrl);
        messages.push({ role: 'assistant', content: planResponse });

        // Parse plan from response
        this.state.plan = this.parsePlan(planResponse);
        onMessage('system', `📋 Created execution plan with ${this.state.plan.steps.length} steps`);
    }

    /**
     * Execution phase - execute planned steps
     */
    private async executionPhase(
        model: string,
        ollamaUrl: string,
        onProgress: (message: string) => void,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void,
        onMessage: (role: string, content: string) => void
    ): Promise<boolean> {
        if (!this.state.plan) return false;

        const step = this.state.plan.steps[this.state.currentStep];
        if (!step) {
            return true; // All steps completed
        }

        // Check dependencies
        if (step.dependencies && step.dependencies.length > 0) {
            // Convert to array of strings for consistent handling
            const depsArray = step.dependencies.map(d => String(d));
            const depsMet = depsArray.every((depId: string) => {
                const depStep = this.state.plan!.steps.find((s: PlanStep) => s.id === depId);
                return depStep && (depStep.retryCount ?? 0) > 0;
            });

            if (!depsMet) {
                const depStr = step.dependencies.map(d => String(d)).join(', ');
                onProgress(`Waiting for dependencies: ${depStr}`);
                return false;
            }
        }

        // Execute step
        onProgress(`Executing: ${step.description}`);
        const result = await this.executeToolWithRetry(step, onToolExecution);

        if (result.success) {
            step.retryCount = (step.retryCount ?? 0) + 1;
            this.state.currentStep++;
            return true;
        } else {
            step.retryCount = (step.retryCount ?? 0) + 1;
            const maxRetries = step.maxRetries ?? 3;
            if (step.retryCount >= maxRetries) {
                onMessage('system', `❌ Step failed after ${maxRetries} retries: ${step.description}`);
                return false;
            }
            return false;
        }
    }

    /**
     * Reflection phase - AI reflects on progress and adjusts
     */
    private async reflectionPhase(
        messages: any[],
        model: string,
        ollamaUrl: string,
        onMessage: (role: string, content: string) => void
    ): Promise<void> {
        const reflectionPrompt = `Reflect on the execution so far:

Errors encountered:
${this.state.errors.slice(-5).map((e: any) => `- ${e.message}`).join('\n')}

Recent tool executions:
${this.getRecentToolHistory(10)}

File changes made:
${this.state.fileChanges.slice(-10).map((fc: FileChange) =>
            `- ${fc.operation}: ${fc.path}`
        ).join('\n')}

Current plan status: ${this.state.plan ? 'executing' : 'none'}

Analyze what went wrong (if anything) and suggest:
1. What should be done next
2. How to fix any errors
3. Whether the plan needs adjustment

Be specific and actionable.`;

        messages.push({ role: 'user', content: reflectionPrompt });
        const reflection = await this.getAIResponse(messages, model, ollamaUrl);
        messages.push({ role: 'assistant', content: reflection });

        onMessage('system', `🤔 Reflection: ${reflection.substring(0, 200)}...`);

        // Update plan based on reflection
        if (this.state.plan) {
            // Plan is ready for execution
            this.state.errors = []; // Clear errors after reflection
        }
    }

    /**
     * Execute tools in parallel where safe
     */
    private async executeToolsParallel(
        toolCalls: ToolCall[],
        onProgress: (message: string) => void,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void
    ): Promise<ToolResult[]> {
        // Group tools by whether they can run in parallel
        const parallelSafe = toolCalls.filter(tc =>
            ['read_file', 'list_files', 'get_file_info', 'search_files'].includes(tc.name)
        );
        const sequential = toolCalls.filter(tc =>
            !parallelSafe.includes(tc)
        );

        const results: ToolResult[] = [];

        // Execute parallel-safe tools concurrently
        if (parallelSafe.length > 0) {
            onProgress(`Executing ${parallelSafe.length} tool(s) in parallel...`);
            const parallelResults = await Promise.all(
                parallelSafe.map(tc => this.mcpTools.executeTool(tc))
            );
            parallelResults.forEach((result, i) => {
                onToolExecution(parallelSafe[i], result);
                results.push(result);
                this.recordToolExecution(parallelSafe[i], result);
            });
        }

        // Execute sequential tools one by one
        for (const toolCall of sequential) {
            onProgress(`Executing: ${toolCall.name}...`);
            const result = await this.mcpTools.executeTool(toolCall);
            onToolExecution(toolCall, result);
            results.push(result);
            this.recordToolExecution(toolCall, result);
        }

        return results;
    }

    /**
     * Execute tool with retry logic
     */
    private async executeToolWithRetry(
        step: PlanStep,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void
    ): Promise<ToolResult> {
        // Validate and fix arguments before execution
        if (!step.tool) {
            return { success: false, error: 'No tool specified for step' };
        }

        const validatedArgs = this.validateAndFixArguments(step.tool, step.arguments || {}, step.description);

        const toolCall: ToolCall = {
            name: step.tool,
            arguments: validatedArgs
        };

        let lastResult: ToolResult | null = null;
        const maxRetries = step.maxRetries ?? 3;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            if (attempt > 0) {
                // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }

            lastResult = await this.mcpTools.executeTool(toolCall);
            onToolExecution(toolCall, lastResult);
            this.recordToolExecution(toolCall, lastResult);

            if (lastResult.success) {
                return lastResult;
            }
        }

        return lastResult || { success: false, content: '', error: 'Max retries exceeded' };
    }

    /**
     * Validate and fix tool arguments
     */
    private validateAndFixArguments(toolName: string, args: Record<string, any>, description: string): Record<string, any> {
        // If arguments are invalid or missing, re-parse from description
        if (!args || Object.keys(args).length === 0 ||
            (toolName === 'run_command' && (!args.command || args.command === 'args'))) {
            // Re-parse from description
            return this.parseToolArguments(toolName, '', description);
        }

        // Validate specific tool requirements
        switch (toolName) {
            case 'run_command':
                if (!args.command || typeof args.command !== 'string' || args.command === 'args') {
                    // Extract from description
                    const cmd = this.extractCommandFromDescription(description);
                    return { command: cmd, cwd: args.cwd || '.' };
                }
                return { command: args.command, cwd: args.cwd || '.' };

            case 'write_file':
                if (!args.file_path || !args.content) {
                    return this.parseToolArguments(toolName, '', description);
                }
                return args;

            case 'read_file':
            case 'get_file_info':
                if (!args.file_path) {
                    return this.parseToolArguments(toolName, '', description);
                }
                return args;

            case 'list_files':
                if (!args.directory_path) {
                    return { directory_path: args.directory_path || '.' };
                }
                return args;

            default:
                return args;
        }
    }

    /**
     * Extract command from description
     */
    private extractCommandFromDescription(description: string): string {
        const lowerDesc = description.toLowerCase();

        // Directory creation
        if (lowerDesc.includes('directory') || lowerDesc.includes('folder')) {
            const dirMatch = description.match(/['"]([^'"]+)['"]/);
            return dirMatch ? `mkdir -p ${dirMatch[1]}` : 'mkdir -p my-app';
        }

        // Next.js project
        if (lowerDesc.includes('next.js') || lowerDesc.includes('nextjs') || lowerDesc.includes('next js')) {
            const dirMatch = description.match(/['"]([^'"]+)['"]/);
            const dir = dirMatch ? dirMatch[1] : 'my-nextjs-app';
            return `npx create-next-app@latest ${dir} --typescript --tailwind --app --no-git --yes`;
        }

        // Install dependencies
        if (lowerDesc.includes('install') || lowerDesc.includes('dependencies')) {
            return 'npm install';
        }

        // Initialize project
        if (lowerDesc.includes('initialize') || lowerDesc.includes('init')) {
            return 'npm init -y';
        }

        // Build
        if (lowerDesc.includes('build')) {
            return 'npm run build';
        }

        // Start/run
        if (lowerDesc.includes('start') || lowerDesc.includes('run') || lowerDesc.includes('dev')) {
            return 'npm run dev';
        }

        // Test
        if (lowerDesc.includes('test')) {
            return 'npm test';
        }

        // Default - try to extract any command-like text
        const cmdMatch = description.match(/(?:run|execute|create|make|install|build|start|test)\s+(.+?)(?:\s|$|\.|,)/i);
        if (cmdMatch) {
            return cmdMatch[1].trim();
        }

        return 'echo "Command not specified"';
    }

    /**
     * Check if task is complete
     */
    private async checkTaskCompletion(
        response: string,
        messages: any[],
        model: string,
        ollamaUrl: string
    ): Promise<{ complete: boolean; reason?: string }> {
        const completionPrompt = `Based on the conversation and tool execution history, is the task complete?

Task: ${messages[1].content}
Last response: ${response}
Tool executions: ${this.state.toolHistory.length}
File changes: ${this.state.fileChanges.length}

Respond with:
COMPLETE: yes/no
REASON: brief explanation

If not complete, what's remaining?`;

        const completionCheck = await this.getAIResponse(
            [...messages, { role: 'user', content: completionPrompt }],
            model,
            ollamaUrl
        );

        const completeMatch = completionCheck.match(/COMPLETE:\s*(yes|no)/i);
        const reasonMatch = completionCheck.match(/REASON:\s*(.+)/i);

        return {
            complete: completeMatch?.[1]?.toLowerCase() === 'yes',
            reason: reasonMatch?.[1]
        };
    }

    /**
     * Record tool execution in history
     */
    private recordToolExecution(toolCall: ToolCall, result: ToolResult): void {
        this.state.toolHistory.push({
            id: `tool_${Date.now()}_${Math.random()}`,
            tool: toolCall,
            toolCall: toolCall,
            result,
            timestamp: new Date(),
            duration: 0 // Could track actual duration
        });

        // Track file changes
        if (toolCall.name === 'write_file' && result.success) {
            this.state.fileChanges.push({
                path: toolCall.arguments.file_path,
                type: 'modified',
                operation: 'modify',
                before: null, // Could read before writing
                after: toolCall.arguments.content,
                timestamp: new Date()
            });
        }
    }

    /**
     * Format tool results for AI
     */
    private formatToolResults(toolCalls: ToolCall[], results: ToolResult[]): string {
        return toolCalls.map((tc, i) => {
            const result = results[i];
            return `Tool: ${tc.name}\n` +
                `Arguments: ${JSON.stringify(tc.arguments)}\n` +
                `Success: ${result.success}\n` +
                (result.success ? `Result: ${result.content}` : `Error: ${result.error}`);
        }).join('\n\n');
    }

    /**
     * Get AI response
     */
    private async getAIResponse(messages: any[], model: string, ollamaUrl: string): Promise<string> {
        const axios = require('axios');
        const response = await axios.post(`${ollamaUrl}/api/chat`, {
            model,
            messages,
            stream: false
        }, {
            timeout: 300000
        });

        if (response.data.error) {
            throw new Error(response.data.error);
        }

        return response.data.message?.content || '';
    }

    /**
     * Build enhanced system message
     */
    private buildEnhancedSystemMessage(baseMessage: string): string {
        return `${baseMessage}

ADVANCED ORCHESTRATION MODE:
- You have access to planning, execution, and reflection phases
- Use tools proactively - don't wait to be asked
- Plan complex tasks before executing
- Reflect on errors and adjust approach
- Execute tools in parallel when safe (read operations)
- Validate results before proceeding

CONTEXT AWARENESS:
- Previous tool executions: ${this.state.toolHistory.length}
- File changes: ${this.state.fileChanges.length}
- Current errors: ${this.state.errors.length}

Remember: Think → Plan → Execute → Validate → Reflect`;
    }

    /**
     * Parse execution plan from AI response
     */
    private parsePlan(response: string): ExecutionPlan {
        const steps: PlanStep[] = [];
        const planMatch = response.match(/PLAN:([\s\S]*?)(?=\n\n|\n[A-Z]|$)/i);

        if (planMatch) {
            const planText = planMatch[1];
            const stepLines = planText.split('\n').filter(l => l.trim().match(/^\d+\./));

            stepLines.forEach((line, index) => {
                // Try multiple patterns to match plan format
                // Pattern 1: "description - tool_name(arg1, arg2)"
                let match = line.match(/^\d+\.\s*(.+?)\s*-\s*(\w+)\s*\(([^)]*)\)/);

                // Pattern 2: "description - tool_name"
                if (!match) {
                    match = line.match(/^\d+\.\s*(.+?)\s*-\s*(\w+)/);
                }

                // Pattern 3: Just "description" (try to infer tool from description)
                if (!match) {
                    const descMatch = line.match(/^\d+\.\s*(.+)/);
                    if (descMatch) {
                        const description = descMatch[1].trim();
                        // Infer tool from description
                        let tool = 'run_command';
                        if (description.toLowerCase().includes('read') && description.toLowerCase().includes('file')) {
                            tool = 'read_file';
                        } else if (description.toLowerCase().includes('write') || description.toLowerCase().includes('create') && description.toLowerCase().includes('file')) {
                            tool = 'write_file';
                        } else if (description.toLowerCase().includes('list') || description.toLowerCase().includes('directory')) {
                            tool = 'list_files';
                        }

                        steps.push({
                            id: `step_${index}`,
                            description,
                            tool,
                            arguments: this.parseToolArguments(tool, '', description),
                            dependencies: index > 0 ? [`step_${index - 1}`] : [],
                            retryCount: 0,
                            maxRetries: 3
                        });
                        return;
                    }
                }

                if (match) {
                    const description = match[1].trim();
                    const tool = match[2].trim();
                    const argsString = match[3] || '';

                    // Parse arguments based on tool type
                    const arguments_ = this.parseToolArguments(tool, argsString, description);

                    // Validate arguments before adding step
                    if (tool === 'run_command' && (!arguments_.command || arguments_.command === 'args')) {
                        // Re-extract from description
                        arguments_.command = this.extractCommandFromDescription(description);
                    }

                    steps.push({
                        id: `step_${index}`,
                        description,
                        tool,
                        arguments: arguments_,
                        dependencies: index > 0 ? [`step_${index - 1}`] : [],
                        retryCount: 0,
                        maxRetries: 3
                    });
                }
            });
        }

        return {
            steps,
            estimatedTime: undefined,
            risks: undefined
        };
    }

    /**
     * Parse tool arguments from string - smart parsing based on tool type
     */
    private parseToolArguments(toolName: string, argsString: string, description: string): Record<string, any> {
        // Try JSON first
        if (argsString.trim().startsWith('{')) {
            try {
                return JSON.parse(argsString);
            } catch {
                // Fall through to other parsing
            }
        }

        // Tool-specific argument extraction
        switch (toolName) {
            case 'run_command':
                // Extract command from args or description
                let command = argsString.trim().replace(/["']/g, '');
                if (!command && description) {
                    // Try to extract command from description
                    const cmdMatch = description.match(/(?:run|execute|create|make|install|build|start)\s+(.+)/i);
                    if (cmdMatch) {
                        command = cmdMatch[1];
                    } else {
                        // Common commands from description
                        if (description.toLowerCase().includes('directory') || description.toLowerCase().includes('folder')) {
                            const dirMatch = description.match(/['"]([^'"]+)['"]/);
                            command = dirMatch ? `mkdir -p ${dirMatch[1]}` : 'mkdir -p my-app';
                        } else if (description.toLowerCase().includes('next.js') || description.toLowerCase().includes('nextjs')) {
                            command = 'npx create-next-app@latest . --typescript --tailwind --app --no-git';
                        } else if (description.toLowerCase().includes('install')) {
                            command = 'npm install';
                        }
                    }
                }
                return { command: command || 'echo "No command specified"', cwd: '.' };

            case 'write_file':
                // Extract file path and content
                const fileMatch = argsString.match(/(["']?)([^"',]+)\1\s*,\s*(.+)/);
                if (fileMatch) {
                    return {
                        file_path: fileMatch[2],
                        content: fileMatch[3].replace(/["']/g, '')
                    };
                }
                // Try from description
                const pathMatch = description.match(/['"]([^'"]+\.(js|ts|tsx|jsx|json|md|txt))['"]/i);
                return {
                    file_path: pathMatch ? pathMatch[1] : 'file.txt',
                    content: '// Generated file'
                };

            case 'read_file':
            case 'list_files':
            case 'get_file_info':
                const pathArg = argsString.trim().replace(/["']/g, '') ||
                    (description.match(/['"]([^'"]+)['"]/) || [])[1] ||
                    '.';
                return toolName === 'list_files'
                    ? { directory_path: pathArg }
                    : { file_path: pathArg };

            case 'search_replace':
                const parts = argsString.split(',').map(s => s.trim().replace(/["']/g, ''));
                return {
                    file_path: parts[0] || '',
                    search: parts[1] || '',
                    replace: parts[2] || ''
                };

            default:
                // Generic parsing: key:value pairs
                const args: Record<string, any> = {};
                if (argsString) {
                    const pairs = argsString.split(',').map(s => s.trim());
                    pairs.forEach(pair => {
                        const colonMatch = pair.match(/(\w+):\s*(.+)/);
                        if (colonMatch) {
                            args[colonMatch[1]] = colonMatch[2].replace(/["']/g, '');
                        } else {
                            // Single value - try to infer key
                            const value = pair.replace(/["']/g, '');
                            if (toolName.includes('file')) {
                                args['file_path'] = value;
                            } else if (toolName.includes('command')) {
                                args['command'] = value;
                            }
                        }
                    });
                }
                return args;
        }
    }

    /**
     * Get context summary
     */
    private getContextSummary(): string {
        return `Tool executions: ${this.state.toolHistory.length}\n` +
            `File changes: ${this.state.fileChanges.length}\n` +
            `Errors: ${this.state.errors.length}`;
    }

    /**
     * Get recent tool history
     */
    private getRecentToolHistory(count: number): string {
        return this.state.toolHistory
            .slice(-count)
            .map((te: ToolExecution) => {
                const tool = te.toolCall || te.tool;
                if (!tool) return 'Unknown tool';
                return `${tool.name}(${JSON.stringify(tool.arguments)}) → ${te.result.success ? '✓' : '✗'}`;
            })
            .join('\n');
    }

    /**
     * Generate execution summary
     */
    private generateExecutionSummary(): string {
        const successful = this.state.toolHistory.filter((t: ToolExecution) => t.result.success).length;
        const failed = this.state.toolHistory.filter((t: ToolExecution) => !t.result.success).length;
        const filesChanged = new Set(this.state.fileChanges.map((fc: FileChange) => fc.path)).size;

        return `📊 Execution Summary:
- Tools executed: ${this.state.toolHistory.length} (${successful} successful, ${failed} failed)
- Files changed: ${filesChanged}
- Iterations: ${this.state.toolHistory.length}
- Status: ${this.state.plan ? 'completed' : 'unknown'}`;
    }
}

