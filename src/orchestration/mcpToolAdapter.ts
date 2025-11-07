/**
 * Unified MCP Tools Adapter
 * Provides a single interface to create tools for any orchestrator (LangChain, ReAct, etc.)
 */

import { MCPTools } from '../mcpTools';
import { ToolCall, ToolResult } from '../types';
import { tool } from 'langchain';
import { z } from 'zod';

/**
 * Tool definition interface
 */
export interface ToolDefinition {
    name: string;
    description: string;
    schema: z.ZodObject<any>;
    execute: (args: any) => Promise<ToolResult>;
}

/**
 * Unified MCP Tools Adapter
 * Converts MCPTools into formats usable by different orchestrators
 */
export class MCPToolAdapter {
    private mcpTools: MCPTools;

    constructor(mcpTools: MCPTools) {
        this.mcpTools = mcpTools;
    }

    /**
     * Get all available tool definitions
     */
    getAllToolDefinitions(): ToolDefinition[] {
        return [
            // File operations
            this.createToolDefinition('read_file', 'Read the contents of a file. Use this to understand existing code before making changes.', 
                z.object({ file_path: z.string().describe('The path to the file to read') }),
                async (args) => this.mcpTools.executeTool({ name: 'read_file', arguments: args })
            ),
            this.createToolDefinition('write_file', 'Write or create a file',
                z.object({ 
                    file_path: z.string().describe('The path to the file to write'),
                    content: z.string().describe('The content to write to the file')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'write_file', arguments: args })
            ),
            this.createToolDefinition('list_files', 'List files in a directory. Use this to explore the codebase structure and find relevant files.',
                z.object({ directory_path: z.string().describe('The path to the directory to list') }),
                async (args) => this.mcpTools.executeTool({ name: 'list_files', arguments: args })
            ),
            this.createToolDefinition('search_files', 'Search for files by pattern',
                z.object({
                    pattern: z.string().describe('The file pattern to search for (e.g., "*.ts")'),
                    directory: z.string().optional().describe('The directory to search in (default: current directory)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'search_files', arguments: args })
            ),
            this.createToolDefinition('get_file_info', 'Get file metadata (size, modified date, type)',
                z.object({ file_path: z.string().describe('The path to the file') }),
                async (args) => this.mcpTools.executeTool({ name: 'get_file_info', arguments: args })
            ),
            this.createToolDefinition('read_file_lines', 'Read specific lines from a file',
                z.object({
                    file_path: z.string().describe('The path to the file'),
                    start_line: z.number().describe('The starting line number (1-indexed)'),
                    end_line: z.number().describe('The ending line number (1-indexed)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'read_file_lines', arguments: args })
            ),

            // Code editing
            this.createToolDefinition('search_replace', 'Search and replace text in a file',
                z.object({
                    file_path: z.string().describe('The path to the file'),
                    search: z.string().describe('The text to search for'),
                    replace: z.string().describe('The text to replace with')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'search_replace', arguments: args })
            ),
            this.createToolDefinition('insert_code', 'Insert code at a specific line number in a file. Use this to add new functions, endpoints, or code blocks. Read the file first to understand where to insert.',
                z.object({
                    file_path: z.string().describe('The path to the file'),
                    line_number: z.number().describe('The line number to insert at (1-indexed)'),
                    code: z.string().describe('The code to insert')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'insert_code', arguments: args })
            ),
            this.createToolDefinition('replace_code', 'Replace a code block between start_line and end_line with new code. Use this to modify existing functions or code blocks. Read the file first to identify the exact lines to replace.',
                z.object({
                    file_path: z.string().describe('The path to the file'),
                    start_line: z.number().describe('The starting line number (1-indexed)'),
                    end_line: z.number().describe('The ending line number (1-indexed)'),
                    new_code: z.string().describe('The new code to replace with')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'replace_code', arguments: args })
            ),
            this.createToolDefinition('apply_patch', 'Apply a unified diff patch to a file',
                z.object({
                    file_path: z.string().describe('The path to the file to patch'),
                    patch: z.string().describe('The unified diff patch to apply')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'apply_patch', arguments: args })
            ),

            // Code understanding
            this.createToolDefinition('analyze_code_structure', 'Analyze code structure (functions, classes, imports)',
                z.object({ file_path: z.string().describe('The path to the file to analyze') }),
                async (args) => this.mcpTools.executeTool({ name: 'analyze_code_structure', arguments: args })
            ),
            this.createToolDefinition('find_dependencies', 'Find file dependencies and imports',
                z.object({ file_path: z.string().describe('The path to the file') }),
                async (args) => this.mcpTools.executeTool({ name: 'find_dependencies', arguments: args })
            ),
            this.createToolDefinition('find_usages', 'Find where a symbol is used',
                z.object({
                    symbol: z.string().describe('The symbol to search for'),
                    file_path: z.string().optional().describe('The file to search in (optional, searches all files if not specified)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'find_usages', arguments: args })
            ),
            this.createToolDefinition('get_code_context', 'Get context around a specific line number',
                z.object({
                    file_path: z.string().describe('The path to the file'),
                    line_number: z.number().describe('The line number to get context around')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'get_code_context', arguments: args })
            ),
            this.createToolDefinition('extract_function', 'Extract a function definition from a file',
                z.object({
                    file_path: z.string().describe('The path to the file'),
                    function_name: z.string().describe('The name of the function to extract')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'extract_function', arguments: args })
            ),
            this.createToolDefinition('find_code_pattern', 'Find code patterns using regex in a file',
                z.object({
                    pattern: z.string().describe('The regex pattern to search for'),
                    file_path: z.string().optional().describe('The path to the file (optional)'),
                    language: z.string().optional().describe('The programming language (optional)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'find_code_pattern', arguments: args })
            ),

            // Validation & testing
            this.createToolDefinition('run_command', 'Execute a shell command',
                z.object({
                    command: z.string().describe('The command to execute'),
                    cwd: z.string().optional().describe('The working directory (default: current directory)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'run_command', arguments: args })
            ),
            this.createToolDefinition('validate_syntax', 'Validate code syntax',
                z.object({
                    file_path: z.string().describe('The path to the file to validate'),
                    language: z.string().optional().describe('The programming language (auto-detected if not specified)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'validate_syntax', arguments: args })
            ),
            this.createToolDefinition('run_tests', 'Run test suite',
                z.object({
                    test_command: z.string().optional().describe('Optional test command to run'),
                    cwd: z.string().optional().describe('The working directory (default: current directory)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'run_tests', arguments: args })
            ),
            this.createToolDefinition('lint_code', 'Run linter on code',
                z.object({
                    file_path: z.string().optional().describe('The file to lint (optional, lints all files if not specified)'),
                    cwd: z.string().optional().describe('The working directory (default: current directory)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'lint_code', arguments: args })
            ),
            this.createToolDefinition('format_code', 'Format code',
                z.object({
                    file_path: z.string().optional().describe('The file to format (optional, formats all files if not specified)'),
                    cwd: z.string().optional().describe('The working directory (default: current directory)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'format_code', arguments: args })
            ),

            // Test-driven development
            this.createToolDefinition('create_test', 'Create a test file',
                z.object({
                    file_path: z.string().describe('The path to the test file to create'),
                    test_content: z.string().describe('The test content to write')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'create_test', arguments: args })
            ),
            this.createToolDefinition('run_tests_with_coverage', 'Run tests with coverage report',
                z.object({
                    cwd: z.string().optional().describe('The working directory (default: current directory)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'run_tests_with_coverage', arguments: args })
            ),
            this.createToolDefinition('check_test_coverage', 'Check test coverage',
                z.object({
                    file_path: z.string().optional().describe('The file to check coverage for (optional)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'check_test_coverage', arguments: args })
            ),

            // Incremental refinement
            this.createToolDefinition('make_incremental_change', 'Make small, verified change to a file',
                z.object({
                    file_path: z.string().describe('The path to the file to modify'),
                    change_description: z.string().describe('Description of the change to make')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'make_incremental_change', arguments: args })
            ),
            this.createToolDefinition('review_changes', 'Review all pending changes before applying',
                z.object({}),
                async (args) => this.mcpTools.executeTool({ name: 'review_changes', arguments: args })
            ),
            this.createToolDefinition('apply_changes_batch', 'Apply multiple changes atomically',
                z.object({
                    changes: z.array(z.object({
                        file: z.string(),
                        content: z.string()
                    })).describe('Array of file changes to apply')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'apply_changes_batch', arguments: args })
            ),

            // Git operations
            this.createToolDefinition('git_status', 'Get git status',
                z.object({
                    cwd: z.string().optional().describe('The working directory (default: current directory)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'git_status', arguments: args })
            ),
            this.createToolDefinition('git_diff', 'Get git diff',
                z.object({
                    file_path: z.string().optional().describe('The file to diff (optional, shows all changes if not specified)'),
                    cwd: z.string().optional().describe('The working directory (default: current directory)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'git_diff', arguments: args })
            ),
            this.createToolDefinition('git_commit', 'Commit changes to git',
                z.object({
                    message: z.string().describe('The commit message'),
                    files: z.array(z.string()).optional().describe('Specific files to commit (optional, commits all if not specified)'),
                    cwd: z.string().optional().describe('The working directory (default: current directory)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'git_commit', arguments: args })
            ),
            this.createToolDefinition('git_create_branch', 'Create a git branch',
                z.object({
                    branch_name: z.string().describe('The name of the branch to create'),
                    cwd: z.string().optional().describe('The working directory (default: current directory)')
                }),
                async (args) => this.mcpTools.executeTool({ name: 'git_create_branch', arguments: args })
            ),
        ];
    }

    /**
     * Create a tool definition
     */
    private createToolDefinition(
        name: string,
        description: string,
        schema: z.ZodObject<any>,
        execute: (args: any) => Promise<ToolResult>
    ): ToolDefinition {
        return { name, description, schema, execute };
    }

    /**
     * Convert tools to LangChain format
     */
    toLangChainTools(): ReturnType<typeof tool>[] {
        return this.getAllToolDefinitions().map(def => {
            return tool(
                async (args: any) => {
                    const result = await def.execute(args);
                    return result.success 
                        ? (result.content || 'Success') 
                        : `Error: ${result.error || 'Unknown error'}`;
                },
                {
                    name: def.name,
                    description: def.description,
                    schema: def.schema,
                }
            );
        });
    }

    /**
     * Get tools description for ReAct orchestrator (and other text-based orchestrators)
     */
    getToolsDescription(): string {
        const tools = this.getAllToolDefinitions();
        const grouped = {
            'FILE OPERATIONS': tools.filter(t => 
                ['read_file', 'write_file', 'list_files', 'search_files', 'get_file_info', 'read_file_lines'].includes(t.name)
            ),
            'CODE EDITING': tools.filter(t => 
                ['search_replace', 'insert_code', 'replace_code', 'apply_patch'].includes(t.name)
            ),
            'CODE UNDERSTANDING': tools.filter(t => 
                ['analyze_code_structure', 'find_dependencies', 'find_usages', 'get_code_context', 'extract_function', 'find_code_pattern'].includes(t.name)
            ),
            'VALIDATION & TESTING': tools.filter(t => 
                ['run_command', 'validate_syntax', 'run_tests', 'lint_code', 'format_code'].includes(t.name)
            ),
            'TEST-DRIVEN DEVELOPMENT': tools.filter(t => 
                ['create_test', 'run_tests_with_coverage', 'check_test_coverage'].includes(t.name)
            ),
            'INCREMENTAL REFINEMENT': tools.filter(t => 
                ['make_incremental_change', 'review_changes', 'apply_changes_batch'].includes(t.name)
            ),
            'GIT OPERATIONS': tools.filter(t => 
                ['git_status', 'git_diff', 'git_commit', 'git_create_branch'].includes(t.name)
            ),
        };

        let description = 'AVAILABLE TOOLS:\n\n';
        for (const [category, categoryTools] of Object.entries(grouped)) {
            if (categoryTools.length > 0) {
                description += `${category}:\n`;
                categoryTools.forEach(tool => {
                    description += `- ${tool.name}: ${tool.description}\n`;
                });
                description += '\n';
            }
        }

        return description;
    }

    /**
     * Execute a tool call (for ReAct and other orchestrators that call tools directly)
     */
    async executeTool(toolCall: ToolCall): Promise<ToolResult> {
        return await this.mcpTools.executeTool(toolCall);
    }

    /**
     * Get the underlying MCPTools instance (for direct access if needed)
     */
    getMCPTools(): MCPTools {
        return this.mcpTools;
    }
}

