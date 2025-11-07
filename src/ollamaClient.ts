/**
 * Ollama API client utilities
 * Separated for reusability across orchestrators
 */

import axios from 'axios';

export interface OllamaResponse {
    message?: {
        content: string;
        role: string;
    };
    error?: string;
    done?: boolean;
}

/**
 * Get AI response from Ollama
 */
export async function getAIResponse(
    messages: any[],
    model: string,
    ollamaUrl: string,
    timeout: number = 300000 // 5 minutes default
): Promise<string> {
    try {
        const response = await axios.post(
            `${ollamaUrl}/api/chat`,
            {
                model,
                messages,
                stream: false,
                options: {
                    temperature: 0.7,
                    top_p: 0.9,
                }
            },
            {
                timeout,
                validateStatus: (status) => status < 500
            }
        );

        if (response.data.error) {
            throw new Error(response.data.error);
        }

        if (!response.data.message || !response.data.message.content) {
            throw new Error('Invalid response from Ollama API: missing message content');
        }

        return response.data.message.content;
    } catch (error: any) {
        if (error.response?.status === 404) {
            throw new Error(`Ollama API not found at ${ollamaUrl}. Make sure Ollama is running.`);
        } else if (error.code === 'ECONNREFUSED') {
            throw new Error(`Cannot connect to Ollama at ${ollamaUrl}. Make sure Ollama is running (try: ollama serve).`);
        } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
            throw new Error(`Cannot resolve host for ${ollamaUrl}. Check your Ollama URL.`);
        } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
            throw new Error(`Connection to Ollama timed out. The model may be too large or slow.`);
        }
        throw error;
    }
}

/**
 * Get available models from Ollama
 */
export async function getModels(ollamaUrl: string): Promise<string[]> {
    try {
        const response = await axios.get(`${ollamaUrl}/api/tags`, {
            timeout: 5000,
            validateStatus: (status) => status < 500
        });

        if (response.status === 404) {
            throw new Error(`Ollama API endpoint not found. Make sure Ollama is running at ${ollamaUrl}`);
        }

        if (!response.data || !response.data.models) {
            throw new Error('Invalid response from Ollama API');
        }

        return response.data.models.map((m: any) => m.name);
    } catch (error: any) {
        if (error.response?.status === 404) {
            throw new Error(`Ollama API not found at ${ollamaUrl}. Make sure Ollama is running. Install from https://ollama.ai if needed.`);
        } else if (error.code === 'ECONNREFUSED') {
            throw new Error(`Cannot connect to Ollama at ${ollamaUrl}. Make sure Ollama is running (try: ollama serve).`);
        } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
            throw new Error(`Cannot resolve host for ${ollamaUrl}. Check your Ollama URL in settings.`);
        } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
            throw new Error(`Connection to Ollama timed out. Make sure Ollama is running at ${ollamaUrl}.`);
        }
        throw error;
    }
}

