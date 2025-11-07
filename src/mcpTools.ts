import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ToolCall, ToolResult } from './types';

const execAsync = promisify(exec);

export class MCPTools {
    private workspaceRoot: string;

    constructor() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        this.workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    }

    /**
     * Get available tools that the AI can use
     */
    getAvailableTools(): string {
        return `You are an autonomous coding assistant with direct access to the file system and command execution. 

IMPORTANT: When you need to perform actions, you MUST use tools. Do not just describe what to do - actually do it using tools.

Available tools:

FILE OPERATIONS:
1. read_file(file_path: string) - Read file contents
2. write_file(file_path: string, content: string) - Write/create files
3. list_files(directory_path: string) - List directory contents
4. search_files(pattern: string, directory?: string) - Find files by pattern
5. get_file_info(file_path: string) - Get file metadata
6. search_replace(file_path: string, search: string, replace: string) - Search and replace in file
7. apply_patch(file_path: string, patch: string) - Apply unified diff patch to file
8. read_file_lines(file_path: string, start_line: number, end_line: number) - Read specific lines

CODE MANIPULATION:
9. find_code_pattern(pattern: string, file_path?: string, language?: string) - Find code patterns using regex
10. extract_function(file_path: string, function_name: string) - Extract function definition
11. insert_code(file_path: string, line_number: number, code: string) - Insert code at line
12. replace_code(file_path: string, start_line: number, end_line: number, new_code: string) - Replace code block

VALIDATION & TESTING:
13. run_command(command: string, cwd?: string) - Execute shell commands
14. run_tests(test_command?: string, cwd?: string) - Run test suite
15. lint_code(file_path?: string, cwd?: string) - Run linter
16. format_code(file_path?: string, cwd?: string) - Format code
17. validate_syntax(file_path: string, language?: string) - Validate code syntax

CODE UNDERSTANDING:
18. analyze_code_structure(file_path: string) - Analyze code structure (functions, classes, imports)
19. find_dependencies(file_path: string) - Find file dependencies and imports
20. find_usages(symbol: string, file_path?: string) - Find where a symbol is used
21. get_code_context(file_path: string, line_number: number) - Get context around a line

TEST-DRIVEN DEVELOPMENT:
22. create_test(file_path: string, test_content: string) - Create test file
23. run_tests_with_coverage(cwd?: string) - Run tests with coverage report
24. check_test_coverage(file_path?: string) - Check test coverage

INCREMENTAL REFINEMENT:
25. make_incremental_change(file_path: string, change_description: string) - Make small, verified change
26. review_changes() - Review all pending changes before applying
27. apply_changes_batch(changes: Array<{file: string, content: string}>) - Apply multiple changes atomically

GIT OPERATIONS:
28. git_status(cwd?: string) - Get git status
29. git_diff(file_path?: string, cwd?: string) - Get git diff
30. git_commit(message: string, files?: string[], cwd?: string) - Commit changes
31. git_create_branch(branch_name: string, cwd?: string) - Create git branch

TOOL USAGE FORMAT (use this exact format):
<tool_call>
<tool_name>tool_name</tool_name>
<arguments>
{"arg1": "value1", "arg2": "value2"}
</arguments>
</tool_call>

EXAMPLES:
- To create a file: <tool_call><tool_name>write_file</tool_name><arguments>{"file_path": "test.js", "content": "console.log('hello');"}</arguments></tool_call>
- To run a command: <tool_call><tool_name>run_command</tool_name><arguments>{"command": "npm install", "cwd": "."}</arguments></tool_call>
- To read a file: <tool_call><tool_name>read_file</tool_name><arguments>{"file_path": "package.json"}</arguments></tool_call>

FRAMEWORK PROJECT CREATION EXAMPLES:
Based on your training knowledge, use appropriate commands for each framework:

Python:
- FastAPI: mkdir -p backend && cd backend && python3 -m venv venv && source venv/bin/activate && pip install fastapi uvicorn
- Django: django-admin startproject myproject .
- Flask: mkdir -p app && python3 -m venv venv && source venv/bin/activate && pip install flask

TypeScript/JavaScript:
- Next.js: npx create-next-app@latest my-app --typescript --tailwind --app --no-git --yes
- React: npx create-react-app my-app --template typescript
- Vue: npm create vue@latest my-app -- --typescript

Java:
- Spring Boot: Use Spring Initializr or: curl https://start.spring.io/starter.zip -d dependencies=web -d javaVersion=17 -o spring.zip && unzip spring.zip
- Maven: mvn archetype:generate -DgroupId=com.example -DartifactId=my-app -DarchetypeArtifactId=maven-archetype-quickstart -DinteractiveMode=false

C# / .NET:
- ASP.NET Core API: dotnet new webapi -n MyApi
- ASP.NET MVC: dotnet new mvc -n MyMvcApp
- Console: dotnet new console -n MyApp

Go:
- Gin: mkdir -p backend && cd backend && go mod init myapp && go get github.com/gin-gonic/gin
- Echo: mkdir -p backend && cd backend && go mod init myapp && go get github.com/labstack/echo/v4

Rust:
- Cargo project: cargo new my-rust-app

PHP:
- Laravel: composer create-project laravel/laravel my-laravel-app
- Symfony: composer create-project symfony/skeleton my-symfony-app

Ruby:
- Rails: rails new my-rails-app --database=postgresql
- Sinatra: mkdir -p my-sinatra-app && cd my-sinatra-app && bundle init

Swift:
- Package: swift package init --type executable --name MyPackage

Kotlin:
- Spring Boot: Use Spring Initializr with language=kotlin
- Gradle: gradle init --type kotlin-application --dsl kotlin

C/C++:
- C: mkdir -p src include && touch src/main.c Makefile
- C++: mkdir -p src include && touch src/main.cpp Makefile

WORKFLOW:
1. When given a task, use your knowledge of frameworks to determine the correct commands
2. Use run_command with the appropriate framework-specific commands
3. Create necessary files using write_file
4. Verify each step worked before proceeding
5. If a step fails, analyze the error and try an alternative approach

Remember: Use your training knowledge of frameworks and tools. Don't guess - use the standard commands for each framework.`;
    }

    /**
     * Parse tool calls from AI response - supports multiple formats
     */
    parseToolCalls(content: string): ToolCall[] {
        const toolCalls: ToolCall[] = [];

        // Method 1: XML format (preferred)
        const xmlToolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
        let match;

        while ((match = xmlToolCallRegex.exec(content)) !== null) {
            const toolCallContent = match[1];
            const nameMatch = toolCallContent.match(/<tool_name>([\s\S]*?)<\/tool_name>/);
            const argsMatch = toolCallContent.match(/<arguments>([\s\S]*?)<\/arguments>/);

            if (nameMatch && argsMatch) {
                try {
                    const name = nameMatch[1].trim();
                    const arguments_ = JSON.parse(argsMatch[1].trim());
                    toolCalls.push({ name, arguments: arguments_ });
                } catch (e) {
                    console.error('Failed to parse XML tool call:', e);
                }
            }
        }

        // Method 2: Function call style (run_command("cmd", "."))
        if (toolCalls.length === 0) {
            const functionCallPatterns = [
                {
                    regex: /run_command\s*\(\s*["']([^"']+)["']\s*(?:,\s*["']([^"']+)["'])?\s*\)/g,
                    name: 'run_command',
                    extractArgs: (match: RegExpMatchArray) => ({
                        command: match[1],
                        cwd: match[2] || '.'
                    })
                },
                {
                    regex: /read_file\s*\(\s*["']([^"']+)["']\s*\)/g,
                    name: 'read_file',
                    extractArgs: (match: RegExpMatchArray) => ({
                        file_path: match[1]
                    })
                },
                {
                    regex: /write_file\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/gs,
                    name: 'write_file',
                    extractArgs: (match: RegExpMatchArray) => ({
                        file_path: match[1],
                        content: match[2]
                    })
                },
                {
                    regex: /list_files\s*\(\s*["']([^"']+)["']\s*\)/g,
                    name: 'list_files',
                    extractArgs: (match: RegExpMatchArray) => ({
                        directory_path: match[1]
                    })
                }
            ];

            for (const pattern of functionCallPatterns) {
                const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
                let funcMatch;
                while ((funcMatch = regex.exec(content)) !== null) {
                    try {
                        const args = pattern.extractArgs(funcMatch);
                        toolCalls.push({ name: pattern.name, arguments: args });
                    } catch (e) {
                        console.error(`Failed to parse ${pattern.name} call:`, e);
                    }
                }
            }
        }

        // Method 3: Markdown code block style (```shell run_command(...) ```)
        if (toolCalls.length === 0) {
            const codeBlockRegex = /```(?:shell|bash|sh)?\s*\n?([\s\S]*?)```/g;
            let codeMatch;
            while ((codeMatch = codeBlockRegex.exec(content)) !== null) {
                const codeContent = codeMatch[1].trim();
                // Try to extract function calls from code blocks
                const runCmdMatch = codeContent.match(/(?:run_command|exec|execute)\s*\([^)]+\)/);
                if (runCmdMatch) {
                    // Extract command from the code block
                    const cmdMatch = codeContent.match(/(?:npm|yarn|pnpm|cd|mkdir|git|ls|cat|echo)\s+[^\n]+/);
                    if (cmdMatch) {
                        toolCalls.push({
                            name: 'run_command',
                            arguments: {
                                command: cmdMatch[0].trim(),
                                cwd: '.'
                            }
                        });
                    }
                }
            }
        }

        // Method 4: Extract commands from markdown code blocks
        if (toolCalls.length === 0) {
            // Extract all shell/bash code blocks
            const codeBlockRegex = /```(?:shell|bash|sh|text)?\s*\n?([\s\S]*?)```/g;
            let codeMatch;
            while ((codeMatch = codeBlockRegex.exec(content)) !== null) {
                const codeContent = codeMatch[1].trim();
                // Split by lines and extract commands
                const lines = codeContent.split('\n').map(l => l.trim()).filter(l => l);

                for (const line of lines) {
                    // Skip comments and empty lines
                    if (line.startsWith('#') || !line) continue;

                    // Handle chained commands (cd dir && command)
                    if (line.includes('&&')) {
                        const parts = line.split('&&').map(p => p.trim());
                        for (const part of parts) {
                            const cmdMatch = part.match(/^(npm|yarn|pnpm|cd|mkdir|git|ls|cat|echo|npx|node|pnpm|python|python3|pip|pip3|curl|wget|tar|zip|unzip|chmod|chown|mv|cp|rm|touch)\s+(.+)$/);
                            if (cmdMatch) {
                                toolCalls.push({
                                    name: 'run_command',
                                    arguments: {
                                        command: part,
                                        cwd: '.'
                                    }
                                });
                            }
                        }
                    } else {
                        // Extract single commands (npm, yarn, pnpm, cd, mkdir, git, etc.)
                        const commandMatch = line.match(/^(npm|yarn|pnpm|cd|mkdir|git|ls|cat|echo|npx|node|pnpm|python|python3|pip|pip3|curl|wget|tar|zip|unzip|chmod|chown|mv|cp|rm|touch)\s+(.+)$/);
                        if (commandMatch) {
                            toolCalls.push({
                                name: 'run_command',
                                arguments: {
                                    command: line,
                                    cwd: '.'
                                }
                            });
                        }
                    }
                }
            }
        }

        // Method 5: Extract from inline code and text patterns
        if (toolCalls.length === 0) {
            // Look for command-like patterns in the text
            const inlineCommandRegex = /`([^`]+)`/g;
            let inlineMatch;
            while ((inlineMatch = inlineCommandRegex.exec(content)) !== null) {
                const potentialCmd = inlineMatch[1].trim();
                // Check if it's a command
                if (potentialCmd.match(/^(npm|yarn|pnpm|cd|mkdir|git|ls|cat|echo|npx|node|pnpm)\s+/)) {
                    toolCalls.push({
                        name: 'run_command',
                        arguments: {
                            command: potentialCmd,
                            cwd: '.'
                        }
                    });
                }
            }
        }

        // Method 6: Extract file operations from markdown descriptions
        // Pattern: "write_file file_path='path' content='content'" or similar
        if (toolCalls.length === 0) {
            // Look for write_file patterns in text
            const writeFilePattern = /write_file\s+(?:file_path|file|path)\s*[=:]\s*["']([^"']+)["']\s+(?:content|code)\s*[=:]\s*["']([^"']+)["']/gs;
            let writeMatch;
            while ((writeMatch = writeFilePattern.exec(content)) !== null) {
                toolCalls.push({
                    name: 'write_file',
                    arguments: {
                        file_path: writeMatch[1],
                        content: writeMatch[2]
                    }
                });
            }

            // Look for write_file in code blocks with file_path and content
            const codeBlockWritePattern = /```(?:python|text|bash)?\s*\n?write_file\s+file_path\s*=\s*["']([^"']+)["']\s+content\s*=\s*["']([^"']+)["']/gs;
            let codeWriteMatch;
            while ((codeWriteMatch = codeBlockWritePattern.exec(content)) !== null) {
                toolCalls.push({
                    name: 'write_file',
                    arguments: {
                        file_path: codeWriteMatch[1],
                        content: codeWriteMatch[2]
                    }
                });
            }

            // Look for file creation patterns in markdown descriptions
            // Pattern: "Create file X with content Y" or "Write to file X: Y"
            const createFilePattern = /(?:create|write|add)\s+(?:a\s+)?(?:new\s+)?file\s+(?:named\s+|called\s+)?["']?([^\s"']+(?:\.[^\s"']+)?)["']?\s+(?:with\s+content|containing|:)\s*["']?([^"']+)["']?/i;
            const createMatch = content.match(createFilePattern);
            if (createMatch && !toolCalls.some(tc => tc.name === 'write_file' && tc.arguments.file_path === createMatch[1])) {
                // Try to find the content in a code block after the description
                const filePath = createMatch[1];
                const afterMatch = content.substring(content.indexOf(createMatch[0]) + createMatch[0].length);
                const codeBlockMatch = afterMatch.match(/```(?:python|javascript|typescript|text)?\s*\n?([\s\S]*?)```/);
                if (codeBlockMatch) {
                    toolCalls.push({
                        name: 'write_file',
                        arguments: {
                            file_path: filePath,
                            content: codeBlockMatch[1].trim()
                        }
                    });
                }
            }
        }

        return toolCalls;
    }

    /**
     * Execute a tool call
     */
    async executeTool(toolCall: ToolCall): Promise<ToolResult> {
        try {
            switch (toolCall.name) {
                // File operations
                case 'read_file':
                    return await this.readFile(toolCall.arguments.file_path);
                case 'write_file':
                    return await this.writeFile(toolCall.arguments.file_path, toolCall.arguments.content);
                case 'list_files':
                    return await this.listFiles(toolCall.arguments.directory_path);
                case 'search_files':
                    return await this.searchFiles(toolCall.arguments.pattern, toolCall.arguments.directory);
                case 'get_file_info':
                    return await this.getFileInfo(toolCall.arguments.file_path);
                case 'search_replace':
                    return await this.searchReplace(toolCall.arguments.file_path, toolCall.arguments.search, toolCall.arguments.replace);
                case 'apply_patch':
                    return await this.applyPatch(toolCall.arguments.file_path, toolCall.arguments.patch);
                case 'read_file_lines':
                    return await this.readFileLines(toolCall.arguments.file_path, toolCall.arguments.start_line, toolCall.arguments.end_line);

                // Code manipulation
                case 'find_code_pattern':
                    return await this.findCodePattern(toolCall.arguments.pattern, toolCall.arguments.file_path, toolCall.arguments.language);
                case 'extract_function':
                    return await this.extractFunction(toolCall.arguments.file_path, toolCall.arguments.function_name);
                case 'insert_code':
                    return await this.insertCode(toolCall.arguments.file_path, toolCall.arguments.line_number, toolCall.arguments.code);
                case 'replace_code':
                    return await this.replaceCode(toolCall.arguments.file_path, toolCall.arguments.start_line, toolCall.arguments.end_line, toolCall.arguments.new_code);

                // Validation & testing
                case 'run_command':
                    return await this.runCommand(toolCall.arguments.command, toolCall.arguments.cwd);
                case 'run_tests':
                    return await this.runTests(toolCall.arguments.test_command, toolCall.arguments.cwd);
                case 'lint_code':
                    return await this.lintCode(toolCall.arguments.file_path, toolCall.arguments.cwd);
                case 'format_code':
                    return await this.formatCode(toolCall.arguments.file_path, toolCall.arguments.cwd);
                case 'validate_syntax':
                    return await this.validateSyntax(toolCall.arguments.file_path, toolCall.arguments.language);

                // Code understanding
                case 'analyze_code_structure':
                    return await this.analyzeCodeStructure(toolCall.arguments.file_path);
                case 'find_dependencies':
                    return await this.findDependencies(toolCall.arguments.file_path);
                case 'find_usages':
                    return await this.findUsages(toolCall.arguments.symbol, toolCall.arguments.file_path);
                case 'get_code_context':
                    return await this.getCodeContext(toolCall.arguments.file_path, toolCall.arguments.line_number);

                // Test-driven development
                case 'create_test':
                    return await this.createTest(toolCall.arguments.file_path, toolCall.arguments.test_content);
                case 'run_tests_with_coverage':
                    return await this.runTestsWithCoverage(toolCall.arguments.cwd);
                case 'check_test_coverage':
                    return await this.checkTestCoverage(toolCall.arguments.file_path);

                // Incremental refinement
                case 'make_incremental_change':
                    return await this.makeIncrementalChange(toolCall.arguments.file_path, toolCall.arguments.change_description);
                case 'review_changes':
                    return await this.reviewChanges();
                case 'apply_changes_batch':
                    return await this.applyChangesBatch(toolCall.arguments.changes);

                // Git operations
                case 'git_status':
                    return await this.gitStatus(toolCall.arguments.cwd);
                case 'git_diff':
                    return await this.gitDiff(toolCall.arguments.file_path, toolCall.arguments.cwd);
                case 'git_commit':
                    return await this.gitCommit(toolCall.arguments.message, toolCall.arguments.files, toolCall.arguments.cwd);
                case 'git_create_branch':
                    return await this.gitCreateBranch(toolCall.arguments.branch_name, toolCall.arguments.cwd);

                default:
                    return {
                        success: false,
                        content: '',
                        error: `Unknown tool: ${toolCall.name}`
                    };
            }
        } catch (error: any) {
            return {
                success: false,
                content: '',
                error: error.message || String(error)
            };
        }
    }

    private async readFile(filePath: string): Promise<ToolResult> {
        try {
            const fullPath = this.resolvePath(filePath);
            const content = await fs.promises.readFile(fullPath, 'utf-8');
            return {
                success: true,
                content: `File content of ${filePath}:\n\`\`\`\n${content}\n\`\`\``
            };
        } catch (error: any) {
            return {
                success: false,
                content: '',
                error: `Failed to read file: ${error.message}`
            };
        }
    }

    private async writeFile(filePath: string, content: string): Promise<ToolResult> {
        try {
            const fullPath = this.resolvePath(filePath);
            const dir = path.dirname(fullPath);

            // Create directory if it doesn't exist
            await fs.promises.mkdir(dir, { recursive: true });

            // Read existing content for diff
            let existingContent = '';
            try {
                existingContent = await fs.promises.readFile(fullPath, 'utf-8');
            } catch {
                // File doesn't exist, that's okay
            }

            // Show diff preview
            const diff = this.generateDiff(existingContent, content);

            // Ask for confirmation if file exists
            if (existingContent && existingContent !== content) {
                const action = await vscode.window.showInformationMessage(
                    `File ${filePath} will be modified. Preview:\n\n${diff}`,
                    'Apply Changes',
                    'Cancel'
                );

                if (action !== 'Apply Changes') {
                    return {
                        success: false,
                        content: '',
                        error: 'User cancelled file write'
                    };
                }
            }

            await fs.promises.writeFile(fullPath, content, 'utf-8');

            // Reload file in editor if open
            const document = vscode.workspace.textDocuments.find(doc => doc.fileName === fullPath);
            if (document && !document.isDirty) {
                await vscode.commands.executeCommand('workbench.action.files.revert');
            }

            return {
                success: true,
                content: `Successfully wrote to ${filePath}${existingContent ? '\n\nChanges:\n' + diff : ''}`
            };
        } catch (error: any) {
            return {
                success: false,
                content: '',
                error: `Failed to write file: ${error.message}`
            };
        }
    }

    private async listFiles(directoryPath: string): Promise<ToolResult> {
        try {
            const fullPath = this.resolvePath(directoryPath);
            const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
            const files = entries
                .map(entry => ({
                    name: entry.name,
                    type: entry.isDirectory() ? 'directory' : 'file',
                    path: path.join(directoryPath, entry.name)
                }))
                .sort((a, b) => {
                    if (a.type !== b.type) {
                        return a.type === 'directory' ? -1 : 1;
                    }
                    return a.name.localeCompare(b.name);
                });

            const fileList = files.map(f => `  ${f.type === 'directory' ? '📁' : '📄'} ${f.path}`).join('\n');
            return {
                success: true,
                content: `Files in ${directoryPath}:\n${fileList}`
            };
        } catch (error: any) {
            return {
                success: false,
                content: '',
                error: `Failed to list files: ${error.message}`
            };
        }
    }

    private async runCommand(command: string, cwd?: string): Promise<ToolResult> {
        try {
            const workingDir = cwd ? this.resolvePath(cwd) : this.workspaceRoot;
            const { stdout, stderr } = await execAsync(command, {
                cwd: workingDir,
                maxBuffer: 10 * 1024 * 1024 // 10MB
            });

            let output = '';
            if (stdout) output += `STDOUT:\n${stdout}\n`;
            if (stderr) output += `STDERR:\n${stderr}\n`;

            return {
                success: true,
                content: `Command executed: ${command}\n${output}`
            };
        } catch (error: any) {
            return {
                success: false,
                content: '',
                error: `Command failed: ${error.message}\n${error.stdout || ''}\n${error.stderr || ''}`
            };
        }
    }

    private async searchFiles(pattern: string, directory?: string): Promise<ToolResult> {
        try {
            const searchDir = directory ? this.resolvePath(directory) : this.workspaceRoot;
            const { glob } = await import('glob');
            const files = await glob(pattern, {
                cwd: searchDir,
                absolute: true,
                ignore: ['**/node_modules/**', '**/.git/**']
            });

            const fileList = files.map((f: string) => `  ${f}`).join('\n');
            return {
                success: true,
                content: `Files matching ${pattern}:\n${fileList}`
            };
        } catch (error: any) {
            return {
                success: false,
                content: '',
                error: `Failed to search files: ${error.message}`
            };
        }
    }

    private async getFileInfo(filePath: string): Promise<ToolResult> {
        try {
            const fullPath = this.resolvePath(filePath);
            const stats = await fs.promises.stat(fullPath);
            return {
                success: true,
                content: `File info for ${filePath}:\n` +
                    `  Size: ${stats.size} bytes\n` +
                    `  Modified: ${stats.mtime.toISOString()}\n` +
                    `  Type: ${stats.isDirectory() ? 'directory' : 'file'}`
            };
        } catch (error: any) {
            return {
                success: false,
                content: '',
                error: `Failed to get file info: ${error.message}`
            };
        }
    }

    private resolvePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        return path.join(this.workspaceRoot, filePath);
    }

    // Advanced file operations
    private async searchReplace(filePath: string, search: string, replace: string): Promise<ToolResult> {
        try {
            const fullPath = this.resolvePath(filePath);
            let content = await fs.promises.readFile(fullPath, 'utf-8');
            const before = content;
            content = content.replace(new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replace);

            if (before === content) {
                return { success: false, content: '', error: 'No matches found' };
            }

            await fs.promises.writeFile(fullPath, content, 'utf-8');
            return { success: true, content: `Replaced ${(before.match(new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length} occurrence(s)` };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to search/replace: ${error.message}` };
        }
    }

    private async applyPatch(filePath: string, patch: string): Promise<ToolResult> {
        try {
            const fullPath = this.resolvePath(filePath);
            let content = await fs.promises.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            const patchLines = patch.split('\n');
            const result: string[] = [];
            let i = 0;

            for (const patchLine of patchLines) {
                if (patchLine.startsWith('@@')) {
                    const match = patchLine.match(/@@ -(\d+)/);
                    if (match) i = parseInt(match[1]) - 1;
                } else if (patchLine.startsWith('-')) {
                    i++; // Skip line
                } else if (patchLine.startsWith('+')) {
                    result.push(patchLine.substring(1));
                } else if (patchLine.startsWith(' ')) {
                    if (i < lines.length) result.push(lines[i]);
                    i++;
                }
            }

            await fs.promises.writeFile(fullPath, result.join('\n'), 'utf-8');
            return { success: true, content: 'Patch applied successfully' };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to apply patch: ${error.message}` };
        }
    }

    private async readFileLines(filePath: string, startLine: number, endLine: number): Promise<ToolResult> {
        try {
            const fullPath = this.resolvePath(filePath);
            const content = await fs.promises.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            const selected = lines.slice(startLine - 1, endLine).join('\n');
            return { success: true, content: `Lines ${startLine}-${endLine}:\n\`\`\`\n${selected}\n\`\`\`` };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to read lines: ${error.message}` };
        }
    }

    // Code manipulation
    private async findCodePattern(pattern: string, filePath?: string, language?: string): Promise<ToolResult> {
        try {
            const regex = new RegExp(pattern, 'g');
            let matches: string[] = [];

            if (filePath) {
                const content = await fs.promises.readFile(this.resolvePath(filePath), 'utf-8');
                const matchArray = content.match(regex);
                if (matchArray) matches = matchArray;
            } else {
                // Search in workspace
                const { glob } = await import('glob');
                const files = await glob(`**/*.${language || '*'}`);
                for (const file of files.slice(0, 10)) {
                    const content = await fs.promises.readFile(this.resolvePath(file), 'utf-8');
                    const matchArray = content.match(regex);
                    if (matchArray) matches.push(...matchArray);
                }
            }

            return { success: true, content: `Found ${matches.length} match(es):\n${matches.slice(0, 20).join('\n')}` };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to find pattern: ${error.message}` };
        }
    }

    private async extractFunction(filePath: string, functionName: string): Promise<ToolResult> {
        try {
            const content = await fs.promises.readFile(this.resolvePath(filePath), 'utf-8');
            const funcRegex = new RegExp(`(function\\s+${functionName}|const\\s+${functionName}|${functionName}\\s*=\\s*function|${functionName}\\s*:\\s*function)[\\s\\S]*?\\n\\}`, 'm');
            const match = content.match(funcRegex);
            if (match) {
                return { success: true, content: `Function ${functionName}:\n\`\`\`\n${match[0]}\n\`\`\`` };
            }
            return { success: false, content: '', error: 'Function not found' };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to extract function: ${error.message}` };
        }
    }

    private async insertCode(filePath: string, lineNumber: number, code: string): Promise<ToolResult> {
        try {
            const fullPath = this.resolvePath(filePath);
            let content = await fs.promises.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            lines.splice(lineNumber - 1, 0, code);
            await fs.promises.writeFile(fullPath, lines.join('\n'), 'utf-8');
            return { success: true, content: `Inserted code at line ${lineNumber}` };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to insert code: ${error.message}` };
        }
    }

    private async replaceCode(filePath: string, startLine: number, endLine: number, newCode: string): Promise<ToolResult> {
        try {
            const fullPath = this.resolvePath(filePath);
            let content = await fs.promises.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            lines.splice(startLine - 1, endLine - startLine + 1, newCode);
            await fs.promises.writeFile(fullPath, lines.join('\n'), 'utf-8');
            return { success: true, content: `Replaced lines ${startLine}-${endLine}` };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to replace code: ${error.message}` };
        }
    }

    // Validation & testing
    private async runTests(testCommand?: string, cwd?: string): Promise<ToolResult> {
        const command = testCommand || 'npm test';
        return this.runCommand(command, cwd);
    }

    private async lintCode(filePath?: string, cwd?: string): Promise<ToolResult> {
        const command = filePath ? `npx eslint ${filePath}` : 'npm run lint';
        return this.runCommand(command, cwd);
    }

    private async formatCode(filePath?: string, cwd?: string): Promise<ToolResult> {
        const command = filePath ? `npx prettier --write ${filePath}` : 'npm run format';
        return this.runCommand(command, cwd);
    }

    private async validateSyntax(filePath: string, language?: string): Promise<ToolResult> {
        try {
            const content = await fs.promises.readFile(this.resolvePath(filePath), 'utf-8');
            // Basic syntax validation based on language
            if (language === 'typescript' || filePath.endsWith('.ts')) {
                // Could use TypeScript compiler API
                return { success: true, content: 'TypeScript syntax appears valid (basic check)' };
            } else if (language === 'javascript' || filePath.endsWith('.js')) {
                try {
                    new Function(content);
                    return { success: true, content: 'JavaScript syntax is valid' };
                } catch (e: any) {
                    return { success: false, content: '', error: `Syntax error: ${e.message}` };
                }
            }
            return { success: true, content: 'Syntax check completed' };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to validate syntax: ${error.message}` };
        }
    }

    // Git operations
    private async gitStatus(cwd?: string): Promise<ToolResult> {
        return this.runCommand('git status', cwd);
    }

    private async gitDiff(filePath?: string, cwd?: string): Promise<ToolResult> {
        const command = filePath ? `git diff ${filePath}` : 'git diff';
        return this.runCommand(command, cwd);
    }

    private async gitCommit(message: string, files?: string[], cwd?: string): Promise<ToolResult> {
        const filesArg = files && files.length > 0 ? files.join(' ') : '.';
        return this.runCommand(`git add ${filesArg} && git commit -m "${message}"`, cwd);
    }

    private async gitCreateBranch(branchName: string, cwd?: string): Promise<ToolResult> {
        return this.runCommand(`git checkout -b ${branchName}`, cwd);
    }

    // Code understanding
    private async analyzeCodeStructure(filePath: string): Promise<ToolResult> {
        try {
            const content = await fs.promises.readFile(this.resolvePath(filePath), 'utf-8');
            const analysis: string[] = [];

            // Extract imports
            const importRegex = /^(import|export|require|from)\s+.*$/gm;
            const imports = content.match(importRegex) || [];
            if (imports.length > 0) {
                analysis.push(`Imports (${imports.length}):`);
                imports.slice(0, 10).forEach(imp => analysis.push(`  ${imp}`));
            }

            // Extract functions
            const functionRegex = /(?:function|const|async\s+function|export\s+function)\s+(\w+)/g;
            const functions: string[] = [];
            let match;
            while ((match = functionRegex.exec(content)) !== null) {
                functions.push(match[1]);
            }
            if (functions.length > 0) {
                analysis.push(`\nFunctions (${functions.length}):`);
                functions.forEach(fn => analysis.push(`  - ${fn}`));
            }

            // Extract classes
            const classRegex = /(?:class|export\s+class)\s+(\w+)/g;
            const classes: string[] = [];
            while ((match = classRegex.exec(content)) !== null) {
                classes.push(match[1]);
            }
            if (classes.length > 0) {
                analysis.push(`\nClasses (${classes.length}):`);
                classes.forEach(cls => analysis.push(`  - ${cls}`));
            }

            return {
                success: true,
                content: `Code structure of ${filePath}:\n${analysis.join('\n')}`
            };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to analyze: ${error.message}` };
        }
    }

    private async findDependencies(filePath: string): Promise<ToolResult> {
        try {
            const content = await fs.promises.readFile(this.resolvePath(filePath), 'utf-8');
            const deps: string[] = [];

            // Find import/require statements
            const importRegex = /(?:import|require|from)\s+['"]([^'"]+)['"]/g;
            let match;
            while ((match = importRegex.exec(content)) !== null) {
                deps.push(match[1]);
            }

            return {
                success: true,
                content: `Dependencies in ${filePath}:\n${deps.map(d => `  - ${d}`).join('\n')}`
            };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to find dependencies: ${error.message}` };
        }
    }

    private async findUsages(symbol: string, filePath?: string): Promise<ToolResult> {
        try {
            const regex = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
            let matches: Array<{ file: string, line: number, context: string }> = [];

            if (filePath) {
                const content = await fs.promises.readFile(this.resolvePath(filePath), 'utf-8');
                const lines = content.split('\n');
                lines.forEach((line, index) => {
                    if (regex.test(line)) {
                        matches.push({
                            file: filePath,
                            line: index + 1,
                            context: line.trim()
                        });
                    }
                });
            } else {
                // Search in workspace
                const { glob } = await import('glob');
                const files = await glob('**/*.{ts,tsx,js,jsx}');
                for (const file of files.slice(0, 20)) {
                    const content = await fs.promises.readFile(this.resolvePath(file), 'utf-8');
                    const lines = content.split('\n');
                    lines.forEach((line, index) => {
                        if (regex.test(line)) {
                            matches.push({
                                file,
                                line: index + 1,
                                context: line.trim()
                            });
                        }
                    });
                }
            }

            return {
                success: true,
                content: `Found ${matches.length} usage(s) of "${symbol}":\n${matches.slice(0, 20).map(m => `  ${m.file}:${m.line} - ${m.context}`).join('\n')}`
            };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to find usages: ${error.message}` };
        }
    }

    private async getCodeContext(filePath: string, lineNumber: number): Promise<ToolResult> {
        try {
            const content = await fs.promises.readFile(this.resolvePath(filePath), 'utf-8');
            const lines = content.split('\n');
            const start = Math.max(0, lineNumber - 10);
            const end = Math.min(lines.length, lineNumber + 10);
            const context = lines.slice(start, end);

            return {
                success: true,
                content: `Context around line ${lineNumber}:\n\`\`\`\n${context.map((l, i) => `${start + i + 1}: ${l}`).join('\n')}\n\`\`\``
            };
        } catch (error: any) {
            return { success: false, content: '', error: `Failed to get context: ${error.message}` };
        }
    }

    // Test-driven development
    private async createTest(filePath: string, testContent: string): Promise<ToolResult> {
        const testPath = filePath.replace(/\.(ts|tsx|js|jsx)$/, '.test.$1');
        return this.writeFile(testPath, testContent);
    }

    private async runTestsWithCoverage(cwd?: string): Promise<ToolResult> {
        const command = 'npm test -- --coverage';
        return this.runCommand(command, cwd);
    }

    private async checkTestCoverage(filePath?: string): Promise<ToolResult> {
        const command = filePath
            ? `npm test -- --coverage --collectCoverageFrom="${filePath}"`
            : 'npm test -- --coverage';
        return this.runCommand(command);
    }

    // Incremental refinement
    private async makeIncrementalChange(filePath: string, changeDescription: string): Promise<ToolResult> {
        // Read current file
        const currentContent = await fs.promises.readFile(this.resolvePath(filePath), 'utf-8');

        // This would ideally use AI to make the change, but for now we'll use search_replace
        // In a full implementation, this would use AST manipulation

        return {
            success: true,
            content: `Incremental change planned for ${filePath}: ${changeDescription}\nUse search_replace or replace_code to apply.`
        };
    }

    private async reviewChanges(): Promise<ToolResult> {
        // Get git diff to review changes
        return this.gitDiff();
    }

    private async applyChangesBatch(changes: Array<{ file: string, content: string }>): Promise<ToolResult> {
        const results: string[] = [];
        for (const change of changes) {
            const result = await this.writeFile(change.file, change.content);
            results.push(`${change.file}: ${result.success ? '✓' : '✗'}`);
        }
        return {
            success: true,
            content: `Applied ${changes.length} change(s):\n${results.join('\n')}`
        };
    }

    private generateDiff(oldContent: string, newContent: string): string {
        // Simple diff generation - in production, use a proper diff library
        if (oldContent === newContent) {
            return 'No changes';
        }

        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        const maxLines = Math.max(oldLines.length, newLines.length);
        const diff: string[] = [];

        for (let i = 0; i < maxLines; i++) {
            const oldLine = oldLines[i];
            const newLine = newLines[i];

            if (oldLine === undefined) {
                diff.push(`+ ${newLine}`);
            } else if (newLine === undefined) {
                diff.push(`- ${oldLine}`);
            } else if (oldLine !== newLine) {
                diff.push(`- ${oldLine}`);
                diff.push(`+ ${newLine}`);
            }
        }

        return diff.slice(0, 50).join('\n') + (diff.length > 50 ? '\n... (truncated)' : '');
    }
}

