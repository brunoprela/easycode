/**
 * Webview HTML/CSS/JS content generation
 * Separated from chatPanel.ts for better maintainability
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const styles = getStyles();
    const script = getScript();

    // Write script to a file and use external script tag to avoid document.write() parsing issues
    const scriptUri = writeScriptFile(webview, extensionUri, script);

    // Build HTML using string concatenation to avoid template literal nesting issues
    return '<!DOCTYPE html>\n' +
        '<html lang="en">\n' +
        '<head>\n' +
        '    <meta charset="UTF-8">\n' +
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
        '    <title>EasyCode Chat</title>\n' +
        '    <style>\n' +
        '        ' + styles + '\n' +
        '    </style>\n' +
        '</head>\n' +
        '<body>\n' +
        '    <div class="header">\n' +
        '        <div class="header-left">\n' +
        '            <div class="model-selector">\n' +
        '                <label for="model-select">Model</label>\n' +
        '                <select id="model-select">\n' +
        '                    <option value="">Loading models...</option>\n' +
        '                </select>\n' +
        '            </div>\n' +
        '        </div>\n' +
        '        <div class="status" id="status">Ready</div>\n' +
        '    </div>\n' +
        '\n' +
        '    <div class="chat-container" id="chat-container">\n' +
        '        <div class="empty-state">\n' +
        '            <h3>EasyCode Chat</h3>\n' +
        '            <p>Start a conversation with your local AI assistant</p>\n' +
        '        </div>\n' +
        '    </div>\n' +
        '\n' +
        '    <div class="input-container">\n' +
        '        <div class="input-wrapper">\n' +
        '            <textarea \n' +
        '                id="message-input" \n' +
        '                placeholder="Type your message here... (Shift+Enter for new line)"\n' +
        '                rows="1"\n' +
        '            ></textarea>\n' +
        '            <button id="send-button">Send</button>\n' +
        '        </div>\n' +
        '    </div>\n' +
        '\n' +
        '    <script src="' + scriptUri.toString() + '"></script>\n' +
        '</body>\n' +
        '</html>';
}

function writeScriptFile(webview: vscode.Webview, extensionUri: vscode.Uri, scriptContent: string): vscode.Uri {
    // Create a script file in the extension's out directory
    const scriptUri = vscode.Uri.joinPath(extensionUri, 'out', 'webview-script.js');
    const scriptPath = scriptUri.fsPath;

    // Ensure the directory exists
    const scriptDir = path.dirname(scriptPath);
    if (!fs.existsSync(scriptDir)) {
        fs.mkdirSync(scriptDir, { recursive: true });
    }

    // Write the script content to the file
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');

    // Return the webview URI for the script file
    return webview.asWebviewUri(scriptUri);
}

function getStyles(): string {
    return `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Helvetica Neue', sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-size: 14px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

.header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--vscode-panel-background);
    min-height: 44px;
}

.header-left {
    display: flex;
    align-items: center;
    gap: 16px;
}

.model-selector {
    display: flex;
    align-items: center;
    gap: 8px;
}

.model-selector label {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-weight: 500;
}

select {
    padding: 6px 10px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.2s;
}

select:hover {
    border-color: var(--vscode-focusBorder);
}

select:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
}

.status {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 4px 8px;
    background: var(--vscode-input-background);
    border-radius: 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 400;
    letter-spacing: 0.01em;
}

.status.thinking {
    color: var(--vscode-textLink-foreground);
}

.status.thinking::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--vscode-textLink-foreground);
    animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}

.chat-container {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    scroll-behavior: smooth;
}

.message {
    display: flex;
    gap: 10px;
    max-width: 85%;
    animation: fadeIn 0.25s ease-out;
    position: relative;
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}

.message.user {
    align-self: flex-end;
    flex-direction: row-reverse;
}

.message.assistant {
    align-self: flex-start;
}

.message-avatar {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 500;
    flex-shrink: 0;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.message.user .message-avatar {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    color: white;
}

.message.assistant .message-avatar {
    background: linear-gradient(135deg, #ec4899 0%, #f43f5e 100%);
    color: white;
}

.message.system .message-avatar {
    background: var(--vscode-textBlockQuote-background);
    color: var(--vscode-textBlockQuote-border);
    font-size: 18px;
}

.message-content {
    padding: 12px 16px;
    border-radius: 8px;
    line-height: 1.65;
    word-wrap: break-word;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    font-size: 14px;
}

.message.user .message-content {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-radius: 8px 8px 2px 8px;
    font-weight: 400;
}

.message.assistant .message-content {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px 8px 8px 2px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.message.system {
    align-self: center;
    max-width: 95%;
    margin: 8px 0;
}

.message.system .message-content {
    background: var(--vscode-textBlockQuote-background);
    color: var(--vscode-textBlockQuote-foreground);
    border: 1px solid var(--vscode-textBlockQuote-border);
    font-size: 12px;
    padding: 10px 14px;
    border-radius: 8px;
    opacity: 0.9;
}

.message-content pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 16px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 12px 0;
    border: 1px solid var(--vscode-panel-border);
    font-size: 13px;
    line-height: 1.6;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.05);
    position: relative;
}

.message-content pre code {
    display: block;
    white-space: pre;
    overflow-x: auto;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', 'Droid Sans Mono', 'Courier New', monospace;
}

.message-content code {
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', 'Droid Sans Mono', 'Courier New', monospace;
    font-size: 13px;
}

.message-content pre code {
    background: transparent;
    padding: 0;
    border: none;
    color: var(--vscode-editor-foreground);
}

.message-content code:not(pre code) {
    background: var(--vscode-textCodeBlock-background);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--vscode-textLink-foreground);
}

.thinking-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    font-style: italic;
    padding: 6px 10px;
    background: var(--vscode-input-background);
    border-radius: 6px;
    border: 1px solid var(--vscode-panel-border);
    opacity: 0.85;
}

.thinking-dots {
    display: inline-flex;
    gap: 4px;
}

.thinking-dots span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-textLink-foreground);
    animation: thinkingDot 1.4s ease-in-out infinite;
}

.thinking-dots span:nth-child(1) { animation-delay: 0s; }
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes thinkingDot {
    0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
    30% { opacity: 1; transform: scale(1); }
}

.command-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    padding: 5px 9px;
    background: var(--vscode-textBlockQuote-background);
    border: 1px solid var(--vscode-textBlockQuote-border);
    border-radius: 5px;
    margin: 3px 0;
    font-weight: 400;
    letter-spacing: 0.01em;
}

.command-indicator.success {
    border-color: var(--vscode-testing-iconPassed);
    color: var(--vscode-testing-iconPassed);
}

.command-indicator.error {
    border-color: var(--vscode-testing-iconFailed);
    color: var(--vscode-testing-iconFailed);
}

.input-container {
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-panel-background);
}

.input-wrapper {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    max-width: 100%;
}

textarea {
    flex: 1;
    padding: 10px 14px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 8px;
    resize: none;
    font-family: inherit;
    font-size: 14px;
    min-height: 44px;
    max-height: 200px;
    line-height: 1.5;
    transition: border-color 0.15s, box-shadow 0.15s;
}

textarea:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}

textarea::placeholder {
    color: var(--vscode-input-placeholderForeground);
}

button {
    padding: 10px 18px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.15s;
    min-width: 72px;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 44px;
}

button:hover:not(:disabled) {
    opacity: 0.9;
    transform: translateY(-1px);
}

button:active:not(:disabled) {
    transform: translateY(0);
}

button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.loading {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 12px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding: 40px 20px;
}

.empty-state h3 {
    font-size: 18px;
    font-weight: 500;
    color: var(--vscode-foreground);
    margin-bottom: 6px;
    letter-spacing: -0.01em;
}

.empty-state p {
    font-size: 13px;
    opacity: 0.7;
    font-weight: 400;
}

.chat-container::-webkit-scrollbar {
    width: 8px;
}

.chat-container::-webkit-scrollbar-track {
    background: transparent;
}

.chat-container::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 4px;
}

.chat-container::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
}

.message-content p {
    margin: 10px 0;
    line-height: 1.7;
}

.message-content p:first-child {
    margin-top: 0;
}

.message-content p:last-child {
    margin-bottom: 0;
}

.message-content h1, .message-content h2, .message-content h3 {
    margin: 16px 0 12px 0;
    font-weight: 600;
    line-height: 1.4;
}

.message-content h1 {
    font-size: 20px;
}

.message-content h2 {
    font-size: 18px;
}

.message-content h3 {
    font-size: 16px;
}

.message-content ul, .message-content ol {
    margin: 10px 0;
    padding-left: 24px;
}

.message-content li {
    margin: 6px 0;
    line-height: 1.6;
}

.message-content strong {
    font-weight: 600;
}

.message-content em {
    font-style: italic;
}

.message-content a {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
}

.message-content a:hover {
    text-decoration: underline;
}`;
}

function getScript(): string {
    return String.raw`(function() {
console.log('Webview: 🚀 Script starting...');
const vscode = acquireVsCodeApi();
const chatContainer = document.getElementById('chat-container');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const modelSelect = document.getElementById('model-select');
const status = document.getElementById('status');

console.log('Webview: Elements found:', {
    chatContainer: !!chatContainer,
    messageInput: !!messageInput,
    sendButton: !!sendButton,
    modelSelect: !!modelSelect,
    status: !!status
});

let conversationId = 'default';
let currentModel = '';
let isLoading = false;

// Handle messages from extension - SET UP FIRST before sending webviewReady!
console.log('Webview: Setting up message listener...');
console.log('Webview: window.addEventListener exists?', typeof window.addEventListener);
window.addEventListener('message', event => {
    const message = event.data;
    console.log('Webview: 📨📨📨 RECEIVED MESSAGE FROM EXTENSION! 📨📨📨');
    console.log('Webview: Message command:', message.command);
    console.log('Webview: Full message:', message);
    console.log('Webview: Full event data:', JSON.stringify(event.data));
    
    // Ensure we have a valid message
    if (!message || !message.command) {
        console.warn('Webview: Received invalid message:', message);
        return;
    }
    
    switch (message.command) {
        case 'addMessage':
            addMessage(message.message);
            break;
        case 'updateLastAssistantMessage':
            updateLastAssistantMessage(message.content);
            break;
        case 'models':
            console.log('Webview: ✅✅✅ RECEIVED MODELS COMMAND! ✅✅✅');
            console.log('Webview: Full message:', JSON.stringify(message));
            console.log('Webview: Models array:', message.models);
            console.log('Webview: Models array type:', typeof message.models, Array.isArray(message.models));
            console.log('Webview: Current model:', message.currentModel);
            console.log('Webview: Error:', message.error);
            console.log('Webview: modelSelect element:', modelSelect);
            console.log('Webview: modelSelect exists?', !!modelSelect);
            
            // Clear any loading timeout
            if (window.modelsLoadingTimeout) {
                clearTimeout(window.modelsLoadingTimeout);
                window.modelsLoadingTimeout = null;
                console.log('Webview: Cleared loading timeout');
            }
            
            // Check if modelSelect exists
            if (!modelSelect) {
                console.error('Webview: ❌❌❌ modelSelect element not found!');
                // Try to get it again
                modelSelect = document.getElementById('model-select');
                if (!modelSelect) {
                    console.error('Webview: ❌ Still cannot find modelSelect after retry!');
                    return;
                }
                console.log('Webview: ✅ Found modelSelect on retry');
            }
            
            if (!message.models) {
                console.error('Webview: Models message received but models array is undefined');
                // Still show error message
                modelSelect.innerHTML = '';
                const errorOption = document.createElement('option');
                errorOption.value = '';
                errorOption.textContent = 'Error: No models data received';
                modelSelect.appendChild(errorOption);
                console.log('Webview: Added error option to dropdown');
                break;
            }
            
            // Clear existing options
            console.log('Webview: Clearing modelSelect, current innerHTML:', modelSelect.innerHTML);
            modelSelect.innerHTML = '';
            console.log('Webview: Cleared modelSelect innerHTML, new innerHTML:', modelSelect.innerHTML);
            
            if (message.models.length > 0) {
                console.log('Webview: Adding', message.models.length, 'models to dropdown');
                message.models.forEach(function(model, index) {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    modelSelect.appendChild(option);
                    console.log('Webview: ✅ Added model option', index + 1, ':', model);
                });
                
                console.log('Webview: Total options after adding:', modelSelect.options.length);
                console.log('Webview: modelSelect.innerHTML after adding:', modelSelect.innerHTML);
                
                // Use currentModel from extension, or first model as fallback
                currentModel = message.currentModel || message.models[0];
                if (currentModel) {
                    modelSelect.value = currentModel;
                    console.log('Webview: ✅ Selected model:', currentModel);
                    console.log('Webview: modelSelect.value after setting:', modelSelect.value);
                    console.log('Webview: modelSelect.selectedIndex:', modelSelect.selectedIndex);
                    // Notify extension of the selected model
                    vscode.postMessage({
                        command: 'setModel',
                        model: currentModel
                    });
                } else {
                    console.warn('Webview: No current model set, using first model');
                    currentModel = message.models[0];
                    modelSelect.value = currentModel;
                    vscode.postMessage({
                        command: 'setModel',
                        model: currentModel
                    });
                }
                
                // Force a visual update
                console.log('Webview: Final modelSelect state:');
                console.log('  - innerHTML:', modelSelect.innerHTML);
                console.log('  - value:', modelSelect.value);
                console.log('  - selectedIndex:', modelSelect.selectedIndex);
                console.log('  - options.length:', modelSelect.options.length);
            } else {
                console.warn('Webview: No models available');
                const option = document.createElement('option');
                option.value = '';
                // Show error message if provided, otherwise generic message
                if (message.error) {
                    // Truncate long error messages
                    const shortError = message.error.length > 60 
                        ? message.error.substring(0, 57) + '...' 
                        : message.error;
                    option.textContent = 'Error: ' + shortError;
                } else {
                    option.textContent = 'No models found - check Ollama is running';
                }
                modelSelect.appendChild(option);
                console.log('Webview: Added empty models option');
            }
            console.log('Webview: ✅✅✅ FINISHED PROCESSING MODELS COMMAND ✅✅✅');
            break;
        case 'error':
            setLoading(false);
            status.textContent = 'Error: ' + message.message;
            break;
        case 'status':
            // Update status without changing loading state
            const statusText = message.message || 'Ready';
            status.textContent = statusText;
            console.log('Webview: Status updated to:', statusText);
            if (statusText.toLowerCase().includes('thinking') || statusText.toLowerCase().includes('processing')) {
                status.className = 'status thinking';
            } else {
                status.className = 'status';
            }
            break;
        case 'ollamaUrl':
            status.textContent = 'Connected to ' + message.url;
            break;
    }
});
console.log('Webview: ✅ Message listener set up');

// Notify extension that webview is ready - AFTER message listener is set up!
console.log('Webview: 📢 Sending webviewReady message');
console.log('Webview: modelSelect element exists:', !!modelSelect);
console.log('Webview: modelSelect element:', modelSelect);
console.log('Webview: modelSelect.innerHTML:', modelSelect ? modelSelect.innerHTML : 'N/A');

// Verify message listener is actually set up
console.log('Webview: Message listener registered:', typeof window.addEventListener === 'function');

vscode.postMessage({ command: 'webviewReady' });
console.log('Webview: ✅ webviewReady message sent');

// Add a fallback: if no models received after 3 seconds, try to manually update
setTimeout(() => {
    const firstOption = modelSelect.options[0];
    if (firstOption && firstOption.textContent === 'Loading models...') {
        console.warn('Webview: ⚠️ Fallback triggered - no models received after 3 seconds');
        console.warn('Webview: Attempting to request models again...');
        vscode.postMessage({ command: 'getModels' });
    }
}, 3000);

// Request Ollama URL on load
vscode.postMessage({ command: 'getOllamaUrl' });

// Request models on load (extension will load them automatically, but request as backup)
console.log('Webview: Requesting models via getModels command');
vscode.postMessage({ command: 'getModels' });

// Set a timeout to show error if no response after 5 seconds
window.modelsLoadingTimeout = setTimeout(() => {
    console.warn('Webview: Timeout waiting for models response');
    // Check if still showing "Loading models..."
    const firstOption = modelSelect.options[0];
    if (firstOption && firstOption.textContent === 'Loading models...') {
        modelSelect.innerHTML = '';
        const errorOption = document.createElement('option');
        errorOption.value = '';
        errorOption.textContent = 'Error: Timeout loading models - check Ollama is running';
        modelSelect.appendChild(errorOption);
    }
}, 5000);

// Auto-resize textarea
messageInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
});

// Define sendMessage function first
function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || isLoading) {
        console.log('Cannot send: text=' + text + ', isLoading=' + isLoading);
        return;
    }

    console.log('Sending message:', text);

    // Clear input
    messageInput.value = '';
    messageInput.style.height = 'auto';

    // Remove empty state
    const emptyState = chatContainer.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }

    // Send message
    vscode.postMessage({
        command: 'sendMessage',
        text: text,
        conversationId: conversationId
    });

    setLoading(true);
}

// Handle Enter key (Shift+Enter for new line)
messageInput.addEventListener('keydown', function(e) {
    console.log('Keydown event:', e.key, 'shiftKey:', e.shiftKey, 'isComposing:', e.isComposing);
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        sendMessage();
        return false;
    }
}, true); // Use capture phase

sendButton.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    console.log('Send button clicked');
    sendMessage();
});

function setLoading(loading) {
    isLoading = loading;
    sendButton.disabled = loading;
    if (loading) {
        sendButton.innerHTML = '<div class="loading"></div>';
        status.textContent = 'Thinking...';
        status.className = 'status thinking';
        showThinking();
    } else {
        sendButton.textContent = 'Send';
        status.textContent = 'Ready';
        status.className = 'status';
        removeThinking();
    }
}

function updateLastAssistantMessage(content) {
    // Find the last assistant message
    const messages = chatContainer.querySelectorAll('.message.assistant');
    if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        const contentDiv = lastMessage.querySelector('.message-content');
        if (contentDiv) {
            // Format and update the content
            const formatted = formatMessageContent(content);
            contentDiv.innerHTML = formatted;
            // Scroll to bottom
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
    } else {
        // No assistant message yet, create one
        addMessage({ role: 'assistant', content: content });
    }
}

function formatMessageContent(content) {
    // Same formatting logic as in addMessage, but just return the formatted HTML
    let formattedContent = String(content || '');
    const codeBlockPlaceholders = [];
    const backtickChar = String.fromCharCode(96);
    const backslash = String.fromCharCode(92);
    const escapedBacktick = backslash + backtickChar;
    const tripleEscapedBacktick = escapedBacktick + escapedBacktick + escapedBacktick;
    const codeBlockPattern = tripleEscapedBacktick + '(\\\\w+)?\\\\n([\\\\s\\\\S]*?)\\\\n' + tripleEscapedBacktick;
    const codeBlockRegex = new RegExp(codeBlockPattern, 'g');
    formattedContent = formattedContent.replace(codeBlockRegex, function(match, lang, code) {
        const escapedCode = code
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const placeholder = '__CODE_BLOCK_' + codeBlockPlaceholders.length + '__';
        codeBlockPlaceholders.push('<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' + escapedCode + '</code></pre>');
        return placeholder;
    });
    
    formattedContent = formattedContent.replace(/^### (.*)$/gm, '<h3>$1</h3>');
    formattedContent = formattedContent.replace(/^## (.*)$/gm, '<h2>$1</h2>');
    formattedContent = formattedContent.replace(/^# (.*)$/gm, '<h1>$1</h1>');
    
    formattedContent = formattedContent.replace(/^[\*\-] (.+)$/gm, '<li>$1</li>');
    const listItemPattern = new RegExp('(<li>.*?</li>(?:\\n|\\r\\n|\\n\\r)?)+', 'g');
    formattedContent = formattedContent.replace(listItemPattern, function(match) {
        const newlinePattern = new RegExp('\\n|\\r\\n|\\n\\r', 'g');
        return '<ul>' + match.replace(newlinePattern, '') + '</ul>';
    });
    
    formattedContent = formattedContent.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const italicPattern = new RegExp('\\*(.+?)\\*', 'g');
    formattedContent = formattedContent.replace(italicPattern, '<em>$1</em>');
    
    // Restore code blocks
    codeBlockPlaceholders.forEach(function(block, index) {
        formattedContent = formattedContent.replace('__CODE_BLOCK_' + index + '__', block);
    });
    
    // Convert newlines to <br>
    formattedContent = formattedContent.replace(/\n/g, '<br>');
    
    return formattedContent;
}

function addMessage(message) {
    // Remove empty state if it exists
    const emptyState = chatContainer.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    
    // If this is an assistant message and there's already one, update it instead
    if (message.role === 'assistant') {
        const lastAssistantMessage = chatContainer.querySelector('.message.assistant:last-child');
        if (lastAssistantMessage) {
            // Update the last assistant message instead of creating a new one
            updateLastAssistantMessage(message.content);
            return;
        }
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message ' + message.role;
    
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    
    // Cursor-like avatars
    if (message.role === 'user') {
        avatar.textContent = '👤';
    } else if (message.role === 'system') {
        // System messages show different icons based on content
        const content = String(message.content || '').toLowerCase();
        if (content.includes('✓') || content.includes('success')) {
            avatar.textContent = '✓';
        } else if (content.includes('✗') || content.includes('failed') || content.includes('error')) {
            avatar.textContent = '✗';
        } else if (content.includes('thinking') || content.includes('thought')) {
            avatar.textContent = '💭';
        } else if (content.includes('tool') || content.includes('execut')) {
            avatar.textContent = '🔧';
        } else {
            avatar.textContent = '⚙️';
        }
    } else {
        avatar.textContent = '🤖';
    }
    
    const content = document.createElement('div');
    content.className = 'message-content';
    
    // Format message content (support markdown/code blocks)
    let formattedContent = String(message.content || '');
    
    // Store code blocks temporarily with placeholders
    const codeBlockPlaceholders = [];
    
    // Step 1: Extract and protect code blocks (triple backtick + lang + newline + code + newline + triple backtick)
    // Use a simpler approach: match code blocks using a regex that doesn't require complex escaping
    // Since we're in a template string, we need to be careful with backticks
    // Declare these once at the top of the function to avoid duplicate declarations
    const backtickChar = String.fromCharCode(96);
    // For regex pattern, we need escaped backtick to match a literal backtick
    // We construct this using String.fromCharCode to avoid template string issues
    const backslash = String.fromCharCode(92);
    const escapedBacktick = backslash + backtickChar;
    const tripleEscapedBacktick = escapedBacktick + escapedBacktick + escapedBacktick;
    // Pattern: triple backtick + optional lang + newline + code + newline + triple backtick
    // We need to escape backslashes in the pattern string so they become literal backslashes in the regex
    // For w, we need double-backslash-w within the string (becomes single-backslash-w within regex)
    // For n, we need double-backslash-n within the string (becomes single-backslash-n within regex)
    // For s and S, we need double-backslash-s and double-backslash-S within the string
    const codeBlockPattern = tripleEscapedBacktick + '(\\\\w+)?\\\\n([\\\\s\\\\S]*?)\\\\n' + tripleEscapedBacktick;
    const codeBlockRegex = new RegExp(codeBlockPattern, 'g');
    formattedContent = formattedContent.replace(codeBlockRegex, function(match, lang, code) {
        // Escape HTML in code content
        const escapedCode = code
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const placeholder = '__CODE_BLOCK_' + codeBlockPlaceholders.length + '__';
        codeBlockPlaceholders.push('<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' + escapedCode + '</code></pre>');
        return placeholder;
    });
    
    // Step 2: Handle markdown headers (only process if not inside code blocks)
    formattedContent = formattedContent.replace(/^### (.*)$/gm, '<h3>$1</h3>');
    formattedContent = formattedContent.replace(/^## (.*)$/gm, '<h2>$1</h2>');
    formattedContent = formattedContent.replace(/^# (.*)$/gm, '<h1>$1</h1>');
    
    // Step 3: Handle markdown lists (only process if not inside code blocks)
    formattedContent = formattedContent.replace(/^[\*\-] (.+)$/gm, '<li>$1</li>');
    // Wrap consecutive list items in <ul>
    // Use RegExp constructor to avoid backslash escaping issues
    const listItemPattern = new RegExp('(<li>.*?</li>(?:\\n|\\r\\n|\\n\\r)?)+', 'g');
    formattedContent = formattedContent.replace(listItemPattern, function(match) {
        const newlinePattern = new RegExp('\\n|\\r\\n|\\n\\r', 'g');
        return '<ul>' + match.replace(newlinePattern, '') + '</ul>';
    });
    
    // Step 4: Handle markdown bold and italic
    formattedContent = formattedContent.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Use RegExp constructor to avoid comment parsing issues with /* pattern
    const italicPattern = new RegExp('\\*(.+?)\\*', 'g');
    formattedContent = formattedContent.replace(italicPattern, '<em>$1</em>');
    
    // Step 5: Handle inline code (but not inside code blocks)
    // Use a simpler regex that matches backtick-wrapped content
    // We'll match the pattern: backtick + content + backtick
    // Since we're in a template string, we construct the pattern carefully
    // Reuse backslash and backtickChar declared above
    // Escape backtick for use outside character class
    const escapedBacktickInline = backslash + backtickChar;
    // For character class [^X], we can use the backtick directly (no escape needed in char class)
    // Store it in a variable to avoid issues with template string
    const charClassBacktick = backtickChar;
    // Pattern matches: escaped backtick, then [^backtick]+, then escaped backtick
    const inlineCodePattern = escapedBacktickInline + '([^' + charClassBacktick + ']+)' + escapedBacktickInline;
    const inlineCodeRegex = new RegExp(inlineCodePattern, 'g');
    formattedContent = formattedContent.replace(inlineCodeRegex, '<code>$1</code>');
    
    // Step 6: Escape HTML (but preserve placeholders and already-created HTML tags)
    // Split by placeholders and HTML tags
    const parts = formattedContent.split(/(__CODE_BLOCK_\d+__|<[^>]+>)/g);
    formattedContent = parts.map(part => {
        // Don't escape placeholders or existing HTML tags
        if (part.match(/^__CODE_BLOCK_\d+__$/) || part.match(/^<[^>]+>$/)) {
            return part;
        }
        // Escape HTML entities
        return part
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }).join('');
    
    // Step 7: Restore code blocks
    codeBlockPlaceholders.forEach((codeBlock, index) => {
        formattedContent = formattedContent.replace('__CODE_BLOCK_' + index + '__', codeBlock);
    });
    
    // Step 8: Convert newlines to <br> (but not inside code blocks or HTML tags)
    // Split by code blocks and HTML tags first
    // Need 4 backslashes because String.raw doesn't affect interpolated expressions
    const textPartsPattern = new RegExp('(<pre>[\\\\s\\\\S]*?</pre>|<[^>]+>)', 'g');
    const textParts = formattedContent.split(textPartsPattern);
    // Use RegExp constructor for match patterns
    // Need 4 backslashes because String.raw doesn't affect interpolated expressions
    const prePattern = new RegExp('^<pre>[\\\\s\\\\S]*</pre>$');
    const htmlTagPattern = new RegExp('^<[^>]+>$');
    const escapedNewline = new RegExp('\\\\\\\\n', 'g');
    const actualNewline = new RegExp('\\\\n', 'g');
    formattedContent = textParts.map(function(part) {
        // Don't process code blocks or HTML tags
        if (part.match(prePattern) || part.match(htmlTagPattern)) {
            return part;
        }
        // Convert actual newlines to <br> in text parts (not escaped backslash-n)
        return part.replace(escapedNewline, '<br>').replace(actualNewline, '<br>');
    }).join('');
    
    // Step 9: Clean up multiple consecutive <br> tags (but preserve code blocks)
    // Need 4 backslashes because String.raw doesn't affect interpolated expressions
    const multipleBrPattern = new RegExp('(<br>\\\\s*){3,}', 'g');
    formattedContent = formattedContent.replace(multipleBrPattern, '<br><br>');
    
    // Step 10: Wrap text blocks in paragraphs (but not code blocks, lists, headers, or divs)
    const textBlockRegex = new RegExp('(?:^|<br>)([^<]+?)(?:<br>|$)', 'g');
    const whitespaceOnlyPattern = new RegExp('^[\\\\s\\\\n]*$');
    formattedContent = formattedContent.replace(textBlockRegex, function(match, text) {
        text = text.trim();
        if (text && !text.match(whitespaceOnlyPattern)) {
            // Don't wrap if it's already inside a tag or is just whitespace
            return match.replace(text, '<p>' + text + '</p>');
        }
        return match;
    });
    
    // Step 11: Handle thinking indicators
    if (formattedContent.includes('💭') || formattedContent.toLowerCase().includes('thinking')) {
        formattedContent = '<div class="thinking-indicator"><span>Thinking</span><div class="thinking-dots"><span></span><span></span><span></span></div></div>' + formattedContent;
    }
    
    // Step 12: Handle command/action indicators (system messages) - wrap entire content
    if (message.role === 'system') {
        const isSuccess = formattedContent.includes('✓') || formattedContent.toLowerCase().includes('success');
        const isError = formattedContent.includes('✗') || formattedContent.toLowerCase().includes('failed') || formattedContent.toLowerCase().includes('error');
        
        if (isSuccess || isError) {
            const indicatorClass = isSuccess ? 'success' : 'error';
            formattedContent = '<div class="command-indicator ' + indicatorClass + '">' + formattedContent + '</div>';
        }
    }
    
    content.innerHTML = formattedContent;
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(content);
    
    chatContainer.appendChild(messageDiv);
    
    // Scroll to bottom smoothly
    setTimeout(() => {
        chatContainer.scrollTo({
            top: chatContainer.scrollHeight,
            behavior: 'smooth'
        });
    }, 100);
    
    // Only set loading to false for assistant messages
    if (message.role === 'assistant') {
        setLoading(false);
    }
}

function showThinking() {
    // Remove existing thinking indicator
    const existing = chatContainer.querySelector('.thinking-message');
    if (existing) {
        existing.remove();
    }
    
    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'message assistant thinking-message';
    
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '🤖';
    
    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = '<div class="thinking-indicator"><span>Thinking</span><div class="thinking-dots"><span></span><span></span><span></span></div></div>';
    
    thinkingDiv.appendChild(avatar);
    thinkingDiv.appendChild(content);
    chatContainer.appendChild(thinkingDiv);
    
    setTimeout(() => {
        chatContainer.scrollTo({
            top: chatContainer.scrollHeight,
            behavior: 'smooth'
        });
    }, 0);
}

function removeThinking() {
    const thinking = chatContainer.querySelector('.thinking-message');
    if (thinking) {
        thinking.remove();
    }
}

modelSelect.addEventListener('change', function() {
    currentModel = this.value;
    vscode.postMessage({
        command: 'setModel',
        model: currentModel
    });
});

console.log('Webview: ✅ Script fully loaded and initialized');
})();`;
}

