# EasyCode - Local AI Chat for VSCode

A VSCode extension that brings a Cursor-like chat interface powered by local AI models (Ollama).

## Features

- 🚀 **Cursor-like Chat Interface**: Clean, modern chat UI similar to Cursor
- 🤖 **Local AI Models**: Uses Ollama for local model inference (no cloud dependency)
- 💻 **Code Context Awareness**: Automatically includes code context from your open files
- 🎨 **VS Code Theme Integration**: Adapts to your VS Code theme
- ⚡ **Fast & Responsive**: Lightweight and fast

## Prerequisites

1. **Ollama**: Install [Ollama](https://ollama.ai/) and make sure it's running
2. **Models**: Pull at least one model using Ollama:
   ```bash
   ollama pull llama2
   # or
   ollama pull codellama
   # or
   ollama pull mistral
   ```

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Compile the extension:
   ```bash
   pnpm run compile
   ```
4. Press `F5` in VS Code to open a new Extension Development Host window
5. In the new window, press `Ctrl+Shift+L` (or `Cmd+Shift+L` on Mac) to open the chat panel

## Usage

1. **Open Chat Panel**: 
   - Press `Ctrl+Shift+L` (or `Cmd+Shift+L` on Mac)
   - Or use Command Palette: "Open EasyCode Chat"

2. **Select Model**: Choose from available Ollama models in the dropdown

3. **Chat**: Type your message and press Enter (Shift+Enter for new line)

4. **Code Context**: The extension automatically includes context from:
   - Currently open file
   - Selected code (if any)
   - File language and path

## Configuration

You can configure the Ollama URL in VS Code settings:
- Open Settings (`Ctrl+,` or `Cmd+,`)
- Search for "EasyCode"
- Set `EasyCode: Ollama Url` (default: `http://localhost:11434`)

## Development

```bash
# Install dependencies
pnpm install

# Compile TypeScript
pnpm run compile

# Watch mode (auto-compile on changes)
pnpm run watch

# Lint
pnpm run lint
```

## Requirements

- VS Code 1.74.0 or higher
- Node.js 18.x or higher
- pnpm 8.x or higher
- Ollama running locally

## License

MIT

