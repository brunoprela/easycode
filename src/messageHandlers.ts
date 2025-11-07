/**
 * Message handlers for webview communication
 * Separated from chatPanel.ts for better maintainability
 */

import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { getModels } from './ollamaClient';

export class MessageHandlers {
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
                await this.handleGetModels();
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
                // Webview is ready, load models now
                console.log('EasyCode: Webview is ready, loading models...');
                await this.handleGetModels();
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
     */
    async handleGetModels(): Promise<void> {
        const ollamaUrl = this.getOllamaUrl();
        console.log('EasyCode: Fetching models from', ollamaUrl);
        try {
            const models = await getModels(ollamaUrl);
            console.log('EasyCode: Retrieved models:', models);

            // Set default model to first available if not set
            if (!this.getCurrentModel() && models.length > 0) {
                this.setCurrentModel(models[0]);
                console.log('EasyCode: Set default model to', models[0]);
            }

            const currentModel = this.getCurrentModel();
            console.log('EasyCode: Sending models to webview:', {
                modelsCount: models.length,
                currentModel: currentModel
            });

            // Ensure webview is ready before sending
            try {
                this.panel.webview.postMessage({
                    command: 'models',
                    models: models || [],
                    currentModel: currentModel || ''
                });
                console.log('EasyCode: Successfully sent models to webview');
            } catch (error) {
                console.error('EasyCode: Error posting models to webview:', error);
                // Retry after a delay
                setTimeout(() => {
                    try {
                        this.panel.webview.postMessage({
                            command: 'models',
                            models: models || [],
                            currentModel: currentModel || ''
                        });
                        console.log('EasyCode: Retry - sent models to webview');
                    } catch (retryError) {
                        console.error('EasyCode: Retry also failed:', retryError);
                    }
                }, 500);
            }
        } catch (error: any) {
            const errorMessage = error.message || `Failed to fetch models from ${ollamaUrl}`;

            console.error('EasyCode: Error fetching models:', error);
            vscode.window.showWarningMessage(`EasyCode: ${errorMessage}`);
            this.panel.webview.postMessage({
                command: 'error',
                message: errorMessage
            });
            // Show empty models list with error message
            try {
                this.panel.webview.postMessage({
                    command: 'models',
                    models: [],
                    currentModel: ''
                });
            } catch (error) {
                console.error('EasyCode: Error posting empty models to webview:', error);
            }
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

