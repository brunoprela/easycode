/**
 * Advanced Code Analysis
 * State-of-the-art code understanding similar to Cursor/Copilot
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CodeStructure {
    functions: Array<{ name: string; line: number; signature: string }>;
    classes: Array<{ name: string; line: number; methods: string[] }>;
    imports: string[];
    exports: string[];
    endpoints?: Array<{ method: string; path: string; line: number }>;
}

export interface DuplicateDetection {
    type: 'endpoint' | 'function' | 'code_block';
    occurrences: Array<{ line: number; content: string }>;
    severity: 'high' | 'medium' | 'low';
}

/**
 * Analyze code structure using AST-like parsing
 */
export class CodeAnalyzer {
    /**
     * Analyze Python file structure
     */
    static analyzePython(filePath: string, content: string): CodeStructure {
        const lines = content.split('\n');
        const structure: CodeStructure = {
            functions: [],
            classes: [],
            imports: [],
            exports: []
        };

        // Detect FastAPI endpoints
        if (content.includes('from fastapi import') || content.includes('import fastapi')) {
            structure.endpoints = [];
        }

        lines.forEach((line, index) => {
            const trimmed = line.trim();

            // Imports
            if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
                structure.imports.push(trimmed);
            }

            // Functions
            const funcMatch = trimmed.match(/^(async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
            if (funcMatch) {
                structure.functions.push({
                    name: funcMatch[2],
                    line: index + 1,
                    signature: trimmed
                });
            }

            // Classes
            const classMatch = trimmed.match(/^class\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (classMatch) {
                structure.classes.push({
                    name: classMatch[1],
                    line: index + 1,
                    methods: []
                });
            }

            // FastAPI endpoints
            if (structure.endpoints) {
                const endpointMatch = trimmed.match(/@app\.(get|post|put|delete|patch)\(["']([^"']+)["']\)/);
                if (endpointMatch) {
                    structure.endpoints.push({
                        method: endpointMatch[1].toUpperCase(),
                        path: endpointMatch[2],
                        line: index + 1
                    });
                }
            }
        });

        return structure;
    }

    /**
     * Analyze TypeScript/JavaScript file structure
     */
    static analyzeTypeScript(filePath: string, content: string): CodeStructure {
        const lines = content.split('\n');
        const structure: CodeStructure = {
            functions: [],
            classes: [],
            imports: [],
            exports: []
        };

        lines.forEach((line, index) => {
            const trimmed = line.trim();

            // Imports
            if (trimmed.startsWith('import ') || trimmed.startsWith('export import ')) {
                structure.imports.push(trimmed);
            }

            // Exports
            if (trimmed.startsWith('export ')) {
                structure.exports.push(trimmed);
            }

            // Functions
            const funcMatch = trimmed.match(/(?:export\s+)?(?:async\s+)?(?:function\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[=\(]/);
            if (funcMatch && !trimmed.includes('class ')) {
                structure.functions.push({
                    name: funcMatch[1],
                    line: index + 1,
                    signature: trimmed.substring(0, 100)
                });
            }

            // Classes
            const classMatch = trimmed.match(/(?:export\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
            if (classMatch) {
                structure.classes.push({
                    name: classMatch[1],
                    line: index + 1,
                    methods: []
                });
            }
        });

        return structure;
    }

    /**
     * Detect duplicate endpoints in a file
     */
    static detectDuplicateEndpoints(filePath: string, content: string): DuplicateDetection[] {
        const lines = content.split('\n');
        const endpoints: Map<string, Array<{ line: number; content: string }>> = new Map();
        const duplicates: DuplicateDetection[] = [];

        lines.forEach((line, index) => {
            const endpointMatch = line.match(/@app\.(get|post|put|delete|patch)\(["']([^"']+)["']\)/);
            if (endpointMatch) {
                const method = endpointMatch[1].toUpperCase();
                const path = endpointMatch[2];
                const key = `${method}:${path}`;

                if (!endpoints.has(key)) {
                    endpoints.set(key, []);
                }

                // Get the function definition (next few lines)
                const funcContent = lines.slice(index, Math.min(index + 10, lines.length)).join('\n');
                endpoints.get(key)!.push({
                    line: index + 1,
                    content: funcContent.substring(0, 200)
                });
            }
        });

        // Find duplicates
        endpoints.forEach((occurrences, key) => {
            if (occurrences.length > 1) {
                duplicates.push({
                    type: 'endpoint',
                    occurrences,
                    severity: 'high'
                });
            }
        });

        return duplicates;
    }

    /**
     * Analyze file based on extension
     */
    static analyzeFile(filePath: string): CodeStructure | null {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const ext = path.extname(filePath).toLowerCase();

            if (ext === '.py') {
                return this.analyzePython(filePath, content);
            } else if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
                return this.analyzeTypeScript(filePath, content);
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Get semantic code summary
     */
    static getCodeSummary(filePath: string, content: string): string {
        const ext = path.extname(filePath).toLowerCase();
        let structure: CodeStructure | null = null;

        if (ext === '.py') {
            structure = this.analyzePython(filePath, content);
        } else if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
            structure = this.analyzeTypeScript(filePath, content);
        }

        if (!structure) {
            return `File: ${path.basename(filePath)}`;
        }

        const summary: string[] = [];
        summary.push(`File: ${path.basename(filePath)}`);

        if (structure.endpoints && structure.endpoints.length > 0) {
            summary.push(`\nEndpoints (${structure.endpoints.length}):`);
            structure.endpoints.forEach(ep => {
                summary.push(`  ${ep.method} ${ep.path} (line ${ep.line})`);
            });
        }

        if (structure.functions.length > 0) {
            summary.push(`\nFunctions (${structure.functions.length}):`);
            structure.functions.slice(0, 10).forEach(fn => {
                summary.push(`  ${fn.name} (line ${fn.line})`);
            });
            if (structure.functions.length > 10) {
                summary.push(`  ... and ${structure.functions.length - 10} more`);
            }
        }

        if (structure.classes.length > 0) {
            summary.push(`\nClasses (${structure.classes.length}):`);
            structure.classes.forEach(cls => {
                summary.push(`  ${cls.name} (line ${cls.line})`);
            });
        }

        // Check for duplicates
        const duplicates = this.detectDuplicateEndpoints(filePath, content);
        if (duplicates.length > 0) {
            summary.push(`\n⚠️ Duplicate endpoints detected:`);
            duplicates.forEach(dup => {
                summary.push(`  ${dup.occurrences.length} occurrences of same endpoint`);
                dup.occurrences.forEach(occ => {
                    summary.push(`    - Line ${occ.line}`);
                });
            });
        }

        return summary.join('\n');
    }
}

