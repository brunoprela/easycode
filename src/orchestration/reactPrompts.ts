/**
 * ReAct prompt building utilities
 * Separated from reactOrchestrator.ts for better maintainability
 */

import { ToolCall } from '../types';

/**
 * Build the ReAct system message with Cursor-like persona
 */
export function buildReActSystemMessage(baseMessage: string): string {
    return `You are an AI coding assistant similar to Cursor. You help developers write, edit, and understand code.

${baseMessage}

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

REACT METHODOLOGY:
You follow a ReAct (Reasoning + Acting) pattern:

1. **THINK**: Reason about what needs to be done. Consider:
   - What is the current state?
   - What needs to change?
   - What tools are available?
   - What's the best approach?

2. **ACT**: Execute tools to accomplish the task:
   - Use tools naturally as part of your workflow
   - You can describe actions in natural language - the system will interpret them
   - Focus on file operations (read_file, write_file, search_replace) for most tasks
   - Use run_command when you need to install dependencies, run tests, or execute build commands

3. **VERIFY**: Check that your actions were successful:
   - Verify file changes were made correctly
   - Check that commands executed successfully
   - Ensure the task is progressing toward completion

4. **ITERATE**: Continue thinking and acting until the task is complete

REMEMBER:
- Be conversational and helpful
- Explain your reasoning
- Make changes incrementally
- Verify your work
- Ask for clarification if needed
- Use tools naturally - don't overthink the format`;
}

/**
 * Build framework guidance prompt for when AI gets stuck
 */
export function buildFrameworkGuidancePrompt(task: string): string {
    return `You've been thinking about this task for a while. Let's take action!

Task: ${task}

Here are examples of common project creation commands. Use your internal knowledge to generate the correct command for this specific task:

**Python Projects:**
- FastAPI: \`python -m venv venv && source venv/bin/activate && pip install fastapi uvicorn\`
- Django: \`django-admin startproject myproject && cd myproject && python manage.py startapp myapp\`
- Flask: \`pip install flask && python -m flask run\`

**TypeScript/JavaScript Projects:**
- Next.js: \`npx create-next-app@latest my-app --typescript --tailwind --app --no-git --yes\`
- React: \`npx create-react-app my-app --template typescript\`
- Vue: \`npm create vue@latest my-app\`
- Svelte: \`npm create svelte@latest my-app\`
- Angular: \`ng new my-app --routing --style=css\`
- Node.js: \`npm init -y && npm install express\`

**Java Projects:**
- Spring Boot: \`curl https://start.spring.io/starter.zip -d dependencies=web -d javaVersion=17 -o spring-boot-app.zip && unzip spring-boot-app.zip\`
- Maven: \`mvn archetype:generate -DgroupId=com.example -DartifactId=my-app -DarchetypeArtifactId=maven-archetype-quickstart\`
- Gradle: \`gradle init --type java-application\`

**C#/.NET Projects:**
- ASP.NET Core: \`dotnet new webapi -n MyApi && cd MyApi && dotnet run\`
- Console: \`dotnet new console -n MyApp && cd MyApp && dotnet run\`

**Go Projects:**
- Gin: \`go mod init myapp && go get github.com/gin-gonic/gin\`
- Echo: \`go mod init myapp && go get github.com/labstack/echo/v4\`

**Rust Projects:**
- Cargo: \`cargo new my-app && cd my-app && cargo run\`

**PHP Projects:**
- Laravel: \`composer create-project laravel/laravel my-app\`
- Symfony: \`composer create-project symfony/symfony my-app\`

**Ruby Projects:**
- Rails: \`rails new my-app && cd my-app && rails server\`
- Sinatra: \`gem install sinatra && ruby app.rb\`

**Swift Projects:**
- Swift Package Manager: \`swift package init --type executable\`

**Kotlin Projects:**
- Spring Boot: \`curl https://start.spring.io/starter.zip -d dependencies=web -d language=kotlin -o kotlin-app.zip && unzip kotlin-app.zip\`
- Gradle: \`gradle init --type kotlin-application\`

**C/C++ Projects:**
- CMake: \`mkdir build && cd build && cmake .. && make\`
- Make: \`make\`

Now, based on the task "${task}", generate the appropriate command(s) using your knowledge. Don't just copy these examples - adapt them to the specific requirements of the task.

Think about what needs to be done and take action!`;
}

/**
 * Build context prompt from codebase state
 */
export function buildContextPrompt(
    filesRead: Set<string>,
    filesModified: Set<string>,
    errors: string[]
): string {
    const contextParts: string[] = [];

    if (filesRead.size > 0) {
        contextParts.push(`Files read: ${Array.from(filesRead).join(', ')}`);
    }

    if (filesModified.size > 0) {
        contextParts.push(`Files modified: ${Array.from(filesModified).join(', ')}`);
    }

    if (errors.length > 0) {
        contextParts.push(`Errors encountered: ${errors.join('; ')}`);
    }

    return contextParts.length > 0
        ? `Current context:\n${contextParts.join('\n')}`
        : 'No previous context.';
}

