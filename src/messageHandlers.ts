/**
 * Message handlers for webview communication
 * Separated from chatPanel.ts for better maintainability
 */

import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { getModels } from './ollamaClient';

export class MessageHandlers {
    private webviewReady: boolean = false;

    constructor(
        private panel: vscode.WebviewPanel,
        private chatPanel: ChatPanel,
        private getOllamaUrl: () => string,
        private getCurrentModel: () => string,
        private setCurrentModel: (model: string) => void,
        private setOllamaUrl: (url: string) => void
    ) { }

    /**
     * Handle all incoming messages from the webview
     */
    async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'sendMessage':
                await this.handleSendMessage(message.text, message.conversationId);
                return;
            case 'getModels':
                console.log('EasyCode: 📬 Webview requested models via getModels command');
                this.handleGetModels().catch(err => {
                    console.error('EasyCode: ❌ Error in handleGetModels:', err);
                });
                return;
            case 'setModel':
                this.setCurrentModel(message.model);
                await this.handleSetModel(message.model);
                return;
            case 'getOllamaUrl':
                this.panel.webview.postMessage({
                    command: 'ollamaUrl',
                    url: this.getOllamaUrl()
                });
                return;
            case 'setOllamaUrl':
                this.setOllamaUrl(message.url);
                vscode.workspace.getConfiguration('easycode').update('ollamaUrl', message.url, true);
                return;
            case 'webviewReady':
                // Webview is ready, mark it and load models now
                console.log('EasyCode: ✅✅✅ Webview is ready! Marking as ready and loading models...');
                this.webviewReady = true;
                console.log('EasyCode: webviewReady flag set to:', this.webviewReady);

                // Send a test message first to verify connection
                try {
                    this.panel.webview.postMessage({
                        command: 'status',
                        message: 'Webview connected!'
                    });
                    console.log('EasyCode: ✅ Test status message sent to webview');

                    // Also send a test models message to verify the models handler works
                    setTimeout(() => {
                        this.panel.webview.postMessage({
                            command: 'models',
                            models: ['test-model-1', 'test-model-2'],
                            currentModel: 'test-model-1',
                            error: undefined
                        });
                        console.log('EasyCode: ✅ Test models message sent to webview');
                    }, 100);
                } catch (err) {
                    console.error('EasyCode: ❌ Failed to send test message:', err);
                }

                // Load models immediately - don't wait
                setTimeout(() => {
                    this.handleGetModels().catch(err => {
                        console.error('EasyCode: ❌ Error loading models after webviewReady:', err);
                        // Still try to send error to webview
                        try {
                            this.panel.webview.postMessage({
                                command: 'models',
                                models: [],
                                currentModel: '',
                                error: err.message || 'Failed to load models'
                            });
                        } catch (postErr) {
                            console.error('EasyCode: Failed to send error to webview:', postErr);
                        }
                    });
                }, 300);
                return;
        }
    }

    /**
     * Handle sending a message (delegates to chatPanel)
     * This is a placeholder - actual implementation is in chatPanel._handleSendMessage
     */
    async handleSendMessage(text: string, conversationId: string): Promise<void> {
        // Validation only - actual handling is in chatPanel
        if (!this.getCurrentModel()) {
            const errorMsg = 'No model selected. Please select a model from the dropdown.';
            vscode.window.showErrorMessage(`EasyCode Error: ${errorMsg}`);
            this.panel.webview.postMessage({
                command: 'error',
                message: errorMsg
            });
            return;
        }
    }

    /**
     * Handle getting models from Ollama
     * Public method that can be called from ChatPanel
     */
    public async handleGetModels(): Promise<void> {
        const ollamaUrl = this.getOllamaUrl();
        console.log('EasyCode: 🔍 Fetching models from', ollamaUrl);

        // Ensure we always send a response to the webview, even on error
        const sendModelsToWebview = (models: string[], errorMsg?: string) => {
            try {
                // Check if panel is still valid
                if (!this.panel || this.panel.webview === null) {
                    console.error('EasyCode: Panel or webview is null, cannot send models');
                    return;
                }

                // If webview isn't ready yet, wait a bit and retry (but only once)
                // After that, just send anyway - the webview should handle it
                if (!this.webviewReady) {
                    console.log('EasyCode: Webview not marked ready yet, but sending models anyway (webview should handle it)');
                    // Don't block - just send the models. The webview message listener should be set up
                    // even if webviewReady hasn't been received yet
                }

                const currentModel = this.getCurrentModel();
                const message = {
                    command: 'models',
                    models: models || [],
                    currentModel: currentModel || '',
                    error: errorMsg
                };
                console.log('EasyCode: 📤 Sending models to webview:', JSON.stringify(message));
                console.log('EasyCode: Webview ready status:', this.webviewReady);

                try {
                    this.panel.webview.postMessage(message);
                    console.log('EasyCode: ✅ Successfully posted models message to webview');

                    // Also log to verify the message was actually sent
                    console.log('EasyCode: Message sent with', models.length, 'models');
                } catch (postError: any) {
                    console.error('EasyCode: Error in postMessage:', postError);
                    // Check if error is due to disposal
                    if (postError.message && postError.message.includes('disposed')) {
                        console.log('EasyCode: Webview disposed, skipping model send');
                        return;
                    }
                    throw postError;
                }
            } catch (error: any) {
                // Check if error is due to disposal
                if (error.message && error.message.includes('disposed')) {
                    console.log('EasyCode: Webview disposed, skipping model send');
                    return;
                }
                console.error('EasyCode: Error posting models to webview:', error);
                console.error('EasyCode: Error stack:', error.stack);
            }
        };

        try {
            const models = await getModels(ollamaUrl);
            console.log('EasyCode: ✅ Retrieved models:', models);

            // Set default model to first available if not set
            if (!this.getCurrentModel() && models.length > 0) {
                this.setCurrentModel(models[0]);
                console.log('EasyCode: Set default model to', models[0]);
            }

            console.log('EasyCode: Sending models to webview:', {
                modelsCount: models.length,
                currentModel: this.getCurrentModel()
            });

            // Send models to webview
            sendModelsToWebview(models);
        } catch (error: any) {
            const errorMessage = error.message || `Failed to fetch models from ${ollamaUrl}`;

            console.error('EasyCode: Error fetching models:', error);
            console.error('EasyCode: Error details:', {
                code: error.code,
                message: error.message,
                response: error.response?.status,
                url: ollamaUrl
            });

            // Show warning to user
            vscode.window.showWarningMessage(`EasyCode: ${errorMessage}`).then(() => {
                // User dismissed the warning, continue
            });

            // Always send empty models array to webview so it can show error state
            sendModelsToWebview([], errorMessage);
        }
    }

    /**
     * Handle setting the model
     */
    private async handleSetModel(model: string): Promise<void> {
        this.panel.webview.postMessage({
            command: 'modelSet',
            model
        });
    }
}

