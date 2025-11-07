import * as vscode from 'vscode';

/**
 * Shared types and interfaces across the extension
 */

// Tool-related types
export interface ToolCall {
    name: string;
    arguments: Record<string, any>;
}

export interface ToolResult {
    success: boolean;
    content?: string;
    error?: string;
}

// ReAct Orchestrator types
export interface ReasoningStep {
    thought: string;
    action: ToolCall | null;
    observation: string;
    next: 'think' | 'act' | 'verify' | 'complete';
}

export interface CodebaseState {
    filesRead: Set<string>;
    filesModified: Set<string>;
    testsRun: number;
    testsPassed: number;
    errors: string[];
}

export interface ReActState {
    task: string;
    reasoning: ReasoningStep[];
    verifiedSteps: number[];
    codebaseState: CodebaseState;
    currentStep?: number;
    context?: Map<string, any>;
}

// Advanced Orchestrator types
export interface PlanStep {
    description: string;
    tool?: string;
    arguments?: Record<string, any>;
    dependencies?: number[] | string[];
    id?: string;
    retryCount?: number;
    maxRetries?: number;
}

export interface ExecutionPlan {
    steps: PlanStep[];
    estimatedTime?: string;
    risks?: string[];
}

export interface ToolExecution {
    tool: ToolCall;
    toolCall?: ToolCall; // Alternative name
    result: ToolResult;
    timestamp: number | Date;
    duration?: number;
    id?: string;
}

export interface FileChange {
    path: string;
    type: 'created' | 'modified' | 'deleted';
    content?: string;
    operation?: 'create' | 'modify' | 'delete';
    before?: string | null;
    after?: string | null;
    timestamp?: Date;
}

export interface ExecutionState {
    plan: ExecutionPlan | null;
    currentStep: number;
    toolHistory: ToolExecution[];
    fileChanges: FileChange[];
    errors: string[];
    startTime?: number;
    conversationHistory?: any[];
    context?: Map<string, any>;
}

// Message types for webview communication
export interface WebviewMessage {
    command: string;
    [key: string]: any;
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: string;
}

