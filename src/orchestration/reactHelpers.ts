/**
 * ReAct helper functions
 * Separated from reactOrchestrator.ts for better maintainability
 */

import { ToolCall } from '../types';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Extract generic action from task description
 */
export function extractGenericAction(task: string): ToolCall | null {
    const lowerTask = task.toLowerCase();

    // Directory creation
    if (lowerTask.includes('create directory') || lowerTask.includes('mkdir')) {
        const dirMatch = task.match(/(?:directory|folder|mkdir)[\s:]+['"]?([^\s'"]+)['"]?/i);
        if (dirMatch) {
            return {
                name: 'run_command',
                arguments: {
                    command: `mkdir -p ${dirMatch[1]}`,
                    cwd: '.'
                }
            };
        }
    }

    // File creation
    if (lowerTask.includes('create file') || lowerTask.includes('touch')) {
        const fileMatch = task.match(/(?:file|touch)[\s:]+['"]?([^\s'"]+)['"]?/i);
        if (fileMatch) {
            return {
                name: 'write_file',
                arguments: {
                    file_path: fileMatch[1],
                    content: ''
                }
            };
        }
    }

    return null;
}

/**
 * Check if task is already complete
 */
export function isTaskAlreadyComplete(errorMessage: string, action: ToolCall): boolean {
    const lowerError = errorMessage.toLowerCase();
    const alreadyExistsPatterns = [
        'already exists',
        'file exists',
        'directory exists',
        'already present',
        'already created',
        'already initialized'
    ];

    return alreadyExistsPatterns.some(pattern => lowerError.includes(pattern));
}

/**
 * Check if task is complete by examining the codebase
 */
export async function checkIfTaskComplete(
    task: string,
    workspaceRoot: string
): Promise<boolean> {
    const lowerTask = task.toLowerCase();

    // FastAPI backend
    if (lowerTask.includes('fastapi') || lowerTask.includes('fast api')) {
        const backendPath = path.join(workspaceRoot, 'backend');
        const mainPy = path.join(backendPath, 'main.py');
        const requirementsTxt = path.join(backendPath, 'requirements.txt');
        return fs.existsSync(mainPy) && fs.existsSync(requirementsTxt);
    }

    // Next.js app
    if (lowerTask.includes('next.js') || lowerTask.includes('nextjs')) {
        const packageJson = path.join(workspaceRoot, 'package.json');
        const nextConfig = path.join(workspaceRoot, 'next.config.js') || path.join(workspaceRoot, 'next.config.ts');
        if (fs.existsSync(packageJson)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
                return pkg.dependencies?.next !== undefined || pkg.devDependencies?.next !== undefined;
            } catch {
                return false;
            }
        }
        return fs.existsSync(nextConfig);
    }

    // React app
    if (lowerTask.includes('react') && !lowerTask.includes('next')) {
        const packageJson = path.join(workspaceRoot, 'package.json');
        if (fs.existsSync(packageJson)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
                return pkg.dependencies?.react !== undefined;
            } catch {
                return false;
            }
        }
    }

    // Django project
    if (lowerTask.includes('django')) {
        const managePy = path.join(workspaceRoot, 'manage.py');
        const settingsPy = path.join(workspaceRoot, '**', 'settings.py');
        return fs.existsSync(managePy);
    }

    // Spring Boot (Java)
    if (lowerTask.includes('spring') || lowerTask.includes('java')) {
        const pomXml = path.join(workspaceRoot, 'pom.xml');
        const buildGradle = path.join(workspaceRoot, 'build.gradle');
        return fs.existsSync(pomXml) || fs.existsSync(buildGradle);
    }

    // .NET / C#
    if (lowerTask.includes('dotnet') || lowerTask.includes('c#') || lowerTask.includes('asp.net')) {
        const csproj = path.join(workspaceRoot, '**', '*.csproj');
        const sln = path.join(workspaceRoot, '*.sln');
        return fs.existsSync(sln) || fs.existsSync(csproj);
    }

    // Go project
    if (lowerTask.includes('go') && (lowerTask.includes('project') || lowerTask.includes('app'))) {
        const goMod = path.join(workspaceRoot, 'go.mod');
        const mainGo = path.join(workspaceRoot, 'main.go');
        return fs.existsSync(goMod) || fs.existsSync(mainGo);
    }

    // Rust project
    if (lowerTask.includes('rust')) {
        const cargoToml = path.join(workspaceRoot, 'Cargo.toml');
        return fs.existsSync(cargoToml);
    }

    // PHP Laravel
    if (lowerTask.includes('laravel')) {
        const artisan = path.join(workspaceRoot, 'artisan');
        const composerJson = path.join(workspaceRoot, 'composer.json');
        return fs.existsSync(artisan) || fs.existsSync(composerJson);
    }

    // Ruby on Rails
    if (lowerTask.includes('rails') || lowerTask.includes('ruby')) {
        const gemfile = path.join(workspaceRoot, 'Gemfile');
        const configRu = path.join(workspaceRoot, 'config.ru');
        return fs.existsSync(gemfile) || fs.existsSync(configRu);
    }

    // Swift project
    if (lowerTask.includes('swift')) {
        const packageSwift = path.join(workspaceRoot, 'Package.swift');
        return fs.existsSync(packageSwift);
    }

    // Kotlin project
    if (lowerTask.includes('kotlin')) {
        const buildGradleKts = path.join(workspaceRoot, 'build.gradle.kts');
        const pomXml = path.join(workspaceRoot, 'pom.xml');
        return fs.existsSync(buildGradleKts) || fs.existsSync(pomXml);
    }

    // C/C++ project
    if (lowerTask.includes('c++') || lowerTask.includes('cpp') || (lowerTask.includes('c') && lowerTask.includes('project'))) {
        const cmakeLists = path.join(workspaceRoot, 'CMakeLists.txt');
        const makefile = path.join(workspaceRoot, 'Makefile');
        return fs.existsSync(cmakeLists) || fs.existsSync(makefile);
    }

    return false;
}

/**
 * Extract action from task (deprecated - use model-driven approach instead)
 */
export function extractActionFromTask(task: string): ToolCall | null {
    const lowerTask = task.toLowerCase();

    // FastAPI backend
    if (lowerTask.includes('fastapi') || lowerTask.includes('fast api')) {
        return {
            name: 'run_command',
            arguments: {
                command: 'mkdir -p backend && cd backend && python3 -m venv venv && source venv/bin/activate && pip install fastapi uvicorn',
                cwd: '.'
            }
        };
    }

    // Next.js app
    if (lowerTask.includes('next.js') || lowerTask.includes('nextjs')) {
        return {
            name: 'run_command',
            arguments: {
                command: 'npx create-next-app@latest my-nextjs-app --typescript --tailwind --app --no-git --yes',
                cwd: '.'
            }
        };
    }

    return null;
}

