import * as vscode from 'vscode';
import { MCPTools } from './mcpTools';
import { AdvancedOrchestrator } from './orchestration/orchestrator';
import { ReActOrchestrator } from './orchestration/reactOrchestrator';
import { getWebviewHtml } from './webviewContent';
import { gatherCodeContext } from './contextGatherer';
import { MessageHandlers } from './messageHandlers';

export class ChatPanel {
    public static readonly viewType = 'easycode.chatView';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _ollamaUrl: string = 'http://localhost:11434';
    private _currentModel: string = '';
    private _mcpTools: MCPTools;
    private _orchestrator: AdvancedOrchestrator;
    private _reactOrchestrator: ReActOrchestrator;
    private _useReAct: boolean = true; // Use ReAct by default for state-of-the-art
    private _messageHandlers: MessageHandlers;


    public constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._mcpTools = new MCPTools();
        this._orchestrator = new AdvancedOrchestrator(this._mcpTools);
        this._reactOrchestrator = new ReActOrchestrator(this._mcpTools);

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Initialize message handlers
        this._messageHandlers = new MessageHandlers(
            this._panel,
            this,
            () => this._ollamaUrl,
            () => this._currentModel,
            (model) => { this._currentModel = model; },
            (url) => { this._ollamaUrl = url; }
        );

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                // Special handling for sendMessage (needs access to orchestrators)
                if (message.command === 'sendMessage') {
                    await this._handleSendMessage(message.text, message.conversationId);
                    return;
                }
                // Delegate other messages to message handlers
                await this._messageHandlers.handleMessage(message);
            },
            null,
            this._disposables
        );

        // Load saved Ollama URL from settings
        const config = vscode.workspace.getConfiguration('easycode');
        this._ollamaUrl = config.get<string>('ollamaUrl', 'http://localhost:11434');

        // Load models after webview is ready
        // The webview will send 'webviewReady' message when it's ready
        // We also try loading models when the panel becomes visible
        this._panel.onDidChangeViewState(() => {
            // Webview is now visible, safe to send messages
            if (this._panel.visible) {
                // Small delay to ensure webview is fully initialized
                setTimeout(() => {
                    this._messageHandlers.handleGetModels();
                }, 100);
            }
        }, null, this._disposables);

        // Also try immediately (in case webview is already visible)
        // Use a longer delay to ensure webview is ready
        setTimeout(() => {
            this._messageHandlers.handleGetModels();
        }, 500);
    }

    public reveal() {
        // Try to reveal in the rightmost column
        const visibleEditors = vscode.window.visibleTextEditors;
        if (visibleEditors.length > 0) {
            const rightmostColumn = Math.max(...visibleEditors.map(e => e.viewColumn || 1));
            const targetColumn = rightmostColumn >= 2 ? vscode.ViewColumn.Three : vscode.ViewColumn.Two;
            this._panel.reveal(targetColumn);
        } else {
            this._panel.reveal(vscode.ViewColumn.Two);
        }
    }

    private async _handleSendMessage(text: string, conversationId: string) {
        // Get current model - must be set by user or from available models
        if (!this._currentModel) {
            const errorMsg = 'No model selected. Please select a model from the dropdown.';
            vscode.window.showErrorMessage(`EasyCode Error: ${errorMsg}`);
            this._panel.webview.postMessage({
                command: 'error',
                message: errorMsg
            });
            return;
        }

        const model = this._currentModel;

        try {
            // Send user message to webview first and wait a bit for it to render
            this._panel.webview.postMessage({
                command: 'addMessage',
                message: {
                    role: 'user',
                    content: text,
                    timestamp: new Date().toISOString()
                },
                conversationId
            });

            // Small delay to ensure user message renders before AI starts
            await new Promise(resolve => setTimeout(resolve, 100));

            // Get code context from open files
            const context = await gatherCodeContext();

            // Get available tools description
            const toolsDescription = this._mcpTools.getAvailableTools();

            // Build system message - Cursor-like approach
            const systemMessage = `You are an AI coding assistant similar to Cursor. You help developers write, edit, and understand code.

${toolsDescription}

${context ? `Current workspace context:\n\n${context}` : ''}

YOUR APPROACH (like Cursor):
1. **Natural Conversation**: Communicate naturally. Explain what you're doing as you work.
2. **Code-First**: Focus on reading and writing code. Most tasks involve file operations.
3. **Context Awareness**: Understand the codebase structure, dependencies, and relationships.
4. **Incremental Changes**: Make small, focused edits. Show what changed.
5. **User-Friendly**: Describe changes clearly. If making significant changes, explain why.

WORKFLOW:
- When asked to do something, start by understanding the current codebase
- Read relevant files to understand context
- Make focused, incremental changes
- Explain what you did and why
- If you need to run commands, do so, but prioritize code editing

TOOL USAGE:
- Use tools naturally as part of your workflow
- You can describe actions in natural language - the system will interpret them
- Focus on file operations (read_file, write_file, search_replace) for most tasks
- Use run_command when you need to install dependencies, run tests, or execute build commands

REMEMBER:
- Be conversational and helpful
- Explain your reasoning
- Make changes incrementally
- Verify your work
- Ask for clarification if needed`;

            // Use ReAct orchestrator for state-of-the-art execution (Reasoning + Acting)
            if (this._useReAct) {
                await this._reactOrchestrator.orchestrate(
                    text,
                    systemMessage,
                    model,
                    this._ollamaUrl,
                    (progress) => {
                        this._panel.webview.postMessage({
                            command: 'status',
                            message: progress
                        });
                    },
                    (toolCall, result) => {
                        this._panel.webview.postMessage({
                            command: 'addMessage',
                            message: {
                                role: 'system',
                                content: `🔧 ${toolCall.name}: ${result.success ? '✓' : '✗'} ${result.error || (result.content ? result.content.substring(0, 100) : '')}`,
                                timestamp: new Date().toISOString()
                            },
                            conversationId
                        });
                    },
                    (role, content) => {
                        this._panel.webview.postMessage({
                            command: 'addMessage',
                            message: {
                                role,
                                content,
                                timestamp: new Date().toISOString()
                            },
                            conversationId
                        });
                    }
                );
            } else {
                // Fallback to advanced orchestrator
                await this._orchestrator.orchestrate(
                    text,
                    systemMessage,
                    model,
                    this._ollamaUrl,
                    (progress) => {
                        this._panel.webview.postMessage({
                            command: 'status',
                            message: progress
                        });
                    },
                    (toolCall, result) => {
                        this._panel.webview.postMessage({
                            command: 'addMessage',
                            message: {
                                role: 'system',
                                content: `🔧 ${toolCall.name}: ${result.success ? '✓' : '✗'} ${result.error || (result.content ? result.content.substring(0, 100) : '')}`,
                                timestamp: new Date().toISOString()
                            },
                            conversationId
                        });
                    },
                    (role, content) => {
                        this._panel.webview.postMessage({
                            command: 'addMessage',
                            message: {
                                role,
                                content,
                                timestamp: new Date().toISOString()
                            },
                            conversationId
                        });
                    }
                );
            }
        } catch (error: any) {
            let errorMessage = error.message;

            if (error.response?.status === 404) {
                errorMessage = `Ollama API not found at ${this._ollamaUrl}. Make sure Ollama is running. Install from https://ollama.ai if needed.`;
            } else if (error.code === 'ECONNREFUSED') {
                errorMessage = `Cannot connect to Ollama at ${this._ollamaUrl}. Make sure Ollama is running (try: ollama serve).`;
            } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
                errorMessage = `Cannot resolve host for ${this._ollamaUrl}. Check your Ollama URL in settings.`;
            } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED' || error.message.includes('timeout') || error.name === 'TimeoutError' || error.name === 'AbortError') {
                errorMessage = `Request timed out after 5 minutes. The model "${model}" may be too large or slow. Try a smaller model or check if Ollama is processing the request.`;
            } else if (error.response?.status === 400) {
                errorMessage = `Invalid request to Ollama. Model "${model}" might not be available. Try selecting a different model.`;
            } else if (error.response?.status) {
                errorMessage = `Ollama returned error ${error.response.status}: ${error.response.data?.error || error.message}`;
            }

            console.error('EasyCode: Error sending message:', error);
            vscode.window.showErrorMessage(`EasyCode Error: ${errorMessage}`);

            // Always reset loading state on error
            this._panel.webview.postMessage({
                command: 'error',
                message: errorMessage
            });
        }
    }

    private async _executeRecursiveConversation(
        userMessage: string,
        systemMessage: string,
        model: string,
        conversationId: string,
        maxIterations: number = 10
    ): Promise<void> {
        const messages: any[] = [
            { role: 'system', content: systemMessage },
            { role: 'user', content: userMessage }
        ];

        let iteration = 0;

        while (iteration < maxIterations) {
            iteration++;

            // Update status
            this._panel.webview.postMessage({
                command: 'status',
                message: `Processing... (iteration ${iteration}/${maxIterations})`
            });

            try {
                // Call Ollama API using ollamaClient
                const { getAIResponse } = await import('./ollamaClient');
                const assistantResponse = await getAIResponse(messages, model, this._ollamaUrl, 300000);

                messages.push({ role: 'assistant', content: assistantResponse });

                // Parse tool calls from response
                let toolCalls = this._mcpTools.parseToolCalls(assistantResponse);

                // If no tool calls found, try to extract commands from the response text
                // This helps when AI describes commands instead of using tool format
                if (toolCalls.length === 0) {
                    // Check if the response mentions common actions that should trigger tools
                    const actionKeywords = [
                        /(?:create|make|write|add)\s+(?:a\s+)?(?:new\s+)?(?:file|directory|folder)/i,
                        /(?:run|execute|run_command)\s*\(/i,
                        /```(?:shell|bash|sh)/i,
                        /(?:npm|yarn|pnpm|mkdir|cd|git)\s+/i
                    ];

                    const hasActionKeywords = actionKeywords.some(pattern => pattern.test(assistantResponse));

                    if (hasActionKeywords) {
                        // Try one more aggressive parse
                        toolCalls = this._mcpTools.parseToolCalls(assistantResponse);
                    }
                }

                // If still no tool calls, check if we should prompt for action
                if (toolCalls.length === 0) {
                    // Check if this looks like a task that needs execution
                    const taskKeywords = /(?:let'?s|we should|I'll|I will|now|next|step|create|run|install|build|start)/i;
                    if (taskKeywords.test(assistantResponse) && iteration === 1) {
                        // First iteration with task keywords but no tools - prompt AI to use tools
                        messages.push({
                            role: 'user',
                            content: 'Please use the available tools to actually perform the actions you described. Use <tool_call> format or execute the commands directly.'
                        });
                        continue; // Continue loop to get tool-using response
                    }

                    // Extract text without tool calls for display
                    const displayContent = assistantResponse.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();

                    this._panel.webview.postMessage({
                        command: 'addMessage',
                        message: {
                            role: 'assistant',
                            content: displayContent || assistantResponse,
                            timestamp: new Date().toISOString()
                        },
                        conversationId
                    });

                    this._panel.webview.postMessage({
                        command: 'status',
                        message: 'Ready'
                    });
                    return;
                }

                // Execute tool calls
                let toolResults = '';
                for (const toolCall of toolCalls) {
                    this._panel.webview.postMessage({
                        command: 'status',
                        message: `Executing tool: ${toolCall.name}...`
                    });

                    const result = await this._mcpTools.executeTool(toolCall);
                    toolResults += `\n\nTool: ${toolCall.name}\n`;
                    if (result.success) {
                        toolResults += `Result: ${result.content}`;
                    } else {
                        toolResults += `Error: ${result.error}`;
                    }
                }

                // Add tool results to conversation and continue
                messages.push({
                    role: 'user',
                    content: `Tool execution results:${toolResults}\n\nPlease continue with your task. If you need to make more changes, use tools again. Otherwise, provide a summary of what was accomplished.`
                });

                // Show tool execution in chat
                this._panel.webview.postMessage({
                    command: 'addMessage',
                    message: {
                        role: 'assistant',
                        content: assistantResponse,
                        timestamp: new Date().toISOString()
                    },
                    conversationId
                });

                this._panel.webview.postMessage({
                    command: 'addMessage',
                    message: {
                        role: 'system',
                        content: `🔧 Tool execution:${toolResults}`,
                        timestamp: new Date().toISOString()
                    },
                    conversationId
                });

            } catch (error: any) {
                let errorMessage = error.message;

                if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                    errorMessage = `Request timed out. The model may be too slow.`;
                }

                this._panel.webview.postMessage({
                    command: 'error',
                    message: errorMessage
                });
                return;
            }
        }

        // Max iterations reached
        this._panel.webview.postMessage({
            command: 'addMessage',
            message: {
                role: 'assistant',
                content: 'Maximum iterations reached. The task may require more steps or there may be an issue.',
                timestamp: new Date().toISOString()
            },
            conversationId
        });

        this._panel.webview.postMessage({
            command: 'status',
            message: 'Ready'
        });
    }

    private async _handleGetModels() {
        try {
            const { getModels } = await import('./ollamaClient');
            const models = await getModels(this._ollamaUrl);


            // Set default model to first available if not set
            if (!this._currentModel && models.length > 0) {
                this._currentModel = models[0];
            }

            // Ensure webview is ready before sending
            try {
                this._panel.webview.postMessage({
                    command: 'models',
                    models,
                    currentModel: this._currentModel
                });
                console.log('EasyCode: Sent models to webview:', models.length, 'models');
            } catch (error) {
                console.error('EasyCode: Error posting models to webview:', error);
                // Retry after a delay
                setTimeout(() => {
                    this._panel.webview.postMessage({
                        command: 'models',
                        models,
                        currentModel: this._currentModel
                    });
                }, 500);
            }
        } catch (error: any) {
            let errorMessage = `Failed to fetch models: ${error.message}`;

            if (error.response?.status === 404) {
                errorMessage = `Ollama API not found at ${this._ollamaUrl}. Make sure Ollama is running. Install from https://ollama.ai if needed.`;
            } else if (error.code === 'ECONNREFUSED') {
                errorMessage = `Cannot connect to Ollama at ${this._ollamaUrl}. Make sure Ollama is running (try: ollama serve).`;
            } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
                errorMessage = `Cannot resolve host for ${this._ollamaUrl}. Check your Ollama URL in settings.`;
            } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
                errorMessage = `Connection to Ollama timed out. Make sure Ollama is running at ${this._ollamaUrl}.`;
            }

            console.error('EasyCode: Error fetching models:', error);
            vscode.window.showWarningMessage(`EasyCode: ${errorMessage}`);
            this._panel.webview.postMessage({
                command: 'error',
                message: errorMessage
            });
            // Show empty models list with error message
            try {
                this._panel.webview.postMessage({
                    command: 'models',
                    models: [],
                    currentModel: ''
                });
            } catch (error) {
                console.error('EasyCode: Error posting empty models to webview:', error);
            }
        }
    }

    private async _handleSetModel(model: string) {
        this._panel.webview.postMessage({
            command: 'modelSet',
            model
        });
    }


    public dispose() {
        // Clean up our resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return getWebviewHtml();
    }
}
