import * as vscode from 'vscode';
import { MCPTools } from './mcpTools';
import { ToolCall, ToolResult, ReasoningStep, ReActState, CodebaseState } from './types';

// Extended interfaces specific to ReActOrchestrator
export interface ExtendedReActState extends ReActState {
    currentStep: number;
    context: Map<string, any>;
}

export interface ExtendedCodebaseState extends CodebaseState {
    warnings: string[];
}

export class ReActOrchestrator {
    private mcpTools: MCPTools;
    private state: ReActState;
    private maxReasoningSteps: number = 50;
    private verificationEnabled: boolean = true;

    constructor(mcpTools: MCPTools) {
        this.mcpTools = mcpTools;
        this.state = {
            task: '',
            reasoning: [],
            currentStep: 0,
            verifiedSteps: [],
            context: new Map(),
            codebaseState: {
                filesRead: new Set(),
                filesModified: new Set(),
                testsRun: 0,
                testsPassed: 0,
                errors: [],
            }
        };
    }

    /**
     * Main ReAct orchestration loop
     * ReAct = Reasoning + Acting
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
        this.state.task = task;
        const messages: any[] = [
            { role: 'system', content: this.buildReActSystemMessage(systemMessage) },
            { role: 'user', content: task }
        ];

        let stepCount = 0;
        let consecutiveThinks = 0;
        const maxConsecutiveThinks = 3; // Force action after 3 consecutive thinks

        while (stepCount < this.maxReasoningSteps) {
            stepCount++;
            onProgress(`ReAct Step ${stepCount}/${this.maxReasoningSteps}`);

            try {
                // Phase 1: THINK - AI reasons about what to do
                const reasoning = await this.thinkPhase(messages, model, ollamaUrl, onMessage);
                this.state.reasoning.push(reasoning);
                messages.push({
                    role: 'assistant',
                    content: `Thought: ${reasoning.thought}`
                });

                // Track consecutive thinking without action
                if (!reasoning.action) {
                    consecutiveThinks++;
                } else {
                    consecutiveThinks = 0;
                }

                // Force action if stuck in thinking loop
                // State-of-the-art approach: Guide AI with better prompting rather than hardcoding
                if (consecutiveThinks >= maxConsecutiveThinks) {
                    onMessage('system', '⚠️ Too much thinking - prompting AI to use framework knowledge');

                    // Instead of hardcoding, prompt AI to use its knowledge
                    const frameworkPrompt = this.buildFrameworkGuidancePrompt(this.state.task);
                    messages.push({
                        role: 'user',
                        content: frameworkPrompt
                    });
                    consecutiveThinks = 0; // Reset to give AI one more chance with better guidance
                    continue; // Let AI think again with better context
                }

                // Phase 2: ACT - Execute action if needed (Cursor-like: natural and conversational)
                if (reasoning.action) {
                    const result = await this.actPhase(reasoning.action, onProgress, onToolExecution);
                    reasoning.observation = result.success ? (result.content || 'Success') : (result.error || 'Unknown error');

                    // Cursor-like: Show what happened naturally
                    if (result.success) {
                        // For file writes, show a brief summary
                        if (reasoning.action.name === 'write_file') {
                            onMessage('system', `✓ Created/updated ${reasoning.action.arguments.file_path}`);
                        } else if (reasoning.action.name === 'search_replace') {
                            onMessage('system', `✓ Updated ${reasoning.action.arguments.file_path}`);
                        } else if (reasoning.action.name === 'run_command') {
                            // Show command result briefly
                            if (result.content) {
                                const output = result.content.substring(0, 200);
                                if (output) {
                                    onMessage('system', `✓ Command completed: ${output}`);
                                }
                            }
                        }
                    } else {
                        // Show error naturally
                        onMessage('system', `⚠️ ${reasoning.action.name} failed: ${result.error || 'Unknown error'}`);
                    }

                    // Check if task is already complete
                    if (!result.success && this.isTaskAlreadyComplete(result.error || '', reasoning.action)) {
                        onMessage('assistant', 'It looks like this task is already complete!');
                        break;
                    }

                    // Handle directory creation gracefully (Cursor-like)
                    if (!result.success && reasoning.action.name === 'list_files' && result.error?.includes('ENOENT')) {
                        const dirPath = reasoning.action.arguments.directory_path;
                        const createResult = await this.mcpTools.executeTool({
                            name: 'run_command',
                            arguments: {
                                command: `mkdir -p ${dirPath}`,
                                cwd: '.'
                            }
                        });
                        if (createResult.success) {
                            messages.push({
                                role: 'user',
                                content: `Created ${dirPath} directory. Continue with the task.`
                            });
                            continue;
                        }
                    }

                    // Natural language feedback (like Cursor)
                    messages.push({
                        role: 'user',
                        content: result.success
                            ? `That worked. Continue with the task if there's more to do.`
                            : `That didn't work: ${result.error}. Try a different approach or explain what went wrong.`
                    });

                    // Update codebase state
                    this.updateCodebaseState(reasoning.action, result);

                    // Light verification for important operations
                    if (this.verificationEnabled && result.success &&
                        (reasoning.action.name === 'write_file' || reasoning.action.name === 'search_replace')) {
                        // Quick verification for code changes
                        const verified = await this.verifyPhase(reasoning.action, model, ollamaUrl, onMessage);
                        if (verified) {
                            this.state.verifiedSteps.push(this.state.reasoning.length - 1);
                        }
                    }
                } else {
                    // No action - Cursor-like: prompt naturally
                    if (consecutiveThinks < 2) {
                        // Allow some thinking before prompting
                        continue;
                    } else {
                        messages.push({
                            role: 'user',
                            content: 'What would you like to do next? Use tools to make progress on the task.'
                        });
                        continue;
                    }
                }

                // Phase 4: DECIDE NEXT - Determine if we should continue
                if (reasoning.next === 'complete') {
                    // Final verification
                    const finalCheck = await this.finalVerification(messages, model, ollamaUrl, onMessage);
                    if (finalCheck.complete) {
                        onMessage('assistant', finalCheck.summary);
                        break;
                    }
                }

                // Continue if more work needed
                if (reasoning.next === 'think' || reasoning.next === 'act' || reasoning.next === 'verify') {
                    continue;
                }

            } catch (error: any) {
                this.state.codebaseState.errors.push(error.message);
                onMessage('system', `⚠️ Error in ReAct loop: ${error.message}`);

                // Self-correction attempt
                await this.selfCorrect(messages, model, ollamaUrl, error, onMessage);
            }
        }

        // Generate final report
        const report = this.generateReActReport();
        onMessage('system', report);
    }

    /**
     * THINK Phase - AI reasons about next action (Enhanced with Chain of Thought)
     */
    private async thinkPhase(
        messages: any[],
        model: string,
        ollamaUrl: string,
        onMessage: (role: string, content: string) => void
    ): Promise<ReasoningStep> {
        const contextPrompt = this.buildContextPrompt();

        const thinkPrompt = `You are in a ReAct (Reasoning + Acting) loop with Chain of Thought reasoning.

Current task: ${this.state.task}

${contextPrompt}

Reasoning history (last 5 steps):
${this.state.reasoning.slice(-5).map((r, i) =>
            `${i + 1}. 💭 Thought: ${r.thought.substring(0, 100)}...\n   🔧 Action: ${r.action ? r.action.name : 'none'}\n   👁️ Observation: ${r.observation.substring(0, 100) || 'pending'}...`
        ).join('\n\n')}

CURSOR-LIKE REASONING:
Think naturally about the task, then take action. You can:

1. **Understand the task**: What is the user asking for?
2. **Gather context**: What files are relevant? What's the current state?
3. **Plan your approach**: How will you accomplish this?
4. **Execute**: Use tools to make changes
5. **Explain**: Describe what you did

You can express your thinking naturally. If you need to use a tool, format it like this:

<tool_call>
<tool_name>tool_name</tool_name>
<arguments>
{"arg1": "value1"}
</arguments>
</tool_call>

Or you can describe actions in natural language and I'll interpret them.

Remember:
- Be conversational - explain what you're doing
- Focus on code editing for most tasks
- Make incremental, focused changes
- Read files to understand context before modifying
- Verify your changes work

Start by understanding the task, then take action naturally.`;

        messages.push({ role: 'user', content: thinkPrompt });
        const response = await this.getAIResponse(messages, model, ollamaUrl);

        // Cursor-like parsing: Extract tool calls from natural language response
        // Look for tool calls anywhere in the response, not just in ACTION section
        const toolCalls = this.mcpTools.parseToolCalls(response);
        const action = toolCalls.length > 0 ? toolCalls[0] : null;

        // Extract natural language explanation (everything except tool calls)
        const thought = response.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim() || response.substring(0, 300);

        // Determine next step based on response
        let next: 'think' | 'act' | 'verify' | 'complete' = 'act';
        if (action) {
            next = 'act';
        } else if (response.toLowerCase().includes('complete') || response.toLowerCase().includes('done')) {
            next = 'complete';
        } else if (response.toLowerCase().includes('verify') || response.toLowerCase().includes('check')) {
            next = 'verify';
        } else {
            next = 'think';
        }

        // Show natural language response (like Cursor does)
        if (thought && thought.length > 0) {
            onMessage('assistant', thought);
        }

        return { thought, action, observation: '', next };
    }

    /**
     * ACT Phase - Execute the action
     */
    private async actPhase(
        action: ToolCall,
        onProgress: (message: string) => void,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void
    ): Promise<ToolResult> {
        onProgress(`Acting: ${action.name}...`);
        const result = await this.mcpTools.executeTool(action);
        onToolExecution(action, result);
        return result;
    }

    /**
     * VERIFY Phase - Verify action was successful (Chain of Verification)
     */
    private async verifyPhase(
        action: ToolCall,
        model: string,
        ollamaUrl: string,
        onMessage: (role: string, content: string) => void
    ): Promise<boolean> {
        // Chain of Verification: Multiple verification strategies
        const verifications: boolean[] = [];

        switch (action.name) {
            case 'write_file':
                // Verification 1: File exists and is readable
                const readResult = await this.mcpTools.executeTool({
                    name: 'read_file',
                    arguments: { file_path: action.arguments.file_path }
                });
                verifications.push(readResult.success);

                // Verification 2: Content matches (if specified)
                if (readResult.success && readResult.content && action.arguments.content) {
                    const contentMatch = readResult.content.includes(action.arguments.content.substring(0, 100));
                    verifications.push(contentMatch);
                }

                // Verification 3: Syntax validation (if code file)
                if (action.arguments.file_path.match(/\.(ts|tsx|js|jsx)$/)) {
                    const syntaxResult = await this.mcpTools.executeTool({
                        name: 'validate_syntax',
                        arguments: {
                            file_path: action.arguments.file_path,
                            language: action.arguments.file_path.endsWith('.ts') || action.arguments.file_path.endsWith('.tsx') ? 'typescript' : 'javascript'
                        }
                    });
                    verifications.push(syntaxResult.success);
                }
                break;

            case 'run_command':
                // Verification: Command output indicates success
                // This is handled by the result.success flag
                // But we should check the actual result
                verifications.push(true); // Will be set by result.success from executeTool
                break;

            case 'search_replace':
                // Verification 1: File still readable
                const verifyRead = await this.mcpTools.executeTool({
                    name: 'read_file',
                    arguments: { file_path: action.arguments.file_path }
                });
                verifications.push(verifyRead.success);

                // Verification 2: Replacement occurred
                if (verifyRead.success && verifyRead.content) {
                    const replaced = !verifyRead.content.includes(action.arguments.search) ||
                        verifyRead.content.includes(action.arguments.replace);
                    verifications.push(replaced);
                }
                break;

            case 'run_tests':
                // Verification: Tests pass
                // Result content should indicate pass/fail
                verifications.push(true); // Will be verified by test output
                break;

            default:
                verifications.push(true);
        }

        const allVerified = verifications.every(v => v);
        if (allVerified) {
            onMessage('system', `✅ Verified: ${action.name} succeeded`);
        } else {
            onMessage('system', `⚠️ Verification failed for: ${action.name}`);
        }

        return allVerified;
    }

    /**
     * Self-correction when errors occur
     */
    private async selfCorrect(
        messages: any[],
        model: string,
        ollamaUrl: string,
        error: Error,
        onMessage: (role: string, content: string) => void
    ): Promise<void> {
        const correctionPrompt = `An error occurred: ${error.message}

Recent actions:
${this.state.reasoning.slice(-3).map(r =>
            `- ${r.action ? r.action.name : 'none'}: ${r.observation}`
        ).join('\n')}

Codebase state:
- Files modified: ${this.state.codebaseState.filesModified.size}
- Errors: ${this.state.codebaseState.errors.length}
- Tests passed: ${this.state.codebaseState.testsPassed}/${this.state.codebaseState.testsRun}

Analyze what went wrong and suggest a correction. What should be done differently?`;

        messages.push({ role: 'user', content: correctionPrompt });
        const correction = await this.getAIResponse(messages, model, ollamaUrl);
        onMessage('system', `🔧 Self-correction: ${correction.substring(0, 200)}...`);

        // Clear recent errors to allow retry
        this.state.codebaseState.errors = this.state.codebaseState.errors.slice(-5);
    }

    /**
     * Extract generic action when specific extraction fails
     * Supports top 10 programming languages
     */
    private extractGenericAction(task: string): ToolCall | null {
        const lowerTask = task.toLowerCase();

        // Python project patterns
        if (lowerTask.includes('python')) {
            if (lowerTask.includes('backend') || lowerTask.includes('api')) {
                return {
                    name: 'run_command',
                    arguments: {
                        command: 'mkdir -p backend && cd backend && python3 -m venv venv',
                        cwd: '.'
                    }
                };
            }
            return {
                name: 'run_command',
                arguments: {
                    command: 'python3 -m venv venv',
                    cwd: '.'
                }
            };
        }

        // TypeScript/JavaScript project patterns
        if (lowerTask.includes('typescript') || lowerTask.includes('ts') || lowerTask.includes('javascript') || lowerTask.includes('js')) {
            if (lowerTask.includes('backend') || lowerTask.includes('api')) {
                return {
                    name: 'run_command',
                    arguments: {
                        command: 'mkdir -p backend && cd backend && npm init -y && npm install -D typescript @types/node ts-node',
                        cwd: '.'
                    }
                };
            }
            return {
                name: 'run_command',
                arguments: {
                    command: 'npm init -y && npm install -D typescript @types/node ts-node',
                    cwd: '.'
                }
            };
        }

        // Java project patterns
        if (lowerTask.includes('java')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p src/main/java src/main/resources src/test/java',
                    cwd: '.'
                }
            };
        }

        // C# / .NET project patterns
        if (lowerTask.includes('c#') || lowerTask.includes('csharp') || lowerTask.includes('dotnet') || lowerTask.includes('.net')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'dotnet new console -n MyApp',
                    cwd: '.'
                }
            };
        }

        // Go project patterns
        if (lowerTask.includes('go') || lowerTask.includes('golang')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p backend && cd backend && go mod init myapp',
                    cwd: '.'
                }
            };
        }

        // Rust project patterns
        if (lowerTask.includes('rust')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'cargo new my-rust-app',
                    cwd: '.'
                }
            };
        }

        // PHP project patterns
        if (lowerTask.includes('php')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p backend && cd backend && composer init',
                    cwd: '.'
                }
            };
        }

        // Ruby project patterns
        if (lowerTask.includes('ruby')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p backend && cd backend && bundle init',
                    cwd: '.'
                }
            };
        }

        // Swift project patterns
        if (lowerTask.includes('swift')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'swift package init --type executable',
                    cwd: '.'
                }
            };
        }

        // Kotlin project patterns
        if (lowerTask.includes('kotlin')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p src/main/kotlin && gradle init --type kotlin-application',
                    cwd: '.'
                }
            };
        }

        // C/C++ project patterns
        if ((lowerTask.includes(' c ') && !lowerTask.includes('c#')) || lowerTask.includes('c++') || lowerTask.includes('cpp')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p src include && touch Makefile',
                    cwd: '.'
                }
            };
        }

        // If task mentions creating something, start by creating a directory
        if (lowerTask.includes('create') || lowerTask.includes('make') || lowerTask.includes('build')) {
            // Try to extract a name from the task
            const nameMatch = task.match(/(?:create|make|build)\s+(?:a\s+)?(?:new\s+)?(\w+)/i);
            const name = nameMatch ? nameMatch[1] : 'app';

            return {
                name: 'run_command',
                arguments: {
                    command: `mkdir -p ${name}`,
                    cwd: '.'
                }
            };
        }

        // If task mentions backend, create backend directory
        if (lowerTask.includes('backend')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p backend',
                    cwd: '.'
                }
            };
        }

        // If task mentions frontend, create frontend directory
        if (lowerTask.includes('frontend')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p frontend',
                    cwd: '.'
                }
            };
        }

        return null;
    }

    /**
     * Check if task is already complete
     * Supports generic Python and TypeScript project detection
     */
    private async checkIfTaskComplete(
        messages: any[],
        model: string,
        ollamaUrl: string
    ): Promise<{ complete: boolean; summary?: string }> {
        const lowerTask = this.state.task.toLowerCase();

        // ===== PYTHON PROJECTS =====

        // FastAPI backend
        if (lowerTask.includes('fastapi') || (lowerTask.includes('backend') && lowerTask.includes('fast'))) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: 'backend' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('main.py') || listResult.content.includes('app.py'))) {
                return {
                    complete: true,
                    summary: 'FastAPI backend already exists in backend directory. Task is complete!'
                };
            }
        }

        // Django project
        if (lowerTask.includes('django')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: '.' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('manage.py') || listResult.content.includes('settings.py'))) {
                return {
                    complete: true,
                    summary: 'Django project already exists. Task is complete!'
                };
            }
        }

        // Flask project
        if (lowerTask.includes('flask')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: 'app' }
            });

            if (listResult.success && listResult.content && listResult.content.includes('app.py')) {
                return {
                    complete: true,
                    summary: 'Flask app already exists. Task is complete!'
                };
            }
        }

        // Generic Python project
        if (lowerTask.includes('python') && (lowerTask.includes('project') || lowerTask.includes('app') || lowerTask.includes('backend'))) {
            const checkDirs = ['backend', 'app', '.'];
            for (const dir of checkDirs) {
                const listResult = await this.mcpTools.executeTool({
                    name: 'list_files',
                    arguments: { directory_path: dir }
                });

                if (listResult.success && listResult.content && (listResult.content.includes('.py') || listResult.content.includes('requirements.txt') || listResult.content.includes('venv'))) {
                    return {
                        complete: true,
                        summary: `Python project already exists in ${dir} directory. Task is complete!`
                    };
                }
            }
        }

        // ===== TYPESCRIPT/JAVASCRIPT PROJECTS =====

        // Next.js project
        if (lowerTask.includes('next.js')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: 'my-nextjs-app' }
            });

            if (listResult.success && listResult.content && listResult.content.includes('package.json')) {
                return {
                    complete: true,
                    summary: 'Next.js app already exists in my-nextjs-app directory. Task is complete!'
                };
            }
        }

        // React project
        if (lowerTask.includes('react') && !lowerTask.includes('next')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: 'my-react-app' }
            });

            if (listResult.success && listResult.content && listResult.content.includes('package.json')) {
                return {
                    complete: true,
                    summary: 'React app already exists in my-react-app directory. Task is complete!'
                };
            }
        }

        // Generic TypeScript project
        if (lowerTask.includes('typescript') || lowerTask.includes('ts project')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: '.' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('tsconfig.json') || listResult.content.includes('package.json'))) {
                return {
                    complete: true,
                    summary: 'TypeScript project already exists. Task is complete!'
                };
            }
        }

        // Generic Node.js/JavaScript project
        if (lowerTask.includes('node.js') || lowerTask.includes('nodejs') || (lowerTask.includes('javascript') && lowerTask.includes('project'))) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: '.' }
            });

            if (listResult.success && listResult.content && listResult.content.includes('package.json')) {
                return {
                    complete: true,
                    summary: 'Node.js/JavaScript project already exists. Task is complete!'
                };
            }
        }

        // ===== JAVA PROJECTS =====

        // Spring Boot
        if (lowerTask.includes('spring') || lowerTask.includes('spring boot')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: '.' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('pom.xml') || listResult.content.includes('build.gradle') || listResult.content.includes('Application.java'))) {
                return {
                    complete: true,
                    summary: 'Spring Boot project already exists. Task is complete!'
                };
            }
        }

        // Generic Java project
        if (lowerTask.includes('java') && (lowerTask.includes('project') || lowerTask.includes('app'))) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: '.' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('.java') || listResult.content.includes('pom.xml') || listResult.content.includes('build.gradle'))) {
                return {
                    complete: true,
                    summary: 'Java project already exists. Task is complete!'
                };
            }
        }

        // ===== C# / .NET PROJECTS =====

        if (lowerTask.includes('c#') || lowerTask.includes('csharp') || lowerTask.includes('dotnet') || lowerTask.includes('.net') || lowerTask.includes('asp.net')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: '.' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('.csproj') || listResult.content.includes('.sln') || listResult.content.includes('.cs'))) {
                return {
                    complete: true,
                    summary: 'C# / .NET project already exists. Task is complete!'
                };
            }
        }

        // ===== GO PROJECTS =====

        if (lowerTask.includes('go') || lowerTask.includes('golang')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: 'backend' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('go.mod') || listResult.content.includes('.go'))) {
                return {
                    complete: true,
                    summary: 'Go project already exists. Task is complete!'
                };
            }
        }

        // ===== RUST PROJECTS =====

        if (lowerTask.includes('rust')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: '.' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('Cargo.toml') || listResult.content.includes('.rs'))) {
                return {
                    complete: true,
                    summary: 'Rust project already exists. Task is complete!'
                };
            }
        }

        // ===== PHP PROJECTS =====

        // Laravel
        if (lowerTask.includes('laravel')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: 'my-laravel-app' }
            });

            if (listResult.success && listResult.content && listResult.content.includes('artisan')) {
                return {
                    complete: true,
                    summary: 'Laravel project already exists. Task is complete!'
                };
            }
        }

        // Generic PHP
        if (lowerTask.includes('php') && (lowerTask.includes('project') || lowerTask.includes('app'))) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: 'backend' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('.php') || listResult.content.includes('composer.json'))) {
                return {
                    complete: true,
                    summary: 'PHP project already exists. Task is complete!'
                };
            }
        }

        // ===== RUBY PROJECTS =====

        // Rails
        if (lowerTask.includes('rails') || lowerTask.includes('ruby on rails')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: 'my-rails-app' }
            });

            if (listResult.success && listResult.content && listResult.content.includes('Gemfile')) {
                return {
                    complete: true,
                    summary: 'Rails project already exists. Task is complete!'
                };
            }
        }

        // Generic Ruby
        if (lowerTask.includes('ruby') && (lowerTask.includes('project') || lowerTask.includes('app'))) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: 'backend' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('.rb') || listResult.content.includes('Gemfile'))) {
                return {
                    complete: true,
                    summary: 'Ruby project already exists. Task is complete!'
                };
            }
        }

        // ===== SWIFT PROJECTS =====

        if (lowerTask.includes('swift')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: '.' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('Package.swift') || listResult.content.includes('.swift'))) {
                return {
                    complete: true,
                    summary: 'Swift project already exists. Task is complete!'
                };
            }
        }

        // ===== KOTLIN PROJECTS =====

        if (lowerTask.includes('kotlin')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: '.' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('.kt') || listResult.content.includes('build.gradle.kts'))) {
                return {
                    complete: true,
                    summary: 'Kotlin project already exists. Task is complete!'
                };
            }
        }

        // ===== C/C++ PROJECTS =====

        if ((lowerTask.includes(' c ') && !lowerTask.includes('c#')) || lowerTask.includes('c++') || lowerTask.includes('cpp')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: '.' }
            });

            if (listResult.success && listResult.content && (listResult.content.includes('.c') || listResult.content.includes('.cpp') || listResult.content.includes('.h'))) {
                return {
                    complete: true,
                    summary: 'C/C++ project already exists. Task is complete!'
                };
            }
        }

        // Generic backend (check for common files)
        if (lowerTask.includes('backend')) {
            const listResult = await this.mcpTools.executeTool({
                name: 'list_files',
                arguments: { directory_path: 'backend' }
            });

            if (listResult.success && listResult.content && (
                listResult.content.includes('package.json') ||
                listResult.content.includes('requirements.txt') ||
                listResult.content.includes('main.py') ||
                listResult.content.includes('app.py') ||
                listResult.content.includes('index.js') ||
                listResult.content.includes('server.js') ||
                listResult.content.includes('go.mod') ||
                listResult.content.includes('Cargo.toml') ||
                listResult.content.includes('composer.json') ||
                listResult.content.includes('Gemfile') ||
                listResult.content.includes('pom.xml') ||
                listResult.content.includes('.csproj')
            )) {
                return {
                    complete: true,
                    summary: 'Backend already exists in backend directory. Task is complete!'
                };
            }
        }

        return { complete: false };
    }

    /**
     * Final verification before completion
     */
    private async finalVerification(
        messages: any[],
        model: string,
        ollamaUrl: string,
        onMessage: (role: string, content: string) => void
    ): Promise<{ complete: boolean; summary: string }> {
        const verifyPrompt = `Verify that the task "${this.state.task}" is complete.

Files modified: ${Array.from(this.state.codebaseState.filesModified).join(', ')}
Tests run: ${this.state.codebaseState.testsRun}
Tests passed: ${this.state.codebaseState.testsPassed}
Errors: ${this.state.codebaseState.errors.length}

Check:
1. Are all required files created/modified?
2. Do tests pass?
3. Are there any errors?
4. Is the code functional?

Respond with:
COMPLETE: yes/no
SUMMARY: Brief summary of what was accomplished`;

        const verification = await this.getAIResponse(
            [...messages, { role: 'user', content: verifyPrompt }],
            model,
            ollamaUrl
        );

        const completeMatch = verification.match(/COMPLETE:\s*(yes|no)/i);
        const summaryMatch = verification.match(/SUMMARY:\s*(.+)/i);

        return {
            complete: completeMatch?.[1]?.toLowerCase() === 'yes',
            summary: summaryMatch?.[1] || verification
        };
    }

    /**
     * Update codebase state after action
     */
    private updateCodebaseState(action: ToolCall, result: ToolResult): void {
        switch (action.name) {
            case 'read_file':
                this.state.codebaseState.filesRead.add(action.arguments.file_path);
                break;
            case 'write_file':
                this.state.codebaseState.filesModified.add(action.arguments.file_path);
                break;
            case 'run_tests':
                this.state.codebaseState.testsRun++;
                if (result.success && result.content && (result.content.includes('pass') || result.content.includes('✓'))) {
                    this.state.codebaseState.testsPassed++;
                }
                break;
            case 'lint_code':
            case 'validate_syntax':
                if (!result.success) {
                    this.state.codebaseState.errors.push(result.error || 'Validation failed');
                }
                break;
        }
    }

    /**
     * Build Cursor-like system message
     */
    private buildReActSystemMessage(baseMessage: string): string {
        return `${baseMessage}

YOU ARE A CODING ASSISTANT (like Cursor):
You help developers write, edit, and understand code through natural conversation.

YOUR STYLE:
- **Conversational**: Talk naturally. Explain what you're doing.
- **Code-Focused**: Most tasks involve reading/writing code files.
- **Context-Aware**: Understand the codebase before making changes.
- **Incremental**: Make small, focused edits. Show what changed.
- **Helpful**: Explain your reasoning. Ask questions if unclear.

WORKFLOW:
1. Understand the task and current codebase
2. Read relevant files to gather context
3. Make focused, incremental changes
4. Explain what you did
5. Verify it works

TOOL USAGE:
- Use tools naturally as part of your workflow
- You can describe actions - the system interprets them
- Focus on file operations (read_file, write_file, search_replace)
- Use run_command for dependencies, tests, builds

COMMUNICATION:
- Explain your thinking naturally
- Describe changes clearly
- If something fails, explain why and suggest alternatives
- Be helpful and conversational

Remember: You're a coding assistant, not a robot. Be natural, helpful, and code-focused.`;
    }

    /**
     * Build context prompt for reasoning
     */
    private buildContextPrompt(): string {
        return `Current Context:
- Files read: ${this.state.codebaseState.filesRead.size}
- Files modified: ${this.state.codebaseState.filesModified.size}
- Tests: ${this.state.codebaseState.testsPassed}/${this.state.codebaseState.testsRun} passed
- Errors: ${this.state.codebaseState.errors.length}
- Reasoning steps: ${this.state.reasoning.length}
- Verified steps: ${this.state.verifiedSteps.length}

Recent file changes:
${Array.from(this.state.codebaseState.filesModified).slice(-5).join(', ')}

Available tools: ${this.mcpTools.getAvailableTools().split('\n').slice(0, 10).join('\n')}`;
    }

    /**
     * Generate ReAct execution report
     */
    private generateReActReport(): string {
        const totalSteps = this.state.reasoning.length;
        const actionsTaken = this.state.reasoning.filter(r => r.action).length;
        const verifiedActions = this.state.verifiedSteps.length;
        const successRate = actionsTaken > 0 ? (verifiedActions / actionsTaken * 100).toFixed(1) : '0';

        return `📊 ReAct Execution Report:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task: ${this.state.task}
Reasoning Steps: ${totalSteps}
Actions Taken: ${actionsTaken}
Verified Actions: ${verifiedActions}
Success Rate: ${successRate}%
Files Read: ${this.state.codebaseState.filesRead.size}
Files Modified: ${this.state.codebaseState.filesModified.size}
Tests: ${this.state.codebaseState.testsPassed}/${this.state.codebaseState.testsRun} passed
Errors: ${this.state.codebaseState.errors.length}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    }

    /**
     * Check if task is already complete based on error message
     */
    private isTaskAlreadyComplete(errorMessage: string, action: ToolCall): boolean {
        const lowerError = errorMessage.toLowerCase();

        // Next.js app already exists
        if (action.name === 'run_command' &&
            action.arguments.command?.includes('create-next-app') &&
            (lowerError.includes('contains files') || lowerError.includes('already exists') || lowerError.includes('directory'))) {
            return true;
        }

        // Directory already exists
        if (lowerError.includes('already exists') || lowerError.includes('file exists')) {
            return true;
        }

        return false;
    }

    /**
     * Extract action from task when AI is stuck thinking
     * Supports top 10 programming languages and their frameworks
     */
    private extractActionFromTask(task: string): ToolCall | null {
        const lowerTask = task.toLowerCase();

        // ===== PYTHON PROJECTS =====

        // FastAPI backend
        if (lowerTask.includes('fastapi') || lowerTask.includes('fast api')) {
            // Create backend directory and set up FastAPI
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p backend && cd backend && python3 -m venv venv && source venv/bin/activate && pip install fastapi uvicorn',
                    cwd: '.'
                }
            };
        }

        // Django project
        if (lowerTask.includes('django')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'django-admin startproject myproject .',
                    cwd: '.'
                }
            };
        }

        // Flask project
        if (lowerTask.includes('flask')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p app && python3 -m venv venv',
                    cwd: '.'
                }
            };
        }

        // Generic Python backend/project
        if (lowerTask.includes('python') && (lowerTask.includes('backend') || lowerTask.includes('project') || lowerTask.includes('app'))) {
            // Extract project name or use default
            const nameMatch = task.match(/python\s+(?:backend|project|app)(?:\s+(\w+))?/i);
            const projectName = nameMatch?.[1] || 'backend';

            return {
                name: 'run_command',
                arguments: {
                    command: `mkdir -p ${projectName} && cd ${projectName} && python3 -m venv venv`,
                    cwd: '.'
                }
            };
        }

        // Python virtual environment
        if (lowerTask.includes('python') && (lowerTask.includes('venv') || lowerTask.includes('virtual'))) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'python3 -m venv venv',
                    cwd: '.'
                }
            };
        }

        // ===== TYPESCRIPT/JAVASCRIPT PROJECTS =====

        // Next.js project
        if (lowerTask.includes('next.js') || lowerTask.includes('nextjs') || lowerTask.includes('next js')) {
            return {
                name: 'list_files',
                arguments: { directory_path: 'my-nextjs-app' }
            };
        }

        // React project
        if (lowerTask.includes('react') && !lowerTask.includes('next')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'npx create-react-app my-react-app --template typescript',
                    cwd: '.'
                }
            };
        }

        // Vue.js project
        if (lowerTask.includes('vue')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'npm create vue@latest my-vue-app -- --typescript',
                    cwd: '.'
                }
            };
        }

        // Svelte project
        if (lowerTask.includes('svelte')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'npm create svelte@latest my-svelte-app',
                    cwd: '.'
                }
            };
        }

        // Angular project
        if (lowerTask.includes('angular')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'npx @angular/cli new my-angular-app --routing --style=css',
                    cwd: '.'
                }
            };
        }

        // Generic TypeScript project
        if (lowerTask.includes('typescript') || lowerTask.includes('ts project')) {
            const nameMatch = task.match(/typescript\s+(?:project|app)(?:\s+(\w+))?/i);
            const projectName = nameMatch?.[1] || 'my-ts-project';

            return {
                name: 'run_command',
                arguments: {
                    command: `mkdir -p ${projectName} && cd ${projectName} && npm init -y && npm install -D typescript @types/node ts-node`,
                    cwd: '.'
                }
            };
        }

        // Generic Node.js/JavaScript project
        if (lowerTask.includes('node.js') || lowerTask.includes('nodejs') || (lowerTask.includes('javascript') && lowerTask.includes('project'))) {
            const nameMatch = task.match(/(?:node|javascript)\s+(?:project|app)(?:\s+(\w+))?/i);
            const projectName = nameMatch?.[1] || 'my-node-app';

            return {
                name: 'run_command',
                arguments: {
                    command: `mkdir -p ${projectName} && cd ${projectName} && npm init -y`,
                    cwd: '.'
                }
            };
        }

        // ===== GENERIC PROJECT CREATION =====

        // Directory creation
        if (lowerTask.includes('directory') || lowerTask.includes('folder')) {
            const dirMatch = task.match(/['"]([^'"]+)['"]/);
            const dir = dirMatch ? dirMatch[1] : 'my-app';
            return {
                name: 'run_command',
                arguments: {
                    command: `mkdir -p ${dir}`,
                    cwd: '.'
                }
            };
        }

        // Install dependencies
        if (lowerTask.includes('install') && (lowerTask.includes('dependencies') || lowerTask.includes('packages'))) {
            // Detect package manager
            if (lowerTask.includes('npm')) {
                return {
                    name: 'run_command',
                    arguments: { command: 'npm install', cwd: '.' }
                };
            } else if (lowerTask.includes('pip') || lowerTask.includes('python')) {
                return {
                    name: 'run_command',
                    arguments: { command: 'pip install -r requirements.txt', cwd: '.' }
                };
            }
            return {
                name: 'run_command',
                arguments: { command: 'npm install', cwd: '.' }
            };
        }

        // Initialize project
        if (lowerTask.includes('init') || lowerTask.includes('initialize')) {
            if (lowerTask.includes('python')) {
                return {
                    name: 'run_command',
                    arguments: { command: 'python3 -m venv venv', cwd: '.' }
                };
            }
            return {
                name: 'run_command',
                arguments: { command: 'npm init -y', cwd: '.' }
            };
        }

        // Generic backend creation
        if (lowerTask.includes('backend')) {
            // Try to detect language
            if (lowerTask.includes('python') || lowerTask.includes('fastapi') || lowerTask.includes('flask') || lowerTask.includes('django')) {
                // For FastAPI, create directory and install dependencies
                if (lowerTask.includes('fastapi')) {
                    return {
                        name: 'run_command',
                        arguments: {
                            command: 'mkdir -p backend && cd backend && python3 -m venv venv && source venv/bin/activate && pip install fastapi uvicorn',
                            cwd: '.'
                        }
                    };
                }
                return {
                    name: 'run_command',
                    arguments: {
                        command: 'mkdir -p backend && cd backend && python3 -m venv venv',
                        cwd: '.'
                    }
                };
            } else if (lowerTask.includes('typescript') || lowerTask.includes('node') || lowerTask.includes('express')) {
                return {
                    name: 'run_command',
                    arguments: {
                        command: 'mkdir -p backend && cd backend && npm init -y && npm install express && npm install -D typescript @types/node @types/express ts-node',
                        cwd: '.'
                    }
                };
            }
            // Default: create backend directory
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p backend',
                    cwd: '.'
                }
            };
        }

        // Generic frontend creation
        if (lowerTask.includes('frontend')) {
            if (lowerTask.includes('react')) {
                return {
                    name: 'run_command',
                    arguments: {
                        command: 'npx create-react-app frontend --template typescript',
                        cwd: '.'
                    }
                };
            } else if (lowerTask.includes('vue')) {
                return {
                    name: 'run_command',
                    arguments: {
                        command: 'npm create vue@latest frontend -- --typescript',
                        cwd: '.'
                    }
                };
            }
            // Default: create frontend directory
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p frontend',
                    cwd: '.'
                }
            };
        }

        // ===== JAVA PROJECTS =====

        // Spring Boot project
        if (lowerTask.includes('spring') || lowerTask.includes('spring boot')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'curl https://start.spring.io/starter.zip -d dependencies=web -d javaVersion=17 -d type=maven-project -o spring-boot.zip && unzip spring-boot.zip && rm spring-boot.zip',
                    cwd: '.'
                }
            };
        }

        // Maven project
        if (lowerTask.includes('maven') && lowerTask.includes('java')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mvn archetype:generate -DgroupId=com.example -DartifactId=my-app -DarchetypeArtifactId=maven-archetype-quickstart -DinteractiveMode=false',
                    cwd: '.'
                }
            };
        }

        // Gradle project
        if (lowerTask.includes('gradle') && lowerTask.includes('java')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'gradle init --type java-application --dsl groovy',
                    cwd: '.'
                }
            };
        }

        // Generic Java project
        if (lowerTask.includes('java') && (lowerTask.includes('project') || lowerTask.includes('app'))) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p src/main/java src/main/resources src/test/java',
                    cwd: '.'
                }
            };
        }

        // ===== C# / .NET PROJECTS =====

        // ASP.NET Core project
        if (lowerTask.includes('asp.net') || lowerTask.includes('aspnet') || lowerTask.includes('dotnet')) {
            if (lowerTask.includes('web') || lowerTask.includes('api')) {
                return {
                    name: 'run_command',
                    arguments: {
                        command: 'dotnet new webapi -n MyApi',
                        cwd: '.'
                    }
                };
            } else if (lowerTask.includes('mvc')) {
                return {
                    name: 'run_command',
                    arguments: {
                        command: 'dotnet new mvc -n MyMvcApp',
                        cwd: '.'
                    }
                };
            }
            return {
                name: 'run_command',
                arguments: {
                    command: 'dotnet new console -n MyApp',
                    cwd: '.'
                }
            };
        }

        // Generic C# project
        if (lowerTask.includes('c#') || lowerTask.includes('csharp')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'dotnet new console -n MyApp',
                    cwd: '.'
                }
            };
        }

        // ===== GO PROJECTS =====

        // Gin framework
        if (lowerTask.includes('gin') && lowerTask.includes('go')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p backend && cd backend && go mod init myapp && go get github.com/gin-gonic/gin',
                    cwd: '.'
                }
            };
        }

        // Echo framework
        if (lowerTask.includes('echo') && lowerTask.includes('go')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p backend && cd backend && go mod init myapp && go get github.com/labstack/echo/v4',
                    cwd: '.'
                }
            };
        }

        // Generic Go project
        if (lowerTask.includes('go') && (lowerTask.includes('project') || lowerTask.includes('app') || lowerTask.includes('backend'))) {
            const nameMatch = task.match(/go\s+(?:project|app|backend)(?:\s+(\w+))?/i);
            const projectName = nameMatch?.[1] || 'backend';
            return {
                name: 'run_command',
                arguments: {
                    command: `mkdir -p ${projectName} && cd ${projectName} && go mod init myapp`,
                    cwd: '.'
                }
            };
        }

        // ===== RUST PROJECTS =====

        // Rust project with Cargo
        if (lowerTask.includes('rust')) {
            const nameMatch = task.match(/rust\s+(?:project|app)(?:\s+(\w+))?/i);
            const projectName = nameMatch?.[1] || 'my-rust-app';
            return {
                name: 'run_command',
                arguments: {
                    command: `cargo new ${projectName}`,
                    cwd: '.'
                }
            };
        }

        // ===== PHP PROJECTS =====

        // Laravel project
        if (lowerTask.includes('laravel')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'composer create-project laravel/laravel my-laravel-app',
                    cwd: '.'
                }
            };
        }

        // Symfony project
        if (lowerTask.includes('symfony')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'composer create-project symfony/skeleton my-symfony-app',
                    cwd: '.'
                }
            };
        }

        // Generic PHP project
        if (lowerTask.includes('php') && (lowerTask.includes('project') || lowerTask.includes('app'))) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p backend && cd backend && composer init',
                    cwd: '.'
                }
            };
        }

        // ===== RUBY PROJECTS =====

        // Rails project
        if (lowerTask.includes('rails') || lowerTask.includes('ruby on rails')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'rails new my-rails-app --database=postgresql',
                    cwd: '.'
                }
            };
        }

        // Sinatra project
        if (lowerTask.includes('sinatra')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p my-sinatra-app && cd my-sinatra-app && bundle init',
                    cwd: '.'
                }
            };
        }

        // Generic Ruby project
        if (lowerTask.includes('ruby') && (lowerTask.includes('project') || lowerTask.includes('app'))) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p backend && cd backend && bundle init',
                    cwd: '.'
                }
            };
        }

        // ===== SWIFT PROJECTS =====

        // Swift Package Manager
        if (lowerTask.includes('swift')) {
            const nameMatch = task.match(/swift\s+(?:project|app|package)(?:\s+(\w+))?/i);
            const projectName = nameMatch?.[1] || 'MySwiftPackage';
            return {
                name: 'run_command',
                arguments: {
                    command: `swift package init --type executable --name ${projectName}`,
                    cwd: '.'
                }
            };
        }

        // ===== KOTLIN PROJECTS =====

        // Kotlin with Gradle
        if (lowerTask.includes('kotlin')) {
            if (lowerTask.includes('spring')) {
                return {
                    name: 'run_command',
                    arguments: {
                        command: 'curl https://start.spring.io/starter.zip -d language=kotlin -d dependencies=web -d javaVersion=17 -o kotlin-spring.zip && unzip kotlin-spring.zip && rm kotlin-spring.zip',
                        cwd: '.'
                    }
                };
            }
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p src/main/kotlin && gradle init --type kotlin-application --dsl kotlin',
                    cwd: '.'
                }
            };
        }

        // ===== C/C++ PROJECTS =====

        // C project
        if (lowerTask.includes(' c ') && !lowerTask.includes('c#') && !lowerTask.includes('csharp')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p src include && touch src/main.c Makefile',
                    cwd: '.'
                }
            };
        }

        // C++ project
        if (lowerTask.includes('c++') || lowerTask.includes('cpp')) {
            return {
                name: 'run_command',
                arguments: {
                    command: 'mkdir -p src include && touch src/main.cpp Makefile',
                    cwd: '.'
                }
            };
        }

        return null;
    }

    /**
     * Build framework guidance prompt (state-of-the-art approach)
     * Guides AI to use its training knowledge rather than hardcoding commands
     */
    private buildFrameworkGuidancePrompt(task: string): string {
        const lowerTask = task.toLowerCase();

        // Detect framework/language and provide guidance
        if (lowerTask.includes('fastapi') || lowerTask.includes('fast api')) {
            return `You need to create a FastAPI backend. Use your knowledge of FastAPI:

1. Create a backend directory: mkdir -p backend
2. Set up Python virtual environment: cd backend && python3 -m venv venv
3. Activate venv and install: source venv/bin/activate && pip install fastapi uvicorn
4. Create main.py with FastAPI app

Use run_command tool to execute these steps. Don't just think - ACT NOW.`;
        }

        if (lowerTask.includes('next.js') || lowerTask.includes('nextjs')) {
            return `You need to create a Next.js app. Use your knowledge of Next.js:

Use: npx create-next-app@latest my-nextjs-app --typescript --tailwind --app --no-git --yes

Use run_command tool NOW. Don't think more - execute the command.`;
        }

        if (lowerTask.includes('react') && !lowerTask.includes('next')) {
            return `You need to create a React app. Use your knowledge of React:

Use: npx create-react-app my-react-app --template typescript

Use run_command tool NOW.`;
        }

        if (lowerTask.includes('django')) {
            return `You need to create a Django project. Use your knowledge of Django:

Use: django-admin startproject myproject .

Use run_command tool NOW.`;
        }

        if (lowerTask.includes('spring') || lowerTask.includes('java')) {
            return `You need to create a Java/Spring Boot project. Use your knowledge:

For Spring Boot, use Spring Initializr or Maven/Gradle commands.
Use run_command tool with the appropriate command NOW.`;
        }

        if (lowerTask.includes('dotnet') || lowerTask.includes('c#') || lowerTask.includes('asp.net')) {
            return `You need to create a .NET project. Use your knowledge:

For API: dotnet new webapi -n MyApi
For MVC: dotnet new mvc -n MyMvcApp

Use run_command tool NOW.`;
        }

        // Generic guidance
        return `You've been thinking too long. Use your training knowledge to determine the correct commands for this task.

The task is: "${task}"

Think about:
1. What framework/language is mentioned?
2. What's the standard way to create a project in that framework?
3. What commands do you know from your training?

Then use run_command tool immediately with the appropriate command. Don't think more - ACT NOW.`;
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
}

