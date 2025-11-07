/**
 * Webview HTML/CSS/JS content generation
 * Separated from chatPanel.ts for better maintainability
 */

export function getWebviewHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EasyCode Chat</title>
    <style>
        ${getStyles()}
    </style>
</head>
<body>
    <div class="header">
        <div class="header-left">
            <div class="model-selector">
                <label for="model-select">Model</label>
                <select id="model-select">
                    <option value="">Loading models...</option>
                </select>
            </div>
        </div>
        <div class="status" id="status">Ready</div>
    </div>

    <div class="chat-container" id="chat-container">
        <div class="empty-state">
            <h3>EasyCode Chat</h3>
            <p>Start a conversation with your local AI assistant</p>
        </div>
    </div>

    <div class="input-container">
        <div class="input-wrapper">
            <textarea 
                id="message-input" 
                placeholder="Type your message here... (Shift+Enter for new line)"
                rows="1"
            ></textarea>
            <button id="send-button">Send</button>
        </div>
    </div>

    <script>
        ${getScript()}
    </script>
</body>
</html>`;
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
    return `const vscode = acquireVsCodeApi();
const chatContainer = document.getElementById('chat-container');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const modelSelect = document.getElementById('model-select');
const status = document.getElementById('status');

let conversationId = 'default';
let currentModel = '';
let isLoading = false;

// Notify extension that webview is ready
vscode.postMessage({ command: 'webviewReady' });

// Request Ollama URL on load
vscode.postMessage({ command: 'getOllamaUrl' });

// Request models on load (extension will load them automatically, but request as backup)
vscode.postMessage({ command: 'getModels' });

// If models still not loaded after delay, request again
setTimeout(() => {
    if (modelSelect.options.length === 1 && modelSelect.options[0].value === '') {
        console.log('Models not loaded, requesting again...');
        vscode.postMessage({ command: 'getModels' });
    }
}, 1000);

// Another retry after 2 seconds
setTimeout(() => {
    if (modelSelect.options.length === 1 && modelSelect.options[0].value === '') {
        console.log('Models still not loaded, final request...');
        vscode.postMessage({ command: 'getModels' });
    }
}, 2000);

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

function addMessage(message) {
    // Remove empty state if it exists
    const emptyState = chatContainer.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = \`message \${message.role}\`;
    
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
    // Use String.fromCharCode to avoid template string issues
    const backtickChar = String.fromCharCode(96);
    const tripleBacktick = backtickChar + backtickChar + backtickChar;
    const codeBlockPattern = tripleBacktick + '(\\\\w+)?\\\\n([\\\\s\\\\S]*?)\\\\n' + tripleBacktick;
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
    formattedContent = formattedContent.replace(/(<li>.*?<\/li>(?:\\n|\\r\\n|\\n\\r)?)+/g, function(match) {
        return '<ul>' + match.replace(/\\n|\\r\\n|\\n\\r/g, '') + '</ul>';
    });
    
    // Step 4: Handle markdown bold and italic
    formattedContent = formattedContent.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    formattedContent = formattedContent.replace(/\*(.+?)\*/g, '<em>$1</em>');
    
    // Step 5: Handle inline code (but not inside code blocks)
    const inlineCodePattern = backtickChar + '([^' + backtickChar + ']+)' + backtickChar;
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
    const textParts = formattedContent.split(/(<pre>[\s\S]*?<\/pre>|<[^>]+>)/g);
    formattedContent = textParts.map(function(part) {
        // Don't process code blocks or HTML tags
        if (part.match(/^<pre>[\s\S]*<\/pre>$/) || part.match(/^<[^>]+>$/)) {
            return part;
        }
        // Convert actual newlines to <br> in text parts (not escaped \n)
        return part.replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
    }).join('');
    
    // Step 9: Clean up multiple consecutive <br> tags (but preserve code blocks)
    formattedContent = formattedContent.replace(/(<br>\s*){3,}/g, '<br><br>');
    
    // Step 10: Wrap text blocks in paragraphs (but not code blocks, lists, headers, or divs)
    const textBlockRegex = /(?:^|<br>)([^<]+?)(?:<br>|$)/g;
    formattedContent = formattedContent.replace(textBlockRegex, function(match, text) {
        text = text.trim();
        if (text && !text.match(/^[\s\n]*$/)) {
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

// Handle messages from extension
window.addEventListener('message', event => {
    const message = event.data;
    
    switch (message.command) {
        case 'addMessage':
            addMessage(message.message);
            break;
        case 'models':
            console.log('Received models:', message.models);
            if (!message.models) {
                console.error('Models message received but models array is undefined');
                break;
            }
            modelSelect.innerHTML = '';
            if (message.models.length > 0) {
                message.models.forEach(function(model) {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    modelSelect.appendChild(option);
                });
                // Use currentModel from extension, or first model as fallback
                currentModel = message.currentModel || message.models[0];
                if (currentModel) {
                    modelSelect.value = currentModel;
                    console.log('Selected model:', currentModel);
                    // Notify extension of the selected model
                    vscode.postMessage({
                        command: 'setModel',
                        model: currentModel
                    });
                }
            } else {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = 'No models found - check Ollama is running';
                modelSelect.appendChild(option);
                console.log('No models available');
            }
            break;
        case 'error':
            setLoading(false);
            status.textContent = \`Error: \${message.message}\`;
            break;
        case 'status':
            // Update status without changing loading state
            const statusText = message.message || 'Ready';
            status.textContent = statusText;
            if (statusText.toLowerCase().includes('thinking') || statusText.toLowerCase().includes('processing')) {
                status.className = 'status thinking';
            } else {
                status.className = 'status';
            }
            break;
        case 'ollamaUrl':
            status.textContent = \`Connected to \${message.url}\`;
            break;
    }
});`;
}

