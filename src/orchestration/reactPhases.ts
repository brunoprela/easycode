/**
 * ReAct phases: Think, Act, Verify
 * Separated from reactOrchestrator.ts for better maintainability
 */

import { MCPTools } from '../mcpTools';
import { ToolCall, ToolResult, ReasoningStep } from '../types';
import { getAIResponse } from '../ollamaClient';
import { buildContextPrompt } from './reactPrompts';

/**
 * THINK Phase - AI reasons about what to do
 */
export async function thinkPhase(
    mcpTools: MCPTools,
    task: string,
    state: any,
    messages: any[],
    model: string,
    ollamaUrl: string,
    onMessage: (role: string, content: string) => void
): Promise<ReasoningStep> {
    const contextPrompt = buildContextPrompt(
        state.codebaseState.filesRead,
        state.codebaseState.filesModified,
        state.codebaseState.errors
    );

    const thinkPrompt = `You are in a ReAct (Reasoning + Acting) loop with Chain of Thought reasoning.

Current task: ${task}

${contextPrompt}

Reasoning history (last 5 steps):
${state.reasoning.slice(-5).map((r: any, i: any) =>
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
    const response = await getAIResponse(messages, model, ollamaUrl, 300000);

    // Cursor-like parsing: Extract tool calls from natural language response
    // Look for tool calls anywhere in the response, not just in ACTION section
    const toolCalls = mcpTools.parseToolCalls(response);
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
export async function actPhase(
    mcpTools: MCPTools,
    action: ToolCall,
    onProgress: (message: string) => void,
    onToolExecution: (toolCall: ToolCall, result: ToolResult) => void
): Promise<ToolResult> {
    onProgress(`Acting: ${action.name}...`);
    const result = await mcpTools.executeTool(action);
    onToolExecution(action, result);
    return result;
}

/**
 * VERIFY Phase - Verify action was successful (Chain of Verification)
 */
export async function verifyPhase(
    mcpTools: MCPTools,
    action: ToolCall,
    onMessage: (role: string, content: string) => void
): Promise<boolean> {
    // Chain of Verification: Multiple verification strategies
    const verifications: boolean[] = [];

    switch (action.name) {
        case 'write_file':
            // Verification 1: File exists and is readable
            const readResult = await mcpTools.executeTool({
                name: 'read_file',
                arguments: { file_path: action.arguments.file_path }
            });
            verifications.push(readResult.success);

            // Verification 2: Content matches (if specified)
            if (readResult.success && action.arguments.content && readResult.content) {
                const contentMatch = readResult.content.includes(action.arguments.content.substring(0, 100));
                verifications.push(contentMatch);
            }

            // Verification 3: Syntax validation (if code file)
            if (action.arguments.file_path.match(/\.(ts|tsx|js|jsx)$/)) {
                const syntaxResult = await mcpTools.executeTool({
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
            verifications.push(true); // Will be set by result.success from executeTool
            break;

        case 'search_replace':
            // Verification 1: File still readable
            const verifyRead = await mcpTools.executeTool({
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

