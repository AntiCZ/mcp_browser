# Browser MCP - Two Components

## 1. MCP Server
📦 **Location:** `/home/paz/.local/lib/mcp_browser/`
- **Running:** Via Claude's MCP integration (configured in `~/.claude/mcp.json`)
- **Entry:** `/home/paz/.local/lib/mcp_browser/dist/index.js`
- **After Updates:** 
  1. Bump version in `package.json`
  2. Build: `npm run build`
  3. Copy: `cp -r dist/* ~/.local/lib/mcp_browser/dist/`
  4. **ASK USER TO RESTART CLAUDE** - Required for new MCP code to load!

## 2. Chrome Extension
🔧 **Location:** `/home/paz/.local/lib/mcp_browser/chrome-extension/`
- **Install:** Load unpacked in `chrome://extensions/`
- **Purpose:** Enables browser automation from MCP server
- **After Updates:** Run `chrome-canary-restart.sh` to restart browser & reload extension

## Test Server
🚀 `python3 -m http.server 8888` (from any test dir)

## Test Sites
- CodeMirror: https://codemirror.net/try/
- Monaco: https://microsoft.github.io/monaco-editor/playground.html
- Codewars: https://www.codewars.com/kata/search