import * as vscode from 'vscode';
import { MCPTools } from '../mcpTools';
import { ToolCall, ToolResult, ReasoningStep, ReActState, CodebaseState } from '../types';
import { getAIResponse } from '../ollamaClient';
import { buildReActSystemMessage, buildFrameworkGuidancePrompt, buildContextPrompt } from './reactPrompts';
import { thinkPhase, actPhase, verifyPhase } from './reactPhases';
import { extractGenericAction, isTaskAlreadyComplete, checkIfTaskComplete } from './reactHelpers';
import { MCPToolAdapter } from './mcpToolAdapter';

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
    private toolAdapter: MCPToolAdapter;
    private state: ReActState;
    private maxReasoningSteps: number = 30; // Reduced from 50 to prevent long loops
    private verificationEnabled: boolean = true;
    private recentActions: Array<{ action: string; timestamp: number }> = []; // Track recent actions
    private consecutiveFailures: number = 0;
    private maxConsecutiveFailures: number = 3;

    constructor(mcpTools: MCPTools) {
        this.mcpTools = mcpTools;
        this.toolAdapter = new MCPToolAdapter(mcpTools);
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
                errors: []
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
        const startTime = Date.now();
        const maxExecutionTime = 5 * 60 * 1000; // 5 minutes max execution time

        while (stepCount < this.maxReasoningSteps) {
            stepCount++;
            
            // Check for timeout
            if (Date.now() - startTime > maxExecutionTime) {
                onMessage('system', '⏱️ Maximum execution time reached. Stopping to prevent timeout.');
                break;
            }
            
            onProgress(`ReAct Step ${stepCount}/${this.maxReasoningSteps}`);
            
            // Check for repeated actions (detect loops)
            if (this.detectActionLoop()) {
                onMessage('system', '⚠️ Detected action loop - same actions being repeated. Stopping to prevent infinite loop.');
                onMessage('assistant', 'I detected that I was repeating the same actions. Let me check if the task is already complete or try a different approach.');
                
                // Check if task is actually complete
                const completionCheck = await this.checkTaskCompletion(task, onMessage);
                if (completionCheck.complete) {
                    onMessage('assistant', completionCheck.summary || 'Task appears to be complete!');
                    break;
                }
                
                // Try to break out of loop with explicit instruction
                messages.push({
                    role: 'user',
                    content: 'You are repeating the same actions. Please either: 1) Check if the task is complete, 2) Try a completely different approach, or 3) Explain what is blocking progress.'
                });
                continue;
            }

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
                    // Track action to detect loops
                    const actionKey = this.getActionKey(reasoning.action);
                    this.recentActions.push({ action: actionKey, timestamp: Date.now() });
                    // Keep only last 10 actions
                    if (this.recentActions.length > 10) {
                        this.recentActions.shift();
                    }
                    
                    const result = await this.actPhase(reasoning.action, onProgress, onToolExecution);
                    reasoning.observation = result.success ? (result.content || '') : (result.error || 'Unknown error');
                    
                    // Track consecutive failures
                    if (result.success) {
                        this.consecutiveFailures = 0;
                    } else {
                        this.consecutiveFailures++;
                    }
                    
                    // Stop if too many consecutive failures
                    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
                        onMessage('system', `⚠️ ${this.maxConsecutiveFailures} consecutive failures. Stopping to prevent further errors.`);
                        onMessage('assistant', 'I encountered multiple failures. The task may be blocked or require manual intervention.');
                        break;
                    }

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

                    // Handle "already exists" errors gracefully - advance task instead of looping
                    if (!result.success && reasoning.action.name === 'run_command') {
                        const errorMsg = (result.error || result.content || '').toLowerCase();
                        // If it's just a "file/directory exists" error, treat it as success and advance
                        if (errorMsg.includes('file exists') || 
                            errorMsg.includes('directory exists') ||
                            errorMsg.includes('already exists') ||
                            (errorMsg.includes('exists') && errorMsg.includes('mkdir'))) {
                            onMessage('system', `ℹ️ ${reasoning.action.arguments.command} - already exists, continuing...`);
                            reasoning.observation = 'Directory/file already exists, continuing with setup';
                            
                            // Check what the next logical step should be based on the task
                            const cmd = (reasoning.action.arguments.command || '').toLowerCase();
                            let nextStepPrompt = '';
                            
                            if (cmd.includes('mkdir') && cmd.includes('backend')) {
                                // Directory created, next should be setup (venv, install, create files)
                                nextStepPrompt = 'The backend directory already exists. Now proceed with: 1) Creating virtual environment if it doesn\'t exist, 2) Installing packages (fastapi, uvicorn), 3) Creating main.py and requirements.txt files. Skip directory creation and move to the next step.';
                            } else if (cmd.includes('venv') || cmd.includes('virtualenv')) {
                                // Venv exists, next should be install packages
                                nextStepPrompt = 'Virtual environment already exists. Proceed with installing packages (pip install fastapi uvicorn) and creating the application files.';
                            } else if (cmd.includes('pip install')) {
                                // Packages installed, next should be create files
                                nextStepPrompt = 'Packages are already installed. Now create the FastAPI application files (main.py, requirements.txt).';
                            } else {
                                nextStepPrompt = 'That step is already complete. Continue with the next logical step in the setup process.';
                            }
                            
                            messages.push({
                                role: 'user',
                                content: nextStepPrompt
                            });
                            continue;
                        }
                    }
                    
                    // Check if entire task is already complete (only for final verification steps)
                    if (!result.success && this.isTaskAlreadyComplete(result.error || result.content || '', reasoning.action)) {
                        // Only break if we've verified the project is actually complete
                        const checkResult = await this.checkIfTaskCompleteOld(messages, model, ollamaUrl);
                        if (checkResult.complete) {
                            onMessage('assistant', checkResult.summary || 'It looks like this task is already complete!');
                            break;
                        }
                        // Otherwise, continue trying
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

                // Periodic completion check (every 5 steps or on completion signal)
                if (stepCount % 5 === 0 || reasoning.next === 'complete') {
                    const completionCheck = await this.checkTaskCompletion(task, onMessage);
                    if (completionCheck.complete) {
                        onMessage('assistant', completionCheck.summary || 'Task appears to be complete!');
                        break;
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
        return thinkPhase(
            this.mcpTools,
            this.state.task,
            this.state,
            messages,
            model,
            ollamaUrl,
            onMessage
        ) as any;
    }

    /**
     * ACT Phase - Execute the action
     */
    private async actPhase(
        action: ToolCall,
        onProgress: (message: string) => void,
        onToolExecution: (toolCall: ToolCall, result: ToolResult) => void
    ): Promise<ToolResult> {
        return actPhase(this.mcpTools, action, onProgress, onToolExecution);
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
        return verifyPhase(this.mcpTools, action, onMessage);
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
${this.state.reasoning.slice(-3).map((r: ReasoningStep) =>
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
    /**
     * Detect if we're in an action loop (repeating the same actions)
     */
    private detectActionLoop(): boolean {
        if (this.recentActions.length < 4) {
            return false; // Need at least 4 actions to detect a loop
        }
        
        // Check if last 3 actions are the same
        const lastThree = this.recentActions.slice(-3).map(a => a.action);
        const allSame = lastThree.every(a => a === lastThree[0]);
        
        if (allSame) {
            return true;
        }
        
        // Check for pattern: A -> B -> A -> B (alternating loop)
        if (this.recentActions.length >= 4) {
            const lastFour = this.recentActions.slice(-4).map(a => a.action);
            if (lastFour[0] === lastFour[2] && lastFour[1] === lastFour[3] && lastFour[0] !== lastFour[1]) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * Get a unique key for an action to track repetitions
     */
    private getActionKey(action: ToolCall): string {
        if (action.name === 'run_command') {
            // Normalize command by removing variable parts
            const cmd = action.arguments.command || '';
            // Remove timestamps, random strings, etc.
            const normalized = cmd
                .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')
                .replace(/\d{2}:\d{2}:\d{2}/g, 'TIME')
                .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, 'UUID')
                .trim();
            return `run_command:${normalized.substring(0, 100)}`;
        }
        return `${action.name}:${JSON.stringify(action.arguments).substring(0, 100)}`;
    }

    /**
     * Check if task is complete by examining the codebase
     */
    private async checkTaskCompletion(task: string, onMessage: (role: string, content: string) => void): Promise<{ complete: boolean; summary?: string }> {
        const lowerTask = task.toLowerCase();
        
        // Use the helper function from reactHelpers
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const isComplete = await checkIfTaskComplete(task, workspaceRoot);
        
        if (isComplete) {
            // Generate a summary
            let summary = 'Task appears to be complete! ';
            
            if (lowerTask.includes('fastapi')) {
                summary += 'FastAPI backend structure detected (main.py and requirements.txt exist).';
            } else if (lowerTask.includes('next.js') || lowerTask.includes('nextjs')) {
                summary += 'Next.js project structure detected.';
            } else if (lowerTask.includes('react')) {
                summary += 'React project structure detected.';
            } else {
                summary += 'Required files and structure are in place.';
            }
            
            return { complete: true, summary };
        }
        
        return { complete: false };
    }

    private async checkIfTaskComplete(
        task: string
    ): Promise<boolean> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        return checkIfTaskComplete(task, workspaceRoot);
    }

    private async checkIfTaskCompleteOld(
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
        return buildReActSystemMessage(baseMessage);
    }

    private buildReActSystemMessageOld(baseMessage: string): string {
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

Available tools: ${this.toolAdapter.getToolsDescription().split('\n').slice(0, 20).join('\n')}`;
    }

    /**
     * Generate ReAct execution report
     */
    private generateReActReport(): string {
        const totalSteps = this.state.reasoning.length;
        const actionsTaken = this.state.reasoning.filter((r: ReasoningStep) => r.action).length;
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
        return isTaskAlreadyComplete(errorMessage, action);
    }

    private isTaskAlreadyCompleteOld(errorMessage: string, action: ToolCall): boolean {
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
        // Use model-driven approach instead - this is deprecated
        return null;
    }

    private extractActionFromTaskOld(task: string): ToolCall | null {
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
        return buildFrameworkGuidancePrompt(task);
    }

    private buildFrameworkGuidancePromptOld(task: string): string {
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
        return getAIResponse(messages, model, ollamaUrl, 300000);
    }
}

