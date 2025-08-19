#!/usr/bin/env node

// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { program } from "commander";

// src/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// src/messaging/ws/sender.ts
import { WebSocket } from "ws";
var messageId = 0;
var BrowserMCPError = class extends Error {
  constructor(message, code, retryable = false, details) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.name = "BrowserMCPError";
  }
};
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function createSocketMessageSender(ws) {
  const sendSocketMessage = async (type2, payload, options = {}) => {
    const {
      timeoutMs = 3e4,
      retry = {
        maxRetries: 2,
        baseDelayMs: 1e3,
        maxDelayMs: 5e3,
        backoffMultiplier: 2
      }
    } = options;
    let lastError;
    for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
      try {
        return await sendSingleMessage(ws, type2, payload, { timeoutMs });
      } catch (error) {
        lastError = error;
        if (error instanceof BrowserMCPError && !error.retryable) {
          throw error;
        }
        if (attempt === retry.maxRetries) {
          break;
        }
        const delay = Math.min(
          retry.baseDelayMs * Math.pow(retry.backoffMultiplier, attempt),
          retry.maxDelayMs
        );
        console.warn(`[BrowserMCP] Attempt ${attempt + 1} failed for ${String(type2)}, retrying in ${delay}ms:`, error.message);
        await sleep(delay);
      }
    }
    throw new BrowserMCPError(
      `Failed after ${retry.maxRetries + 1} attempts: ${lastError.message}`,
      "MAX_RETRIES_EXCEEDED",
      false,
      { originalError: lastError.message, attempts: retry.maxRetries + 1 }
    );
  };
  return { sendSocketMessage };
}
async function sendSingleMessage(ws, type2, payload, options) {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const message = JSON.stringify({ id, type: type2, payload });
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new BrowserMCPError(
        "WebSocket is not connected",
        "CONNECTION_CLOSED",
        true
        // This is retryable if connection gets restored
      ));
      return;
    }
    const timeout = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new BrowserMCPError(
        `Timeout waiting for response to message ${id} (${String(type2)})`,
        "MESSAGE_TIMEOUT",
        true,
        // Timeouts are retryable
        { messageId: id, messageType: String(type2), timeoutMs: options.timeoutMs }
      ));
    }, options.timeoutMs);
    const handler = (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.id === id) {
          clearTimeout(timeout);
          ws.removeListener("message", handler);
          if (response.error) {
            const isRetryable = classifyErrorAsRetryable(response.error);
            reject(new BrowserMCPError(
              response.error,
              "EXTENSION_ERROR",
              isRetryable,
              { messageId: id, messageType: String(type2) }
            ));
          } else {
            resolve(response.payload);
          }
        }
      } catch (parseError) {
        console.warn("[BrowserMCP] Failed to parse WebSocket message:", parseError);
      }
    };
    const errorHandler = (error) => {
      clearTimeout(timeout);
      ws.removeListener("message", handler);
      ws.removeListener("error", errorHandler);
      reject(new BrowserMCPError(
        `WebSocket error: ${error.message}`,
        "WEBSOCKET_ERROR",
        true,
        // WebSocket errors are generally retryable
        { messageId: id, messageType: String(type2) }
      ));
    };
    ws.on("message", handler);
    ws.on("error", errorHandler);
    try {
      ws.send(message);
    } catch (sendError) {
      clearTimeout(timeout);
      ws.removeListener("message", handler);
      ws.removeListener("error", errorHandler);
      reject(new BrowserMCPError(
        `Failed to send message: ${sendError.message}`,
        "SEND_ERROR",
        true,
        // Send errors are retryable
        { messageId: id, messageType: String(type2) }
      ));
    }
  });
}
function classifyErrorAsRetryable(errorMessage) {
  const nonRetryablePatterns = [
    /invalid.*reference/i,
    /element.*not.*found/i,
    /selector.*invalid/i,
    /permission.*denied/i,
    /invalid.*parameter/i,
    /schema.*validation/i
  ];
  const retryablePatterns = [
    /timeout/i,
    /connection/i,
    /network/i,
    /temporary/i,
    /busy/i,
    /rate.?limit/i
  ];
  for (const pattern of nonRetryablePatterns) {
    if (pattern.test(errorMessage)) {
      return false;
    }
  }
  for (const pattern of retryablePatterns) {
    if (pattern.test(errorMessage)) {
      return true;
    }
  }
  return true;
}

// src/context.ts
import { WebSocket as WebSocket2 } from "ws";

// src/config/mcp.config.ts
var mcpConfig = {
  defaultWsPort: 8765,
  errors: {
    noConnectedTab: "No connected tab"
  }
};

// src/context.ts
var noConnectionMessage = `No connection to browser extension. In order to proceed, you must first connect a tab by clicking the Browser MCP extension icon in the browser toolbar and clicking the 'Connect' button.`;
var Context = class {
  _ws;
  _tabs = /* @__PURE__ */ new Map();
  _currentTabId;
  _connectionAttempts = 0;
  _lastConnectionTime;
  _toolbox = {};
  get ws() {
    if (!this._ws) {
      throw new BrowserMCPError(
        noConnectionMessage,
        "NO_CONNECTION",
        true
        // Connection errors are retryable
      );
    }
    return this._ws;
  }
  set ws(ws) {
    this._ws = ws;
    this._lastConnectionTime = Date.now();
    this._connectionAttempts = 0;
    ws.on("close", () => {
      console.warn("[BrowserMCP] WebSocket connection closed");
      this._ws = void 0;
    });
    ws.on("error", (error) => {
      console.error("[BrowserMCP] WebSocket error:", error);
    });
  }
  hasWs() {
    return !!this._ws && this._ws.readyState === WebSocket2.OPEN;
  }
  get currentTabId() {
    return this._currentTabId;
  }
  set currentTabId(tabId) {
    this._currentTabId = tabId;
  }
  // Get connection diagnostics
  getConnectionInfo() {
    return {
      connected: this.hasWs(),
      connectionAttempts: this._connectionAttempts,
      lastConnectionTime: this._lastConnectionTime,
      currentTabId: this._currentTabId,
      wsState: this._ws?.readyState
    };
  }
  async sendSocketMessage(type2, payload, options = {}) {
    const enhancedOptions = {
      timeoutMs: options.timeoutMs || 3e4,
      retry: {
        maxRetries: 2,
        baseDelayMs: 1e3,
        maxDelayMs: 5e3,
        backoffMultiplier: 2,
        ...options.retry
      }
    };
    const { sendSocketMessage } = createSocketMessageSender(
      this.ws
    );
    try {
      return await sendSocketMessage(type2, payload, enhancedOptions);
    } catch (e) {
      if (e instanceof BrowserMCPError) {
        const contextualError = new BrowserMCPError(
          e.message,
          e.code,
          e.retryable,
          {
            ...e.details,
            messageType: String(type2),
            connectionInfo: this.getConnectionInfo(),
            errorContext: options.errorContext
          }
        );
        throw contextualError;
      }
      if (e instanceof Error && e.message === mcpConfig.errors.noConnectedTab) {
        throw new BrowserMCPError(
          noConnectionMessage,
          "NO_CONNECTED_TAB",
          true,
          {
            messageType: String(type2),
            connectionInfo: this.getConnectionInfo(),
            errorContext: options.errorContext
          }
        );
      }
      throw new BrowserMCPError(
        `Unexpected error: ${e.message}`,
        "UNKNOWN_ERROR",
        true,
        {
          originalError: e,
          messageType: String(type2),
          connectionInfo: this.getConnectionInfo(),
          errorContext: options.errorContext
        }
      );
    }
  }
  async close() {
    if (!this._ws) {
      return;
    }
    try {
      await this._ws.close();
    } catch (error) {
      console.warn("[BrowserMCP] Error closing WebSocket:", error);
    } finally {
      this._ws = void 0;
    }
  }
  // Utility method for tools to use enhanced error context
  async sendWithContext(type2, payload, context, options = {}) {
    return this.sendSocketMessage(type2, payload, {
      ...options,
      errorContext: context
    });
  }
  // Toolbox management for inter-tool invocation
  get toolbox() {
    return this._toolbox;
  }
  set toolbox(tools) {
    this._toolbox = tools;
  }
  // Call another tool from within a tool
  async callTool(name, args) {
    const tool = this._toolbox[name];
    if (!tool) {
      throw new BrowserMCPError(
        `Tool '${name}' not found in toolbox`,
        "TOOL_NOT_FOUND",
        false
      );
    }
    return await tool.handle(this, args);
  }
};

// src/ws.ts
import { WebSocketServer } from "ws";

// src/utils/wait.ts
var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// src/utils/port.ts
import { execSync } from "child_process";
import net from "net";
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port);
  });
}
function killProcessOnPort(port) {
  try {
    if (process.platform === "win32") {
      execSync(
        `FOR /F "tokens=5" %a in ('netstat -ano ^| findstr :${port}') do taskkill /F /PID %a`
      );
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9`);
    }
  } catch (error) {
    console.error(`Failed to kill process on port ${port}:`, error);
  }
}

// src/ws.ts
async function createWebSocketServer(port = mcpConfig.defaultWsPort) {
  killProcessOnPort(port);
  while (await isPortInUse(port)) {
    await wait(100);
  }
  return new WebSocketServer({ port });
}

// src/server.ts
async function createServerWithTools(options) {
  const { name, version, tools, resources: resources2 } = options;
  const context = new Context();
  const toolbox = {};
  for (const tool of tools) {
    toolbox[tool.schema.name] = tool;
  }
  context.toolbox = toolbox;
  const server = new Server(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {}
      }
    }
  );
  const wss = await createWebSocketServer();
  wss.on("connection", (websocket) => {
    if (context.hasWs()) {
      context.ws.close();
    }
    context.ws = websocket;
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: tools.map((tool) => tool.schema) };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: resources2.map((resource) => resource.schema) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((tool2) => tool2.schema.name === request.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: `Tool "${request.params.name}" not found` }
        ],
        isError: true
      };
    }
    try {
      const result = await tool.handle(context, request.params.arguments);
      return result;
    } catch (error) {
      return {
        content: [{ type: "text", text: String(error) }],
        isError: true
      };
    }
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resources2.find(
      (resource2) => resource2.schema.uri === request.params.uri
    );
    if (!resource) {
      return { contents: [] };
    }
    const contents = await resource.read(context, request.params.uri);
    return { contents };
  });
  server.close = async () => {
    await server.close();
    await wss.close();
    await context.close();
  };
  return server;
}

// src/tools/common.ts
import { zodToJsonSchema } from "zod-to-json-schema";

// src/types/tool.ts
import { z } from "zod";
var NavigateTool = z.object({
  name: z.literal("browser_navigate"),
  description: z.literal("Navigate to a URL"),
  arguments: z.object({
    url: z.string().describe("The URL to navigate to")
  })
});
var GoBackTool = z.object({
  name: z.literal("browser_go_back"),
  description: z.literal("Go back to the previous page"),
  arguments: z.object({})
});
var GoForwardTool = z.object({
  name: z.literal("browser_go_forward"),
  description: z.literal("Go forward to the next page"),
  arguments: z.object({})
});
var PressKeyTool = z.object({
  name: z.literal("browser_press_key"),
  description: z.literal("Press a key on the keyboard"),
  arguments: z.object({
    key: z.string().describe("Name of the key to press or a character to generate, such as `ArrowLeft` or `a`")
  })
});
var WaitTool = z.object({
  name: z.literal("browser_wait"),
  description: z.literal("Wait for a specified time in seconds"),
  arguments: z.object({
    time: z.number().describe("The time to wait in seconds")
  })
});
var GetConsoleLogsTool = z.object({
  name: z.literal("browser_get_console_logs"),
  description: z.literal("Get console logs from the browser. Essential for debugging failed interactions, JavaScript errors, and page load issues."),
  arguments: z.object({})
});
var ScreenshotTool = z.object({
  name: z.literal("browser_screenshot"),
  description: z.literal("Take a screenshot of the current page"),
  arguments: z.object({})
});
var SnapshotTool = z.object({
  name: z.literal("browser_snapshot"),
  description: z.literal("Capture accessibility snapshot of the current page. Use this for getting references to elements to interact with. If elements missing, try 'full' level or browser_execute_js for dynamic content."),
  arguments: z.object({
    level: z.enum(["minimal", "full", "scaffold"]).optional().describe("Snapshot detail level. 'minimal' shows only interactive elements (default), 'full' shows entire DOM, 'scaffold' shows ultra-compact view"),
    viewportOnly: z.boolean().optional().describe("Only include elements in viewport (default: true)"),
    mode: z.enum(["normal", "scaffold"]).optional().describe("Snapshot mode. 'scaffold' for ultra-minimal output")
  })
});
var ClickTool = z.object({
  name: z.literal("browser_click"),
  description: z.literal("Perform click on a web page. If click fails, use browser_execute_js to debug element state or try alternative selectors."),
  arguments: z.object({
    ref: z.string().describe("Exact target element reference from the page snapshot"),
    element: z.string().describe("Human-readable element description used to obtain permission to interact with the element")
  })
});
var HoverTool = z.object({
  name: z.literal("browser_hover"),
  description: z.literal("Hover over element on page"),
  arguments: z.object({
    ref: z.string().describe("Exact target element reference from the page snapshot"),
    element: z.string().describe("Human-readable element description used to obtain permission to interact with the element")
  })
});
var TypeTool = z.object({
  name: z.literal("browser_type"),
  description: z.literal("Type text into editable element. For input failures, use browser_get_console_logs and browser_execute_js to check element properties."),
  arguments: z.object({
    ref: z.string().describe("Exact target element reference from the page snapshot"),
    element: z.string().describe("Human-readable element description used to obtain permission to interact with the element"),
    text: z.string().describe("Text to type into the element"),
    submit: z.boolean().describe("Whether to submit entered text (press Enter after)")
  })
});
var SelectOptionTool = z.object({
  name: z.literal("browser_select_option"),
  description: z.literal("Select an option in a dropdown. Complex dropdowns may require browser_execute_js for custom selection logic."),
  arguments: z.object({
    ref: z.string().describe("Exact target element reference from the page snapshot"),
    element: z.string().describe("Human-readable element description used to obtain permission to interact with the element"),
    values: z.array(z.string()).describe("Array of values to select in the dropdown. This can be a single value or multiple values.")
  })
});
var DragTool = z.object({
  name: z.literal("browser_drag"),
  description: z.literal("Drag an element to another element"),
  arguments: z.object({
    ref: z.string().describe("Exact target element reference from the page snapshot"),
    targetRef: z.string().describe("Exact target element reference to drag to"),
    element: z.string().describe("Human-readable element description used to obtain permission to interact with the element")
  })
});

// src/utils/aria-snapshot.ts
async function captureAriaSnapshot(context, status = "", options = {}) {
  const useScaffold = options.level === "scaffold" || options.mode === "scaffold" || !options.level && !options.mode;
  console.log("[captureAriaSnapshot] Options:", options, "useScaffold:", useScaffold);
  if (useScaffold) {
    console.log("[captureAriaSnapshot] Sending scaffold mode request");
    const response2 = await context.sendSocketMessage("snapshot.accessibility", { mode: "scaffold" });
    return {
      content: [
        {
          type: "text",
          text: status ? `${status}

${response2.snapshot}` : response2.snapshot
        }
      ]
    };
  }
  const snapshotOptions = {
    level: options.level || "minimal",
    viewportOnly: options.viewportOnly ?? true
  };
  console.log("[aria-snapshot.ts] Sending snapshot request with options:", snapshotOptions);
  const response = await context.sendSocketMessage("snapshot.accessibility", snapshotOptions);
  console.log("[aria-snapshot.ts] Received response, snapshot length:", response.snapshot?.length);
  return {
    content: [
      {
        type: "text",
        text: status ? `${status}

${response.snapshot}` : response.snapshot
      }
    ]
  };
}

// src/tools/common.ts
var navigate = (snapshot2) => ({
  schema: {
    name: NavigateTool.shape.name.value,
    description: NavigateTool.shape.description.value,
    inputSchema: zodToJsonSchema(NavigateTool.shape.arguments)
  },
  handle: async (context, params) => {
    const { url } = NavigateTool.shape.arguments.parse(params);
    const response = await context.sendSocketMessage("browser_navigate", { url, detectPopups: true });
    let popupInfo = "";
    if (response && response.popupsDetected && response.popups && response.popups.length > 0) {
      const popup = response.popups[0];
      popupInfo = `

[POPUP DETECTED: ${popup.containerSelector}]
`;
      popupInfo += `[YOU MUST USE browser_execute_js TO CLICK ACCEPT/AGREE SO THE POPUP WON'T APPEAR AGAIN]`;
    }
    if (snapshot2) {
      const snapshotResult = await captureAriaSnapshot(context);
      if (popupInfo && snapshotResult.content[0].type === "text") {
        snapshotResult.content[0].text += popupInfo;
      }
      return snapshotResult;
    }
    return {
      content: [
        {
          type: "text",
          text: `Navigated to ${url}${popupInfo}`
        }
      ]
    };
  }
});
var goBack = (snapshot2) => ({
  schema: {
    name: GoBackTool.shape.name.value,
    description: GoBackTool.shape.description.value,
    inputSchema: zodToJsonSchema(GoBackTool.shape.arguments)
  },
  handle: async (context) => {
    await context.sendSocketMessage("browser_go_back", {});
    if (snapshot2) {
      return captureAriaSnapshot(context);
    }
    return {
      content: [
        {
          type: "text",
          text: "Navigated back"
        }
      ]
    };
  }
});
var goForward = (snapshot2) => ({
  schema: {
    name: GoForwardTool.shape.name.value,
    description: GoForwardTool.shape.description.value,
    inputSchema: zodToJsonSchema(GoForwardTool.shape.arguments)
  },
  handle: async (context) => {
    await context.sendSocketMessage("browser_go_forward", {});
    if (snapshot2) {
      return captureAriaSnapshot(context);
    }
    return {
      content: [
        {
          type: "text",
          text: "Navigated forward"
        }
      ]
    };
  }
});
var wait2 = {
  schema: {
    name: WaitTool.shape.name.value,
    description: WaitTool.shape.description.value,
    inputSchema: zodToJsonSchema(WaitTool.shape.arguments)
  },
  handle: async (context, params) => {
    const { time } = WaitTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_wait", { time });
    return {
      content: [
        {
          type: "text",
          text: `Waited for ${time} seconds`
        }
      ]
    };
  }
};
var pressKey = {
  schema: {
    name: PressKeyTool.shape.name.value,
    description: PressKeyTool.shape.description.value,
    inputSchema: zodToJsonSchema(PressKeyTool.shape.arguments)
  },
  handle: async (context, params) => {
    const { key } = PressKeyTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_press_key", { key });
    return {
      content: [
        {
          type: "text",
          text: `Pressed key ${key}`
        }
      ]
    };
  }
};

// src/tools/custom.ts
import { zodToJsonSchema as zodToJsonSchema2 } from "zod-to-json-schema";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
var getConsoleLogs = {
  schema: {
    name: GetConsoleLogsTool.shape.name.value,
    description: GetConsoleLogsTool.shape.description.value,
    inputSchema: zodToJsonSchema2(GetConsoleLogsTool.shape.arguments)
  },
  handle: async (context, _params) => {
    const response = await context.sendSocketMessage(
      "console.get",
      {}
    );
    const text = response.logs.map((log) => JSON.stringify(log)).join("\n");
    return {
      content: [{ type: "text", text }]
    };
  }
};
var screenshot = {
  schema: {
    name: ScreenshotTool.shape.name.value,
    description: ScreenshotTool.shape.description.value,
    inputSchema: zodToJsonSchema2(ScreenshotTool.shape.arguments)
  },
  handle: async (context, _params) => {
    const response = await context.sendSocketMessage(
      "browser_screenshot",
      {}
    );
    if (!response.data) {
      return {
        content: [
          {
            type: "text",
            text: "Screenshot failed: No data received"
          }
        ]
      };
    }
    const screenshotDir = path.join(os.tmpdir(), "mcp-screenshots");
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const filename = `screenshot-${timestamp}.png`;
    const filepath = path.join(screenshotDir, filename);
    const buffer = Buffer.from(response.data, "base64");
    fs.writeFileSync(filepath, buffer);
    const stats = fs.statSync(filepath);
    const fileSizeKB = Math.round(stats.size / 1024);
    return {
      content: [
        {
          type: "text",
          text: `Screenshot saved successfully!
File: ${filepath}
Size: ${fileSizeKB} KB
Format: PNG

To view the screenshot, open the file at the path above.
The file is saved in PNG format for best quality.`
        }
      ]
    };
  }
};

// src/tools/snapshot.ts
import { zodToJsonSchema as zodToJsonSchema3 } from "zod-to-json-schema";

// src/utils/error-recovery.ts
var ErrorRecovery = class {
  static handleToolError(error, toolName, context) {
    if (error instanceof BrowserMCPError) {
      return this.handleBrowserMCPError(error, toolName, context);
    }
    return this.handleGenericError(error, toolName, context);
  }
  static handleBrowserMCPError(error, toolName, context) {
    const suggestions = this.generateRecoverySuggestions(error, toolName);
    const contextStr = context ? ` (${context})` : "";
    return {
      content: [
        {
          type: "text",
          text: this.formatErrorMessage(error, toolName, contextStr, suggestions)
        }
      ],
      isError: true,
      code: error.code,
      retryable: error.retryable,
      suggestions
    };
  }
  static handleGenericError(error, toolName, context) {
    const contextStr = context ? ` (${context})` : "";
    const suggestions = this.generateGenericSuggestions(error, toolName);
    return {
      content: [
        {
          type: "text",
          text: this.formatGenericErrorMessage(error, toolName, contextStr, suggestions)
        }
      ],
      isError: true,
      code: "GENERIC_ERROR",
      retryable: true,
      suggestions
    };
  }
  static generateRecoverySuggestions(error, toolName) {
    const suggestions = [];
    switch (error.code) {
      case "NO_CONNECTION":
      case "CONNECTION_CLOSED":
        suggestions.push(
          {
            action: "Check Extension",
            description: "Verify the BrowserMCP extension is installed and enabled in Chrome"
          },
          {
            action: "Connect Tab",
            description: "Click the extension icon and press 'Connect' button in the active tab"
          },
          {
            action: "Restart Extension",
            description: "Disable and re-enable the extension in chrome://extensions"
          }
        );
        break;
      case "MESSAGE_TIMEOUT":
        suggestions.push(
          {
            action: "Retry Operation",
            description: "The browser may be busy - try the operation again"
          },
          {
            action: "Refresh Page",
            description: "Navigate to a fresh page if the current page is unresponsive",
            code: `browser_navigate({ url: "${getCurrentUrl()}" })`
          },
          {
            action: "Check Page Load",
            description: "Ensure the page has finished loading before attempting operations"
          }
        );
        break;
      case "EXTENSION_ERROR":
        if (error.message.includes("invalid.*reference")) {
          suggestions.push(
            {
              action: "Get New Snapshot",
              description: "Element references may be stale - capture a fresh page snapshot",
              code: "browser_snapshot()"
            },
            {
              action: "Find Element",
              description: "Use query_elements to find the element by text or selector",
              code: "browser_query_elements({ containing: 'button text' })"
            }
          );
        } else if (error.message.includes("element.*not.*found")) {
          suggestions.push(
            {
              action: "Verify Element Exists",
              description: "Check if the element is visible and accessible on the page"
            },
            {
              action: "Wait for Element",
              description: "Element might not be loaded yet - wait a moment and try again",
              code: "browser_wait({ time: 2 })"
            },
            {
              action: "Check Page Content",
              description: "Take a screenshot to verify current page state",
              code: "browser_screenshot()"
            }
          );
        }
        break;
      case "WEBSOCKET_ERROR":
      case "SEND_ERROR":
        suggestions.push(
          {
            action: "Check Network",
            description: "Verify network connectivity between server and extension"
          },
          {
            action: "Restart Server",
            description: "Restart the MCP server if connection issues persist"
          }
        );
        break;
      case "MAX_RETRIES_EXCEEDED":
        suggestions.push(
          {
            action: "Manual Inspection",
            description: "Take a screenshot to see current page state",
            code: "browser_screenshot()"
          },
          {
            action: "Simplify Operation",
            description: "Try breaking down the operation into smaller steps"
          },
          {
            action: "Change Approach",
            description: "Consider using alternative tools or methods for this task"
          }
        );
        break;
    }
    suggestions.push(...this.getToolSpecificSuggestions(toolName, error));
    return suggestions;
  }
  static getToolSpecificSuggestions(toolName, error) {
    const suggestions = [];
    switch (toolName) {
      case "browser_click":
        suggestions.push({
          action: "Verify Element is Clickable",
          description: "Ensure the element is visible and not covered by other elements"
        });
        break;
      case "browser_type":
        suggestions.push({
          action: "Check Input Field",
          description: "Verify the input field is enabled and focused"
        });
        break;
      case "browser_navigate":
        suggestions.push({
          action: "Check URL",
          description: "Verify the URL is valid and accessible"
        });
        break;
      case "browser_execute_js":
        if (error.message.includes("unsafe")) {
          suggestions.push({
            action: "Enable Unsafe Mode",
            description: "Set BROWSERMCP_UNSAFE_MODE=true or enable in extension options"
          });
        }
        break;
    }
    return suggestions;
  }
  static generateGenericSuggestions(error, toolName) {
    return [
      {
        action: "Check Error Details",
        description: "Review the full error message for specific guidance"
      },
      {
        action: "Take Screenshot",
        description: "Capture current page state for debugging",
        code: "browser_screenshot()"
      },
      {
        action: "Try Again",
        description: "Some errors are transient - try the operation again"
      }
    ];
  }
  static formatErrorMessage(error, toolName, context, suggestions) {
    let message = `\u274C ${toolName} failed${context}: ${error.message}`;
    if (error.retryable) {
      message += "\n\n\u{1F504} This error is retryable - the system will automatically retry on temporary failures.";
    }
    if (error.details) {
      message += `

\u{1F4CA} Error Details:
${JSON.stringify(error.details, null, 2)}`;
    }
    if (suggestions.length > 0) {
      message += `

\u{1F4A1} Recovery Suggestions:`;
      suggestions.forEach((suggestion, index) => {
        message += `
${index + 1}. **${suggestion.action}**: ${suggestion.description}`;
        if (suggestion.code) {
          message += `
   Code: \`${suggestion.code}\``;
        }
      });
    }
    return message;
  }
  static formatGenericErrorMessage(error, toolName, context, suggestions) {
    let message = `\u274C ${toolName} failed${context}: ${error.message}`;
    if (suggestions.length > 0) {
      message += `

\u{1F4A1} Suggestions:`;
      suggestions.forEach((suggestion, index) => {
        message += `
${index + 1}. **${suggestion.action}**: ${suggestion.description}`;
        if (suggestion.code) {
          message += `
   Code: \`${suggestion.code}\``;
        }
      });
    }
    return message;
  }
};
function getCurrentUrl() {
  return "about:blank";
}

// src/tools/snapshot.ts
var snapshot = {
  schema: {
    name: SnapshotTool.shape.name.value,
    description: SnapshotTool.shape.description.value,
    inputSchema: zodToJsonSchema3(SnapshotTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = SnapshotTool.shape.arguments.parse(params || {});
    const isScaffold = validatedParams.level === "scaffold" || validatedParams.mode === "scaffold";
    return await captureAriaSnapshot(context, "", {
      level: isScaffold ? "scaffold" : validatedParams.level,
      viewportOnly: validatedParams.viewportOnly,
      mode: validatedParams.mode
    });
  }
};
var click = {
  schema: {
    name: ClickTool.shape.name.value,
    description: ClickTool.shape.description.value,
    inputSchema: zodToJsonSchema3(ClickTool.shape.arguments)
  },
  handle: async (context, params) => {
    try {
      const validatedParams = ClickTool.shape.arguments.parse(params);
      const response = await context.sendWithContext(
        "dom.click",
        { ref: validatedParams.ref, detectPopups: true },
        `clicking element "${validatedParams.element}" with ref ${validatedParams.ref}`
      );
      const snapshot2 = await captureAriaSnapshot(context);
      let popupInfo = "";
      if (response && response.popupsDetected) {
        popupInfo = "\n\n\u{1F514} POPUP DETECTED AFTER CLICK!\n";
        response.popups.forEach((popup, index) => {
          popupInfo += `
Popup ${index + 1}: ${popup.type}
`;
          popupInfo += `Text: ${popup.text?.slice(0, 200)}...
`;
          popupInfo += `
Interactive elements:
`;
          popup.elements?.forEach((el) => {
            popupInfo += `- [${el.ref}] ${el.type}: "${el.text}" (${el.category})
`;
          });
        });
        popupInfo += "\nTo interact with popup, use browser_click with the ref ID.";
      }
      return {
        content: [
          {
            type: "text",
            text: `\u2705 Clicked "${validatedParams.element}"${popupInfo}`
          },
          ...snapshot2.content
        ]
      };
    } catch (error) {
      return ErrorRecovery.handleToolError(
        error,
        "browser_click",
        params ? `element "${params.element}" with ref ${params.ref}` : void 0
      );
    }
  }
};
var drag = {
  schema: {
    name: DragTool.shape.name.value,
    description: DragTool.shape.description.value,
    inputSchema: zodToJsonSchema3(DragTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = DragTool.shape.arguments.parse(params);
    await context.sendSocketMessage("dom.drag", {
      ref: validatedParams.ref,
      targetRef: validatedParams.targetRef
    });
    const snapshot2 = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Dragged element "${validatedParams.ref}" to "${validatedParams.targetRef}"`
        },
        ...snapshot2.content
      ]
    };
  }
};
var hover = {
  schema: {
    name: HoverTool.shape.name.value,
    description: HoverTool.shape.description.value,
    inputSchema: zodToJsonSchema3(HoverTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = HoverTool.shape.arguments.parse(params);
    await context.sendSocketMessage("dom.hover", { ref: validatedParams.ref });
    const snapshot2 = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Hovered over "${validatedParams.element}"`
        },
        ...snapshot2.content
      ]
    };
  }
};
var type = {
  schema: {
    name: TypeTool.shape.name.value,
    description: TypeTool.shape.description.value,
    inputSchema: zodToJsonSchema3(TypeTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = TypeTool.shape.arguments.parse(params);
    await context.sendSocketMessage("dom.type", {
      ref: validatedParams.ref,
      text: validatedParams.text,
      submit: validatedParams.submit
    });
    const snapshot2 = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Typed "${validatedParams.text}" into "${validatedParams.element}"`
        },
        ...snapshot2.content
      ]
    };
  }
};
var selectOption = {
  schema: {
    name: SelectOptionTool.shape.name.value,
    description: SelectOptionTool.shape.description.value,
    inputSchema: zodToJsonSchema3(SelectOptionTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = SelectOptionTool.shape.arguments.parse(params);
    await context.sendSocketMessage("dom.select", {
      ref: validatedParams.ref,
      values: validatedParams.values
    });
    const snapshot2 = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Selected option in "${validatedParams.element}"`
        },
        ...snapshot2.content
      ]
    };
  }
};

// src/tools/tabs.ts
import { z as z2 } from "zod";
import { zodToJsonSchema as zodToJsonSchema4 } from "zod-to-json-schema";
var TabListSchema = z2.object({});
var TabSelectSchema = z2.object({
  index: z2.number().describe("The index of the tab to select")
});
var TabNewSchema = z2.object({
  url: z2.string().optional().describe("The URL to navigate to in the new tab. If not provided, the new tab will be blank.")
});
var TabCloseSchema = z2.object({
  index: z2.number().optional().describe("The index of the tab to close. Closes current tab if not provided.")
});
var browser_tab_list = {
  schema: {
    name: "browser_tab_list",
    description: "List all open browser tabs",
    inputSchema: zodToJsonSchema4(TabListSchema)
  },
  handle: async (context) => {
    const response = await context.sendSocketMessage("tabs.list", {});
    const tabsText = response.tabs.map(
      (tab, idx) => `[${tab.index}] ${tab.active ? "(Active) " : ""}${tab.title} - ${tab.url}`
    ).join("\n");
    return {
      content: [{
        type: "text",
        text: tabsText || "No tabs open"
      }]
    };
  }
};
var browser_tab_select = {
  schema: {
    name: "browser_tab_select",
    description: "Select a tab by index",
    inputSchema: zodToJsonSchema4(TabSelectSchema)
  },
  handle: async (context, params) => {
    await context.sendSocketMessage("tabs.select", { index: params.index });
    const snapshot2 = await context.sendSocketMessage("snapshot.accessibility", { mode: "scaffold" });
    return {
      content: [{
        type: "text",
        text: `Tab ${params.index} selected

${snapshot2.snapshot}`
      }]
    };
  }
};
var browser_tab_new = {
  schema: {
    name: "browser_tab_new",
    description: "Open a new tab",
    inputSchema: zodToJsonSchema4(TabNewSchema)
  },
  handle: async (context, params) => {
    const response = await context.sendSocketMessage("tabs.new", {
      url: params?.url,
      detectPopups: true
    });
    let content = `New tab opened at index ${response.index}`;
    if (response && response.popupsDetected) {
      content += "\n\n\u{1F514} POPUP DETECTED!\n";
      response.popups.forEach((popup, index) => {
        content += `
Popup ${index + 1}: ${popup.type}
`;
        content += `Text: ${popup.text?.slice(0, 200)}...
`;
        content += `
Interactive elements:
`;
        popup.elements?.forEach((el) => {
          content += `- [${el.ref}] ${el.type}: "${el.text}" (${el.category})
`;
          if (el.checked !== void 0) {
            content += `  Checked: ${el.checked}
`;
          }
        });
      });
      content += `
To interact with popup, use browser_click with the ref ID.`;
    }
    if (params?.url) {
      await new Promise((resolve) => setTimeout(resolve, 1e3));
      const snapResponse = await context.sendSocketMessage("snapshot.accessibility", { mode: "scaffold" });
      content += "\n\n" + snapResponse.snapshot;
    }
    return {
      content: [{
        type: "text",
        text: content
      }]
    };
  }
};
var browser_tab_close = {
  schema: {
    name: "browser_tab_close",
    description: "Close a tab",
    inputSchema: zodToJsonSchema4(TabCloseSchema)
  },
  handle: async (context, params) => {
    const response = await context.sendSocketMessage("tabs.close", {
      index: params?.index
    });
    let content = response.success ? "Tab closed successfully" : "Failed to close tab";
    try {
      const snapResponse = await context.sendSocketMessage("snapshot.accessibility", { mode: "scaffold" });
      content += "\n\n" + snapResponse.snapshot;
    } catch (e) {
      content += "\n\nNo active tabs remaining";
    }
    return {
      content: [{
        type: "text",
        text: content
      }]
    };
  }
};

// src/tools/debugger.ts
import { z as z3 } from "zod";
import { zodToJsonSchema as zodToJsonSchema5 } from "zod-to-json-schema";
var DebuggerAttachSchema = z3.object({
  domains: z3.array(z3.enum(["console", "network", "performance", "runtime"])).optional().describe("Which debugging domains to enable. Defaults to all.")
});
var DebuggerGetDataSchema = z3.object({
  type: z3.enum(["console", "network", "performance", "errors"]).describe("Type of debug data to retrieve"),
  limit: z3.number().optional().default(50).describe("Maximum number of entries to return"),
  filter: z3.string().optional().describe("Optional filter string for results")
});
var browser_debugger_attach = {
  schema: {
    name: "browser_debugger_attach",
    description: "Attach debugger to current tab to enable monitoring of console, network, and performance",
    inputSchema: zodToJsonSchema5(DebuggerAttachSchema)
  },
  handle: async (context, params) => {
    const input = DebuggerAttachSchema.parse(params || {});
    const domains = input.domains || ["console", "network", "performance", "runtime"];
    const response = await context.sendSocketMessage("debugger.attach", { domains });
    return {
      content: [
        {
          type: "text",
          text: `Debugger attached with domains: ${domains.join(", ")}. Now monitoring browser activity.`
        }
      ]
    };
  }
};
var browser_debugger_detach = {
  schema: {
    name: "browser_debugger_detach",
    description: "Detach debugger from current tab",
    inputSchema: zodToJsonSchema5(z3.object({}))
  },
  handle: async (context) => {
    await context.sendSocketMessage("debugger.detach", {});
    return {
      content: [
        {
          type: "text",
          text: "Debugger detached. Monitoring stopped."
        }
      ]
    };
  }
};
var browser_debugger_get_data = {
  schema: {
    name: "browser_debugger_get_data",
    description: "Get collected debug data (console logs, network requests, performance metrics, or errors)",
    inputSchema: zodToJsonSchema5(DebuggerGetDataSchema)
  },
  handle: async (context, params) => {
    const input = DebuggerGetDataSchema.parse(params || {});
    const response = await context.sendSocketMessage("debugger.getData", {
      type: input.type,
      limit: input.limit,
      filter: input.filter
    });
    let formattedData = "";
    switch (input.type) {
      case "console":
        formattedData = formatConsoleLogs(response.data);
        break;
      case "network":
        formattedData = formatNetworkRequests(response.data);
        break;
      case "performance":
        formattedData = formatPerformanceMetrics(response.data);
        break;
      case "errors":
        formattedData = formatErrors(response.data);
        break;
    }
    return {
      content: [
        {
          type: "text",
          text: formattedData
        }
      ]
    };
  }
};
function formatConsoleLogs(logs) {
  if (!logs || logs.length === 0) return "No console logs captured.";
  return logs.map(
    (log) => `[${log.type.toUpperCase()}] ${log.timestamp}: ${log.args.map(
      (arg) => typeof arg === "object" ? JSON.stringify(arg) : arg
    ).join(" ")}${log.stackTrace ? "\n  at " + log.stackTrace : ""}`
  ).join("\n");
}
function formatNetworkRequests(requests) {
  if (!requests || requests.length === 0) return "No network requests captured.";
  return requests.map(
    (req) => `${req.method} ${req.url}
  Status: ${req.status || "pending"}
  Type: ${req.type}
  Size: ${req.size || "unknown"}
  Time: ${req.time || "pending"}ms`
  ).join("\n\n");
}
function formatPerformanceMetrics(metrics) {
  if (!metrics) return "No performance metrics available.";
  return Object.entries(metrics).map(
    ([key, value]) => `${key}: ${value}`
  ).join("\n");
}
function formatErrors(errors) {
  if (!errors || errors.length === 0) return "No errors captured.";
  return errors.map(
    (err) => `[ERROR] ${err.timestamp}: ${err.message}
  File: ${err.url}:${err.line}:${err.column}
  Stack: ${err.stack || "No stack trace"}`
  ).join("\n\n");
}
var debuggerTools = [
  browser_debugger_attach,
  browser_debugger_detach,
  browser_debugger_get_data
];

// src/tools/scaffold.ts
import { zodToJsonSchema as zodToJsonSchema6 } from "zod-to-json-schema";
import { z as z4 } from "zod";
var ExpandRegionTool = z4.object({
  name: z4.literal("browser_expand_region"),
  description: z4.literal("Expand a specific region of the page with token budget control"),
  arguments: z4.object({
    ref: z4.string().describe("The ref ID of the region to expand"),
    maxTokens: z4.number().optional().default(5e3).describe("Maximum tokens to use"),
    depth: z4.number().optional().default(2).describe("How many levels deep to traverse"),
    filter: z4.enum(["all", "interactive", "text"]).optional().default("all").describe("Filter elements by type")
  })
});
var QueryElementsTool = z4.object({
  name: z4.literal("browser_query_elements"),
  description: z4.literal("Query elements by selector, text content, or proximity"),
  arguments: z4.object({
    selector: z4.string().optional().default("*").describe("CSS selector to match"),
    containing: z4.string().optional().describe("Text content to search for"),
    nearRef: z4.string().optional().describe("Find elements near this ref ID"),
    limit: z4.number().optional().default(20).describe("Maximum number of results")
  })
});
var expandRegion = {
  schema: {
    name: ExpandRegionTool.shape.name.value,
    description: ExpandRegionTool.shape.description.value,
    inputSchema: zodToJsonSchema6(ExpandRegionTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = ExpandRegionTool.shape.arguments.parse(params || {});
    const response = await context.sendSocketMessage("dom.expand", validatedParams);
    let textContent;
    if (response && typeof response === "object" && "expansion" in response) {
      textContent = String(response.expansion);
    } else if (typeof response === "string") {
      textContent = response;
    } else if (response === null || response === void 0) {
      textContent = "No content returned from expansion";
    } else {
      textContent = JSON.stringify(response, null, 2);
    }
    return {
      content: [
        {
          type: "text",
          text: textContent || ""
        }
      ]
    };
  }
};
var queryElements = {
  schema: {
    name: QueryElementsTool.shape.name.value,
    description: QueryElementsTool.shape.description.value,
    inputSchema: zodToJsonSchema6(QueryElementsTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = QueryElementsTool.shape.arguments.parse(params || {});
    const response = await context.sendSocketMessage("dom.query", validatedParams);
    let textContent;
    if (response && typeof response === "object" && "results" in response) {
      textContent = String(response.results);
    } else if (typeof response === "string") {
      textContent = response;
    } else if (response === null || response === void 0) {
      textContent = "No elements found matching the query";
    } else {
      textContent = JSON.stringify(response, null, 2);
    }
    return {
      content: [
        {
          type: "text",
          text: textContent || ""
        }
      ]
    };
  }
};

// src/tools/code-execution.ts
import { zodToJsonSchema as zodToJsonSchema7 } from "zod-to-json-schema";
import { z as z5 } from "zod";
var ExecuteCodeTool = z5.object({
  name: z5.literal("browser_execute_js"),
  description: z5.literal("Execute JavaScript code in the browser (safe mode by default, unsafe available). CRITICAL: This is a DIAGNOSTIC/INSPECTION tool, NOT for interactions! After using this to find elements or debug, ALWAYS return to high-level tools (browser_click, browser_type, etc.) for actual interactions. Only use for: debugging, state inspection, or when NO high-level tool exists. Use unsafe: true ONLY for code editors (CodeMirror/Monaco/Ace), framework internals, or complex DOM operations."),
  arguments: z5.object({
    code: z5.string().describe(`JavaScript code to execute. 
      
      SAFE MODE API (default):
      Available API methods:
      - api.$('selector') - Query single element
      - api.$$('selector') - Query all elements as array
      - api.getText('selector') - Get text content
      - api.getValue('selector') - Get input value
      - api.getAttribute('selector', 'attr') - Get attribute value
      - api.exists('selector') - Check if element exists
      - api.count('selector') - Count matching elements
      - api.click('selector') - Click element
      - api.setValue('selector', 'value') - Set input value
      - api.hide('selector') - Hide elements
      - api.show('selector') - Show elements
      - api.addClass('selector', 'class') - Add class
      - api.removeClass('selector', 'class') - Remove class
      - api.extractTable('selector') - Extract table data
      - api.extractLinks('containerSelector') - Extract links
      - api.wait(ms) - Wait for milliseconds
      - api.scrollTo('selector') - Scroll to element
      - api.getPageInfo() - Get page metadata
      - api.log(...args) - Console log for debugging
      
      Example: return api.getText('h1');
      
      UNSAFE MODE (when enabled):
      Full access to window, document, fetch, chrome APIs, and all browser features.
      Required for: CodeMirror/Monaco/Ace editor APIs, React/Vue internals, complex DOM manipulation.
      Example for CodeMirror: { code: 'document.querySelector(".CodeMirror").CodeMirror.setValue("code")', unsafe: true }
      Use with caution!`),
    timeout: z5.number().optional().default(5e3).describe("Execution timeout in milliseconds"),
    unsafe: z5.boolean().optional().describe("Use unsafe mode (requires server/extension configuration)")
  })
});
var executeJS = {
  schema: {
    name: ExecuteCodeTool.shape.name.value,
    description: ExecuteCodeTool.shape.description.value,
    inputSchema: zodToJsonSchema7(ExecuteCodeTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = ExecuteCodeTool.shape.arguments.parse(params || {});
    let useUnsafeMode = validatedParams.unsafe || false;
    if (!validatedParams.unsafe && process.env.BROWSERMCP_UNSAFE_MODE === "true") {
      useUnsafeMode = true;
      console.log("[Code Execution] Using unsafe mode from environment variable");
    }
    try {
      const modeStr = useUnsafeMode ? "UNSAFE" : "SAFE";
      console.log(`[Code Execution] Executing ${validatedParams.code.length} chars of code in ${modeStr} mode`);
      if (useUnsafeMode) {
        console.warn("\u26A0\uFE0F WARNING: Executing code in UNSAFE mode with full browser access");
      }
      const messageTimeout = validatedParams.timeout + 500;
      const response = await context.sendSocketMessage("js.execute", {
        code: validatedParams.code,
        timeout: validatedParams.timeout,
        unsafe: useUnsafeMode
      }, { timeoutMs: messageTimeout });
      let resultText;
      if (response.result === void 0 || response.result === null) {
        resultText = "Code executed successfully (no return value)";
      } else if (typeof response.result === "object") {
        resultText = JSON.stringify(response.result, null, 2);
      } else {
        resultText = String(response.result);
      }
      return {
        content: [
          {
            type: "text",
            text: resultText
          }
        ]
      };
    } catch (error) {
      console.error(`[Code Execution] Error:`, error.message);
      let errorMessage = `Execution failed: ${error.message}`;
      let hint = "";
      if (error.message.includes("Illegal return statement")) {
        hint = "\n\n\u{1F4A1} HINT: In unsafe mode, wrap your code in an IIFE:\n(function() {\n  // your code here\n  return result;\n})();";
      } else if (error.message.includes("SyntaxError") && validatedParams.code.includes("return") && !validatedParams.code.includes("function")) {
        hint = "\n\n\u{1F4A1} HINT: Top-level return statements need a function wrapper. Use:\n(function() { return value; })()";
      } else if (error.message.includes("is not defined") && !useUnsafeMode) {
        hint = "\n\n\u{1F4A1} HINT: In safe mode, use the api object: api.$(selector), api.getText(), etc.\nFor full DOM access, use unsafe: true";
      } else if (error.message.includes("Cannot read properties")) {
        hint = "\n\n\u{1F4A1} HINT: Element might not exist. Check if element exists first:\nconst el = document.querySelector(selector);\nif (el) { /* use element */ }";
      } else if (error.message.includes("api.") && useUnsafeMode) {
        hint = "\n\n\u{1F4A1} HINT: In unsafe mode, use standard DOM APIs directly:\ndocument.querySelector() instead of api.$()";
      }
      return {
        content: [
          {
            type: "text",
            text: errorMessage + hint
          }
        ],
        isError: true
      };
    }
  }
};
var CommonOperationsTool = z5.object({
  name: z5.literal("browser_common_operation"),
  description: z5.literal("Perform common browser operations using pre-built scripts. Includes debugging utilities like popup detection and element validation."),
  arguments: z5.object({
    operation: z5.enum([
      "hide_popups",
      "remove_ads",
      "extract_all_text",
      "extract_all_links",
      "extract_all_images",
      "highlight_interactive",
      "auto_fill_form",
      "scroll_to_bottom",
      "expand_all_sections"
    ]).describe("The operation to perform"),
    options: z5.record(z5.any()).optional().describe("Operation-specific options")
  })
});
var commonOperations = {
  schema: {
    name: CommonOperationsTool.shape.name.value,
    description: CommonOperationsTool.shape.description.value,
    inputSchema: zodToJsonSchema7(CommonOperationsTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = CommonOperationsTool.shape.arguments.parse(params || {});
    const operations = {
      hide_popups: `
        (function() {
          // Hide common popup/modal elements
          const popupSelectors = [
            '[class*="modal"]', '[class*="popup"]', '[class*="overlay"]',
            '[class*="dialog"]', '[id*="modal"]', '[id*="popup"]',
            '.cookie-banner', '#cookie-banner', '[class*="cookie"]'
          ];
          let hidden = 0;
          popupSelectors.forEach(selector => {
            hidden += api.hide(selector);
          });
          return { hidden: hidden, message: 'Hidden ' + hidden + ' popup elements' };
        })();
      `,
      remove_ads: `
        (function() {
          // Remove common ad elements
          const adSelectors = [
            '[class*="ad-"]', '[class*="ads-"]', '[class*="advertisement"]',
            '[id*="ad-"]', '[id*="ads-"]', 'iframe[src*="doubleclick"]',
            'iframe[src*="googlesyndication"]', '.sponsored', '[data-ad]'
          ];
          let removed = 0;
          adSelectors.forEach(selector => {
            removed += api.hide(selector);
          });
          return { removed: removed, message: 'Removed ' + removed + ' ad elements' };
        })();
      `,
      extract_all_text: `
        (function() {
          // Extract all visible text from the page
          const texts = api.$$('p, h1, h2, h3, h4, h5, h6, li, td, th, span, div')
            .map(el => el.textContent?.trim())
            .filter(text => text && text.length > 0);
          return { 
            totalElements: texts.length,
            totalChars: texts.join(' ').length,
            sample: texts.slice(0, 10),
            full: texts.join('\\n')
          };
        })();
      `,
      extract_all_links: `
        (function() {
          // Extract all links from the page
          return api.extractLinks('body');
        })();
      `,
      extract_all_images: `
        (function() {
          // Extract all images from the page
          const images = api.$$('img').map(img => ({
            src: img.src,
            alt: img.alt || '',
            width: img.width,
            height: img.height
          }));
          return { count: images.length, images: images };
        })();
      `,
      highlight_interactive: `
        (function() {
          // Highlight all interactive elements
          const style = document.createElement('style');
          style.textContent = \`
            .mcp-highlight {
              outline: 2px solid red !important;
              outline-offset: 2px !important;
            }
          \`;
          document.head.appendChild(style);
          
          const interactive = api.$$('a, button, input, select, textarea, [role="button"], [onclick]');
          interactive.forEach(el => el.classList.add('mcp-highlight'));
          
          return { 
            highlighted: interactive.length,
            message: 'Highlighted ' + interactive.length + ' interactive elements'
          };
        })();
      `,
      auto_fill_form: `
        (function() {
          // Auto-fill form with test data
          const filled = [];
          
          // Fill text inputs
          api.$$('input[type="text"], input:not([type])').forEach((input, i) => {
            const name = input.name || input.id || ('field' + i);
            const selector = input.id ? ('#' + input.id) : ('[name="' + input.name + '"]');
            api.setValue(selector, 'Test ' + name);
            filled.push(name);
          });
          
          // Fill email inputs
          api.$$('input[type="email"]').forEach(input => {
            const selector = input.id ? ('#' + input.id) : ('[name="' + input.name + '"]');
            api.setValue(selector, 'test@example.com');
            filled.push(input.name || input.id);
          });
          
          // Fill tel inputs
          api.$$('input[type="tel"]').forEach(input => {
            const selector = input.id ? ('#' + input.id) : ('[name="' + input.name + '"]');
            api.setValue(selector, '555-0123');
            filled.push(input.name || input.id);
          });
          
          return { filled: filled, count: filled.length };
        })();
      `,
      scroll_to_bottom: `
        (async function() {
          // Scroll to the bottom of the page
          window.scrollTo(0, document.body.scrollHeight);
          await api.wait(500);
          return { 
            scrolled: true, 
            height: document.body.scrollHeight,
            message: 'Scrolled to bottom of page'
          };
        })();
      `,
      expand_all_sections: `
        (function() {
          // Expand all collapsible sections
          const expanded = [];
          
          // Click all elements with expand-like attributes
          const expandSelectors = [
            '[aria-expanded="false"]',
            '.collapsed',
            '[class*="expand"]',
            '[class*="toggle"]',
            'summary'
          ];
          
          expandSelectors.forEach(selector => {
            api.$$(selector).forEach(el => {
              el.click();
              expanded.push(el.tagName);
            });
          });
          
          return { 
            expanded: expanded.length,
            message: 'Expanded ' + expanded.length + ' sections'
          };
        })();
      `
    };
    const code = operations[validatedParams.operation];
    if (!code) {
      throw new Error(`Unknown operation: ${validatedParams.operation}`);
    }
    const operationTimeout = 1e4;
    const response = await context.sendSocketMessage("js.execute", {
      code,
      timeout: operationTimeout
    }, { timeoutMs: operationTimeout + 500 });
    let resultText;
    if (typeof response.result === "object") {
      resultText = JSON.stringify(response.result, null, 2);
    } else {
      resultText = String(response.result);
    }
    return {
      content: [
        {
          type: "text",
          text: resultText
        }
      ]
    };
  }
};

// src/tools/element-finder.ts
import { zodToJsonSchema as zodToJsonSchema8 } from "zod-to-json-schema";
import { z as z6 } from "zod";
var ElementFinderTool = z6.object({
  name: z6.literal("browser_find_element"),
  description: z6.literal("Find elements and get their refs for use with high-level tools (browser_click, browser_type, etc.). This bridges the gap between seeing elements and interacting with them properly. Returns refs that can be used with interaction tools."),
  arguments: z6.object({
    strategy: z6.enum(["text", "css", "attribute", "aria", "placeholder"]).describe("Strategy to find element"),
    value: z6.string().describe("Value to search for based on strategy"),
    nth: z6.number().optional().default(0).describe("If multiple matches, which one to return (0-based index)"),
    parent_selector: z6.string().optional().describe("Optional parent container to search within"),
    return_all: z6.boolean().optional().default(false).describe("Return all matching elements instead of just one")
  })
});
var findElement = {
  schema: {
    name: ElementFinderTool.shape.name.value,
    description: ElementFinderTool.shape.description.value,
    inputSchema: zodToJsonSchema8(ElementFinderTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = ElementFinderTool.shape.arguments.parse(params || {});
    let searchCode = "";
    const { strategy, value, nth, parent_selector, return_all } = validatedParams;
    switch (strategy) {
      case "text":
        searchCode = `
          const elements = Array.from(document.querySelectorAll('*')).filter(el => {
            const text = el.textContent || el.innerText || '';
            return text.includes('${value}') && 
                   el.children.length === 0; // Leaf nodes only
          });
        `;
        break;
      case "css":
        searchCode = `
          const elements = Array.from(document.querySelectorAll('${value}'));
        `;
        break;
      case "attribute":
        const [attr, attrValue] = value.split("=");
        searchCode = `
          const elements = Array.from(document.querySelectorAll('[${attr}="${attrValue}"]'));
        `;
        break;
      case "aria":
        searchCode = `
          const elements = Array.from(document.querySelectorAll('[aria-label*="${value}"], [aria-describedby*="${value}"]'));
        `;
        break;
      case "placeholder":
        searchCode = `
          const elements = Array.from(document.querySelectorAll('[placeholder*="${value}"]'));
        `;
        break;
    }
    if (parent_selector) {
      searchCode = `
        const parent = document.querySelector('${parent_selector}');
        if (!parent) {
          return { error: 'Parent selector not found' };
        }
        ${searchCode}
        const filtered = elements.filter(el => parent.contains(el));
        const elements = filtered;
      `;
    }
    const fullCode = `
      ${searchCode}
      
      if (elements.length === 0) {
        return { 
          found: false, 
          message: 'No elements found matching criteria',
          strategy: '${strategy}',
          value: '${value}'
        };
      }
      
      // Generate refs for elements
      const results = elements.map((el, index) => {
        // Try to generate a stable ref
        let ref = '';
        
        // Priority 1: ID
        if (el.id) {
          ref = '#' + el.id;
        }
        // Priority 2: Unique class combination
        else if (el.className) {
          ref = '.' + el.className.split(' ').join('.');
        }
        // Priority 3: Data attributes
        else if (el.dataset && Object.keys(el.dataset).length > 0) {
          const dataAttr = Object.keys(el.dataset)[0];
          ref = '[data-' + dataAttr + '="' + el.dataset[dataAttr] + '"]';
        }
        // Priority 4: Other attributes
        else if (el.hasAttribute('name')) {
          ref = '[name="' + el.getAttribute('name') + '"]';
        }
        // Priority 5: Tag + position
        else {
          const parent = el.parentElement;
          const siblings = Array.from(parent.children).filter(child => child.tagName === el.tagName);
          const position = siblings.indexOf(el);
          ref = el.tagName.toLowerCase() + ':nth-of-type(' + (position + 1) + ')';
          
          // Add parent context if needed
          if (parent.id) {
            ref = '#' + parent.id + ' > ' + ref;
          }
        }
        
        // Generate a unique ref ID for this session
        const refId = 'ref' + (1000 + index);
        el.setAttribute('data-browsermcp-ref', refId);
        
        return {
          ref: refId,
          selector: ref,
          text: (el.textContent || el.innerText || '').substring(0, 100),
          tagName: el.tagName.toLowerCase(),
          type: el.type || null,
          isVisible: el.offsetParent !== null,
          isInteractive: ['a', 'button', 'input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) ||
                        el.onclick !== null || 
                        el.hasAttribute('onclick') ||
                        el.style.cursor === 'pointer'
        };
      });
      
      ${return_all ? "return results;" : "return results[" + nth + "] || results[0];"}
    `;
    try {
      console.log(`[Element Finder] Searching for elements with strategy: ${strategy}, value: ${value}`);
      const response = await context.sendSocketMessage("js.execute", {
        code: fullCode,
        timeout: 3e3,
        unsafe: true
        // Need unsafe to set attributes
      }, { timeoutMs: 3500 });
      if (!response.result) {
        return {
          content: [{
            type: "text",
            text: "No elements found"
          }]
        };
      }
      if (response.result.error) {
        return {
          content: [{
            type: "text",
            text: `Error: ${response.result.error}`
          }]
        };
      }
      if (response.result.found === false) {
        return {
          content: [{
            type: "text",
            text: response.result.message
          }]
        };
      }
      const results = return_all ? response.result : [response.result];
      let output = `Found ${results.length} element(s):

`;
      results.forEach((elem, index) => {
        output += `Element ${index + 1}:
`;
        output += `  Ref: ${elem.ref}
`;
        output += `  Tag: ${elem.tagName}
`;
        output += `  Text: ${elem.text}
`;
        output += `  Visible: ${elem.isVisible}
`;
        output += `  Interactive: ${elem.isInteractive}
`;
        output += `  CSS Selector: ${elem.selector}

`;
      });
      output += `
Use these refs with high-level tools:
`;
      output += `- browser_click(ref="${results[0].ref}", element="...")
`;
      output += `- browser_type(ref="${results[0].ref}", element="...", text="...")
`;
      return {
        content: [{
          type: "text",
          text: output
        }]
      };
    } catch (error) {
      console.error("[Element Finder] Error:", error);
      throw error;
    }
  }
};

// src/tools/product-verifier.ts
import { zodToJsonSchema as zodToJsonSchema9 } from "zod-to-json-schema";
import { z as z7 } from "zod";
var ProductVerifierTool = z7.object({
  name: z7.literal("browser_verify_product"),
  description: z7.literal("Verify that a product matches the intended search criteria before adding to cart. Prevents adding wrong items (e.g., battery-powered devices instead of batteries). Returns confidence score and detailed analysis."),
  arguments: z7.object({
    product_ref: z7.string().describe("Reference to the product element to verify"),
    expected_category: z7.string().describe("Expected product category (e.g., 'batteries', 'phones', 'cables')"),
    expected_keywords: z7.array(z7.string()).describe("Keywords that MUST appear in product (e.g., ['AAA', 'battery'])"),
    excluded_keywords: z7.array(z7.string()).optional().describe("Keywords that must NOT appear (e.g., ['holder', 'charger', 'case'])"),
    min_confidence: z7.number().optional().default(0.7).describe("Minimum confidence threshold (0-1)")
  })
});
var verifyProduct = {
  schema: {
    name: ProductVerifierTool.shape.name.value,
    description: ProductVerifierTool.shape.description.value,
    inputSchema: zodToJsonSchema9(ProductVerifierTool.shape.arguments)
  },
  handle: async (context, params) => {
    const validatedParams = ProductVerifierTool.shape.arguments.parse(params || {});
    const verificationCode = `
      const element = document.querySelector('[data-browsermcp-ref="${validatedParams.product_ref}"]') ||
                      document.querySelector('${validatedParams.product_ref}');
      
      if (!element) {
        return { error: 'Product element not found' };
      }
      
      // Gather all text from the product element
      const productText = (element.textContent || element.innerText || '').toLowerCase();
      const productTitle = element.querySelector('h1, h2, h3, h4, .title, .name, [class*="title"], [class*="name"]')?.textContent?.toLowerCase() || '';
      
      // Check for category indicators
      const breadcrumbs = Array.from(document.querySelectorAll('.breadcrumb, nav [aria-label*="breadcrumb"], [class*="category"]'))
        .map(el => el.textContent?.toLowerCase() || '')
        .join(' ');
      
      // Look for product specifications
      const specs = Array.from(element.querySelectorAll('dl, .specs, .attributes, [class*="spec"], [class*="attribute"]'))
        .map(el => el.textContent?.toLowerCase() || '')
        .join(' ');
      
      // Calculate confidence scores
      let confidence = 0;
      const signals = [];
      
      // Check expected keywords
      const expectedKeywords = ${JSON.stringify(validatedParams.expected_keywords.map((k) => k.toLowerCase()))};
      const foundKeywords = expectedKeywords.filter(keyword => {
        // Check in title (highest weight)
        if (productTitle.includes(keyword)) {
          signals.push({ type: 'title_match', keyword, weight: 0.4 });
          return true;
        }
        // Check in general text
        if (productText.includes(keyword)) {
          signals.push({ type: 'text_match', keyword, weight: 0.2 });
          return true;
        }
        return false;
      });
      
      confidence += (foundKeywords.length / expectedKeywords.length) * 0.5;
      
      // Check excluded keywords
      const excludedKeywords = ${JSON.stringify((validatedParams.excluded_keywords || []).map((k) => k.toLowerCase()))};
      const foundExcluded = excludedKeywords.filter(keyword => productText.includes(keyword));
      
      if (foundExcluded.length > 0) {
        confidence -= 0.3 * foundExcluded.length;
        foundExcluded.forEach(keyword => {
          signals.push({ type: 'excluded_found', keyword, weight: -0.3 });
        });
      }
      
      // Check category match
      const expectedCategory = '${validatedParams.expected_category.toLowerCase()}';
      if (breadcrumbs.includes(expectedCategory) || productText.includes(expectedCategory)) {
        confidence += 0.3;
        signals.push({ type: 'category_match', weight: 0.3 });
      }
      
      // Check for common false positives
      const falsePositiveIndicators = ['uses', 'requires', 'powered by', 'compatible with', 'for use with'];
      const hasFalsePositive = falsePositiveIndicators.some(indicator => 
        productText.includes(indicator + ' ' + expectedKeywords.join(' '))
      );
      
      if (hasFalsePositive) {
        confidence -= 0.4;
        signals.push({ type: 'false_positive_pattern', weight: -0.4 });
      }
      
      // Ensure confidence is between 0 and 1
      confidence = Math.max(0, Math.min(1, confidence));
      
      return {
        confidence,
        productTitle: productTitle.substring(0, 200),
        foundKeywords,
        missingKeywords: expectedKeywords.filter(k => !foundKeywords.includes(k)),
        excludedFound: foundExcluded,
        signals,
        recommendation: confidence >= ${validatedParams.min_confidence} ? 'PROCEED' : 'SKIP',
        warning: hasFalsePositive ? 'This appears to be a product that USES the item, not the item itself' : null
      };
    `;
    try {
      console.log(`[Product Verifier] Verifying product with ref: ${validatedParams.product_ref}`);
      const response = await context.sendSocketMessage("js.execute", {
        code: verificationCode,
        timeout: 3e3,
        unsafe: true
      }, { timeoutMs: 3500 });
      if (response.result?.error) {
        return {
          content: [{
            type: "text",
            text: `Error: ${response.result.error}`
          }]
        };
      }
      const result = response.result;
      let report = `Product Verification Report
`;
      report += `${"=".repeat(40)}

`;
      report += `Product: ${result.productTitle}
`;
      report += `Confidence: ${(result.confidence * 100).toFixed(1)}%
`;
      report += `Recommendation: ${result.recommendation}

`;
      if (result.warning) {
        report += `\u26A0\uFE0F WARNING: ${result.warning}

`;
      }
      report += `Expected Keywords:
`;
      result.foundKeywords.forEach((kw) => {
        report += `  \u2713 ${kw}
`;
      });
      result.missingKeywords.forEach((kw) => {
        report += `  \u2717 ${kw} (not found)
`;
      });
      if (result.excludedFound.length > 0) {
        report += `
Excluded Keywords Found:
`;
        result.excludedFound.forEach((kw) => {
          report += `  \u26A0\uFE0F ${kw}
`;
        });
      }
      report += `
Confidence Breakdown:
`;
      result.signals.forEach((signal) => {
        const sign = signal.weight > 0 ? "+" : "";
        report += `  ${signal.type}: ${sign}${(signal.weight * 100).toFixed(0)}%
`;
      });
      if (result.recommendation === "SKIP") {
        report += `
\u274C DO NOT ADD TO CART - Product does not match criteria
`;
        report += `Suggestion: Continue searching or refine search terms
`;
      } else {
        report += `
\u2705 SAFE TO PROCEED - Product matches criteria
`;
      }
      return {
        content: [{
          type: "text",
          text: report
        }]
      };
    } catch (error) {
      console.error("[Product Verifier] Error:", error);
      throw error;
    }
  }
};

// src/tools/file-upload.ts
import { zodToJsonSchema as zodToJsonSchema10 } from "zod-to-json-schema";
import { z as z8 } from "zod";
var FileInputDetectionTool = z8.object({
  name: z8.literal("browser_detect_file_inputs"),
  description: z8.literal("Detect and analyze all file input elements on the page. Essential before file uploads to understand acceptance criteria and constraints."),
  arguments: z8.object({
    includeHidden: z8.boolean().optional().default(false).describe("Whether to include hidden file inputs"),
    analyzeConstraints: z8.boolean().optional().default(true).describe("Whether to analyze file type and size constraints")
  })
});
var detectFileInputs = {
  schema: {
    name: FileInputDetectionTool.shape.name.value,
    description: FileInputDetectionTool.shape.description.value,
    inputSchema: zodToJsonSchema10(FileInputDetectionTool.shape.arguments)
  },
  handle: async (context, params) => {
    try {
      const validatedParams = FileInputDetectionTool.shape.arguments.parse(params || {});
      const detectionScript = generateFileInputDetectionScript(validatedParams);
      const response = await context.sendWithContext(
        "js.execute",
        {
          code: detectionScript,
          timeout: 5e3
        },
        "detecting file input elements on page"
      );
      let resultText;
      if (typeof response.result === "object") {
        const result = response.result;
        if (result.fileInputs && Array.isArray(result.fileInputs)) {
          if (result.fileInputs.length === 0) {
            resultText = "No file input elements found on this page.";
          } else {
            resultText = `Found ${result.fileInputs.length} file input element(s):\\n\\n`;
            result.fileInputs.forEach((input, index) => {
              resultText += `${index + 1}. **${input.type}** input\\n`;
              resultText += `   - Ref: [${input.ref}]\\n`;
              resultText += `   - Accept: ${input.accept || "any file type"}\\n`;
              resultText += `   - Multiple: ${input.multiple ? "Yes" : "No"}\\n`;
              resultText += `   - Required: ${input.required ? "Yes" : "No"}\\n`;
              if (input.maxSize) {
                resultText += `   - Max Size: ${formatFileSize(input.maxSize)}\\n`;
              }
              if (input.dropZone) {
                resultText += `   - Drop Zone: Available\\n`;
              }
              resultText += `\\n`;
            });
          }
        } else {
          resultText = JSON.stringify(response.result, null, 2);
        }
      } else {
        resultText = String(response.result || "File input detection completed");
      }
      return {
        content: [
          {
            type: "text",
            text: `\u{1F50D} File Input Detection Results:\\n\\n${resultText}`
          }
        ]
      };
    } catch (error) {
      return ErrorRecovery.handleToolError(
        error,
        "browser_detect_file_inputs",
        "analyzing file input elements"
      );
    }
  }
};
function generateFileInputDetectionScript(params) {
  return `
    (function() {
      // Find all file input elements
      let selector = 'input[type="file"]';
      ${!params.includeHidden ? `
      // Filter out hidden inputs
      const allInputs = Array.from(document.querySelectorAll(selector));
      const visibleInputs = allInputs.filter(input => {
        const style = window.getComputedStyle(input);
        return style.display !== 'none' && 
               style.visibility !== 'hidden' && 
               style.opacity !== '0' &&
               input.offsetParent !== null;
      });
      ` : `
      const visibleInputs = Array.from(document.querySelectorAll(selector));
      `}
      
      const fileInputs = [];
      
      visibleInputs.forEach((input, index) => {
        const info = {
          ref: api.getRef ? api.getRef(input) : ('ref' + (index + 1)),
          type: 'file',
          accept: input.accept || null,
          multiple: input.multiple,
          required: input.required,
          disabled: input.disabled,
          name: input.name || null,
          id: input.id || null,
          className: input.className || null
        };
        
        ${params.analyzeConstraints ? `
        // Analyze constraints from accept attribute
        if (input.accept) {
          const types = input.accept.split(',').map(t => t.trim());
          info.acceptedTypes = types;
          info.acceptsImages = types.some(t => t.startsWith('image/') || t === 'image/*');
          info.acceptsDocuments = types.some(t => 
            t.includes('pdf') || t.includes('doc') || t.includes('txt') ||
            t === 'application/*' || t.includes('text/')
          );
        }
        
        // Look for size constraints in surrounding elements or data attributes
        const maxSizeAttr = input.getAttribute('data-max-size') || 
                          input.getAttribute('max-size') ||
                          input.dataset.maxSize;
        if (maxSizeAttr) {
          info.maxSize = parseInt(maxSizeAttr);
        }
        
        // Check if there's a drop zone associated
        const parent = input.closest('[ondrop], .drop-zone, .dropzone, [data-drop]');
        if (parent) {
          info.dropZone = {
            element: parent.tagName,
            className: parent.className
          };
        }
        ` : ""}
        
        fileInputs.push(info);
      });
      
      // Also look for drop zones without direct file inputs
      const dropZones = Array.from(document.querySelectorAll(
        '[ondrop], .drop-zone, .dropzone, [data-drop], [data-file-drop]'
      )).filter(zone => !zone.querySelector('input[type="file"]'));
      
      dropZones.forEach((zone, index) => {
        fileInputs.push({
          ref: api.getRef ? api.getRef(zone) : ('dropzone' + (index + 1)),
          type: 'dropzone',
          tagName: zone.tagName,
          className: zone.className,
          multiple: true, // Drop zones typically support multiple files
          accept: zone.getAttribute('data-accept') || null
        });
      });
      
      return {
        fileInputs: fileInputs,
        summary: {
          totalInputs: fileInputs.filter(i => i.type === 'file').length,
          totalDropZones: fileInputs.filter(i => i.type === 'dropzone').length,
          multipleAllowed: fileInputs.filter(i => i.multiple).length,
          requiredInputs: fileInputs.filter(i => i.required).length
        }
      };
    })();
  `;
}
function formatFileSize(bytes) {
  const sizes = ["Bytes", "KB", "MB", "GB"];
  if (bytes === 0) return "0 Bytes";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + " " + sizes[i];
}
var fileUploadTools = [
  detectFileInputs
];

// src/tools/multitool-v3.ts
import { z as z9 } from "zod";
import { zodToJsonSchema as zodToJsonSchema11 } from "zod-to-json-schema";
var paramsSchema = z9.object({
  intent: z9.enum(["login", "form_fill", "search", "navigation", "dismiss_modal"]).describe("High-level goal to accomplish"),
  snapshot: z9.any().optional().describe("ARIA snapshot from browser_snapshot (required for most patterns)"),
  // Pattern-specific parameters
  fields: z9.record(z9.string()).optional().describe("Field name to value mapping for form_fill"),
  username: z9.string().optional().describe("Username/email for login"),
  password: z9.string().optional().describe("Password for login"),
  rememberMe: z9.boolean().optional().describe("Check remember me for login"),
  query: z9.string().optional().describe("Search query text"),
  waitForResults: z9.number().optional().describe("Seconds to wait after search"),
  dismissTexts: z9.array(z9.string()).optional().describe("Button texts to try for dismissing modals"),
  steps: z9.array(z9.object({
    type: z9.enum(["navigate", "click", "wait", "back"]),
    url: z9.string().optional(),
    ref: z9.string().optional(),
    element: z9.string().optional(),
    duration: z9.number().optional()
  })).optional().describe("Steps for navigation pattern")
});
function findElementInSnapshot(snapshot2, query) {
  if (!snapshot2?.content?.[0]?.text) return null;
  const lines = snapshot2.content[0].text.split("\n");
  const normalize = (str) => str.toLowerCase().replace(/[\s_-]+/g, "");
  for (const line of lines) {
    const refMatch = line.match(/\[ref=(ref\d+)\]/);
    if (!refMatch) continue;
    const ref = refMatch[1];
    const quotedTextMatch = line.match(/"([^"]+)"/);
    const quotedText = quotedTextMatch ? quotedTextMatch[1] : "";
    const attributesMatch = line.match(/\{([^}]+)\}/);
    const attributes = {};
    if (attributesMatch) {
      const attrPairs = attributesMatch[1].split(",").map((p) => p.trim());
      for (const pair of attrPairs) {
        const [key, value] = pair.split(":").map((s) => s.trim());
        if (key && value) {
          attributes[key] = value;
        }
      }
    }
    if (query.id && attributes.id) {
      if (normalize(attributes.id) === normalize(query.id)) {
        return ref;
      }
    }
    if (query.name && attributes.name) {
      if (normalize(attributes.name) === normalize(query.name)) {
        return ref;
      }
    }
    if (query.placeholder && quotedText) {
      if (normalize(quotedText).includes(normalize(query.placeholder))) {
        return ref;
      }
      if (normalize(query.placeholder).includes("name") && normalize(quotedText).includes("name")) {
        return ref;
      }
      if (normalize(query.placeholder).includes("email") && normalize(quotedText).includes("email")) {
        return ref;
      }
      if (normalize(query.placeholder).includes("password") && normalize(quotedText).includes("password")) {
        return ref;
      }
      if (normalize(query.placeholder).includes("phone") && normalize(quotedText).includes("phone")) {
        return ref;
      }
    }
    if (query.text) {
      if (normalize(line).includes(normalize(query.text))) {
        return ref;
      }
    }
    if (query.type && attributes.type === query.type) {
      return ref;
    }
    if (query.role) {
      const elementType = line.split(" ")[0].toLowerCase();
      if (elementType === query.role.toLowerCase()) {
        return ref;
      }
    }
  }
  return null;
}
function generateLoginPlan(params, snapshot2) {
  const plan = [];
  const usernameRef = findElementInSnapshot(snapshot2, {
    placeholder: "username"
  }) || findElementInSnapshot(snapshot2, {
    placeholder: "email"
  }) || findElementInSnapshot(snapshot2, {
    type: "text"
  });
  if (usernameRef && params.username) {
    plan.push({
      name: "browser_type",
      args: {
        ref: usernameRef,
        element: "username field",
        text: params.username,
        submit: false
      },
      description: "Enter username/email"
    });
  }
  const passwordRef = findElementInSnapshot(snapshot2, {
    type: "password"
  });
  if (passwordRef && params.password) {
    plan.push({
      name: "browser_type",
      args: {
        ref: passwordRef,
        element: "password field",
        text: params.password,
        submit: false
      },
      description: "Enter password"
    });
  }
  if (params.rememberMe) {
    const rememberRef = findElementInSnapshot(snapshot2, {
      text: "remember"
    }) || findElementInSnapshot(snapshot2, {
      type: "checkbox"
    });
    if (rememberRef) {
      plan.push({
        name: "browser_click",
        args: {
          ref: rememberRef,
          element: "remember me checkbox"
        },
        description: "Check remember me"
      });
    }
  }
  const submitRef = findElementInSnapshot(snapshot2, {
    text: "sign in"
  }) || findElementInSnapshot(snapshot2, {
    text: "login"
  }) || findElementInSnapshot(snapshot2, {
    role: "button"
  });
  if (submitRef) {
    plan.push({
      name: "browser_click",
      args: {
        ref: submitRef,
        element: "login button"
      },
      description: "Click login button"
    });
  } else {
    plan.push({
      name: "browser_press_key",
      args: { key: "Enter" },
      description: "Press Enter to submit"
    });
  }
  return plan;
}
function generateFormFillPlan(params, snapshot2) {
  const plan = [];
  if (!params.fields) return plan;
  for (const [fieldName, value] of Object.entries(params.fields)) {
    const fieldRef = (
      // Try by ID first (most specific)
      findElementInSnapshot(snapshot2, { id: fieldName }) || // Try by name attribute
      findElementInSnapshot(snapshot2, { name: fieldName }) || // Try by placeholder text
      findElementInSnapshot(snapshot2, { placeholder: fieldName }) || // Try by text/label
      findElementInSnapshot(snapshot2, { text: fieldName })
    );
    if (fieldRef) {
      plan.push({
        name: "browser_type",
        args: {
          ref: fieldRef,
          element: `${fieldName} field`,
          text: value,
          submit: false
        },
        description: `Fill ${fieldName}`
      });
    }
  }
  if (params.submitButton) {
    const submitRef = findElementInSnapshot(snapshot2, {
      text: params.submitButton
    }) || findElementInSnapshot(snapshot2, {
      role: "button"
    });
    if (submitRef) {
      plan.push({
        name: "browser_click",
        args: {
          ref: submitRef,
          element: "submit button"
        },
        description: "Submit form"
      });
    }
  }
  return plan;
}
function generateSearchPlan(params, snapshot2) {
  const plan = [];
  if (!params.query) return plan;
  const searchRef = findElementInSnapshot(snapshot2, {
    type: "search"
  }) || findElementInSnapshot(snapshot2, {
    placeholder: "search"
  }) || findElementInSnapshot(snapshot2, {
    text: "search"
  });
  if (searchRef) {
    plan.push({
      name: "browser_type",
      args: {
        ref: searchRef,
        element: "search field",
        text: params.query,
        submit: true
        // Submit the search
      },
      description: "Enter search query and submit"
    });
    if (params.waitForResults) {
      plan.push({
        name: "browser_wait",
        args: { time: params.waitForResults },
        description: `Wait ${params.waitForResults}s for results`
      });
    }
  }
  return plan;
}
function generateDismissModalPlan(params, snapshot2) {
  const plan = [];
  plan.push({
    name: "browser_press_key",
    args: { key: "Escape" },
    description: "Press Escape to close modal"
  });
  if (params.dismissTexts && params.dismissTexts.length > 0) {
    for (const text of params.dismissTexts) {
      const buttonRef = findElementInSnapshot(snapshot2, { text });
      if (buttonRef) {
        plan.push({
          name: "browser_click",
          args: {
            ref: buttonRef,
            element: `${text} button`
          },
          description: `Click ${text} button`
        });
        break;
      }
    }
  }
  return plan;
}
function generateNavigationPlan(params) {
  const plan = [];
  if (!params.steps) return plan;
  for (const step of params.steps) {
    if (step.type === "navigate" && step.url) {
      plan.push({
        name: "browser_navigate",
        args: { url: step.url },
        description: `Navigate to ${step.url}`
      });
    } else if (step.type === "click" && step.ref) {
      plan.push({
        name: "browser_click",
        args: {
          ref: step.ref,
          element: step.element || "element"
        },
        description: `Click ${step.element || "element"}`
      });
    } else if (step.type === "wait" && step.duration) {
      plan.push({
        name: "browser_wait",
        args: { time: step.duration },
        description: `Wait ${step.duration}s`
      });
    } else if (step.type === "back") {
      plan.push({
        name: "browser_go_back",
        args: {},
        description: "Go back"
      });
    }
  }
  return plan;
}
var browser_multitool_v3 = {
  schema: {
    name: "browser_multitool",
    description: `\u{1F3AF} INTELLIGENT PATTERN RECOGNIZER - Generates optimized sequences of browser tool calls

\u26A1 HOW IT WORKS:
1. You run browser_snapshot first to understand the page
2. You call browser_multitool with the snapshot and your intent
3. It returns a plan of tool calls
4. You execute the plan with browser_execute_plan

\u{1F4CA} BENEFITS:
\u2022 70-90% fewer tokens than manual tool calls
\u2022 Intelligent element detection from snapshots
\u2022 Clean, reusable plans
\u2022 No duplicate DOM logic

\u{1F3A8} SUPPORTED PATTERNS:
\u2022 login - Username/password authentication
\u2022 form_fill - Fill and submit forms
\u2022 search - Enter queries and wait for results
\u2022 dismiss_modal - Close popups and modals
\u2022 navigation - Multi-step navigation sequences`,
    inputSchema: zodToJsonSchema11(paramsSchema)
  },
  handle: async (context, params) => {
    const { intent, snapshot: snapshot2 } = params;
    const needsSnapshot = ["login", "form_fill", "search", "dismiss_modal"].includes(intent);
    if (needsSnapshot && !snapshot2) {
      const result = {
        status: "needs_snapshot",
        pattern: intent,
        hint: "Run browser_snapshot first, then call me again with the snapshot"
      };
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
    let plan = [];
    try {
      switch (intent) {
        case "login":
          plan = generateLoginPlan(params, snapshot2);
          break;
        case "form_fill":
          plan = generateFormFillPlan(params, snapshot2);
          break;
        case "search":
          plan = generateSearchPlan(params, snapshot2);
          break;
        case "dismiss_modal":
          plan = generateDismissModalPlan(params, snapshot2);
          break;
        case "navigation":
          plan = generateNavigationPlan(params);
          break;
        default:
          const result2 = {
            status: "unsupported_intent",
            pattern: intent,
            error: `Intent '${intent}' is not supported`
          };
          return {
            content: [{
              type: "text",
              text: JSON.stringify(result2, null, 2)
            }],
            isError: true
          };
      }
      const result = {
        status: "plan_generated",
        pattern: intent,
        plan
      };
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      const result = {
        status: "error",
        pattern: intent,
        error: error instanceof Error ? error.message : String(error)
      };
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }],
        isError: true
      };
    }
  }
};

// src/tools/execute-plan.ts
import { z as z10 } from "zod";
import { zodToJsonSchema as zodToJsonSchema12 } from "zod-to-json-schema";
var toolCallSchema = z10.object({
  name: z10.string().describe("Name of the tool to call"),
  args: z10.any().describe("Arguments to pass to the tool"),
  description: z10.string().optional().describe("Optional description of this step")
});
var paramsSchema2 = z10.object({
  plan: z10.array(toolCallSchema).describe("Array of tool calls to execute in sequence"),
  stopOnError: z10.boolean().default(true).describe("Stop execution on first error"),
  captureIntermediateResults: z10.boolean().default(false).describe("Include results from each step")
});
var browser_execute_plan = {
  schema: {
    name: "browser_execute_plan",
    description: "Execute a sequence of browser tool calls generated by browser_multitool or other orchestrators",
    inputSchema: zodToJsonSchema12(paramsSchema2)
  },
  handle: async (context, params) => {
    const { plan, stopOnError, captureIntermediateResults } = params;
    if (!plan || plan.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "error",
            error: "No plan provided or empty plan"
          })
        }],
        isError: true
      };
    }
    const results = [];
    const errors = [];
    let executedSteps = 0;
    let lastSnapshot = null;
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      try {
        if (!context.toolbox[step.name]) {
          const error = `Tool '${step.name}' not found`;
          errors.push({ step: i, tool: step.name, error });
          if (stopOnError) {
            break;
          }
          continue;
        }
        const result = await context.callTool(step.name, step.args);
        executedSteps++;
        if (captureIntermediateResults) {
          results.push({
            step: i,
            tool: step.name,
            description: step.description,
            result
          });
        }
        if (step.name === "browser_snapshot" && result?.content) {
          lastSnapshot = result.content;
        }
        if (result?.isError) {
          const errorText = typeof result.content === "string" ? result.content : result.content?.[0]?.text || "Unknown error";
          errors.push({
            step: i,
            tool: step.name,
            error: errorText
          });
          if (stopOnError) {
            break;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({
          step: i,
          tool: step.name,
          error: errorMessage
        });
        if (stopOnError) {
          break;
        }
      }
    }
    const status = errors.length === 0 ? "success" : executedSteps > 0 ? "partial" : "error";
    const executionResult = {
      status,
      executedSteps,
      totalSteps: plan.length
    };
    if (captureIntermediateResults && results.length > 0) {
      executionResult.results = results;
    }
    if (errors.length > 0) {
      executionResult.errors = errors;
    }
    if (lastSnapshot) {
      executionResult.finalSnapshot = lastSnapshot;
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify(executionResult, null, 2)
      }],
      isError: status === "error"
    };
  }
};

// src/hints/core/hint-store.ts
import { createHash as createHash2 } from "crypto";

// src/hints/storage/database.ts
import Database from "better-sqlite3";
import { join as join2, dirname } from "path";
import { mkdirSync as mkdirSync2 } from "fs";
var HintDatabase = class _HintDatabase {
  db;
  static instance = null;
  constructor(dbPath) {
    const path2 = dbPath || process.env.HINT_DB_PATH || join2(process.cwd(), "hints.db");
    const dir = dirname(path2);
    mkdirSync2(dir, { recursive: true });
    this.db = new Database(path2);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }
  static getInstance(dbPath) {
    if (!_HintDatabase.instance) {
      _HintDatabase.instance = new _HintDatabase(dbPath);
    }
    return _HintDatabase.instance;
  }
  initSchema() {
    const schema = `
-- Browser Hints Database Schema
-- SQLite3 compatible

-- Primary hints table
CREATE TABLE IF NOT EXISTS hints (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    path_pattern TEXT,
    url_hash TEXT NOT NULL,
    pattern_type TEXT NOT NULL,
    selector_guard TEXT,
    dom_fingerprint TEXT,
    recipe TEXT NOT NULL,
    description TEXT NOT NULL,
    context TEXT,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    confidence REAL DEFAULT 0.5,
    author_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    last_success_at INTEGER,
    version INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    parent_hint_id TEXT,
    related_hints TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_domain ON hints(domain);
CREATE INDEX IF NOT EXISTS idx_url_hash ON hints(url_hash);
CREATE INDEX IF NOT EXISTS idx_confidence ON hints(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_last_used ON hints(last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_pattern_type ON hints(pattern_type);
CREATE INDEX IF NOT EXISTS idx_active ON hints(is_active);

-- Hint execution history
CREATE TABLE IF NOT EXISTS hint_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hint_id TEXT NOT NULL,
    executed_at INTEGER NOT NULL,
    success INTEGER NOT NULL,
    error_message TEXT,
    execution_time_ms INTEGER,
    author_id TEXT NOT NULL,
    FOREIGN KEY (hint_id) REFERENCES hints(id)
);

CREATE INDEX IF NOT EXISTS idx_history_hint ON hint_history(hint_id);
CREATE INDEX IF NOT EXISTS idx_history_time ON hint_history(executed_at DESC);

-- Conflicting hints tracking
CREATE TABLE IF NOT EXISTS hint_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    path_pattern TEXT,
    active_hint_id TEXT,
    challenger_hint_id TEXT,
    resolved_at INTEGER,
    resolution TEXT,
    FOREIGN KEY (active_hint_id) REFERENCES hints(id),
    FOREIGN KEY (challenger_hint_id) REFERENCES hints(id)
);

CREATE INDEX IF NOT EXISTS idx_conflicts_domain ON hint_conflicts(domain);
CREATE INDEX IF NOT EXISTS idx_conflicts_resolved ON hint_conflicts(resolved_at);
    `;
    this.db.exec(schema);
  }
  // Prepared statements for performance
  statements = {
    insertHint: null,
    getHintById: null,
    getHintsByUrl: null,
    getHintsByDomain: null,
    updateStats: null,
    updateConfidence: null
  };
  prepareStatements() {
    if (!this.statements.insertHint) {
      this.statements.insertHint = this.db.prepare(`
        INSERT INTO hints (
          id, domain, path_pattern, url_hash, pattern_type,
          selector_guard, dom_fingerprint, recipe, description,
          context, author_id, created_at, confidence
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
      this.statements.getHintById = this.db.prepare(`
        SELECT * FROM hints WHERE id = ? AND is_active = 1
      `);
      this.statements.getHintsByUrl = this.db.prepare(`
        SELECT * FROM hints 
        WHERE url_hash = ? AND is_active = 1
        ORDER BY confidence DESC
        LIMIT ?
      `);
      this.statements.getHintsByDomain = this.db.prepare(`
        SELECT * FROM hints 
        WHERE domain = ? AND is_active = 1
        ORDER BY confidence DESC
        LIMIT ?
      `);
      this.statements.updateStats = this.db.prepare(`
        UPDATE hints 
        SET 
          success_count = success_count + ?,
          failure_count = failure_count + ?,
          last_used_at = ?
        WHERE id = ?
      `);
      this.statements.updateConfidence = this.db.prepare(`
        UPDATE hints 
        SET confidence = (success_count + 1.0) / (success_count + failure_count + 2.0)
        WHERE id = ?
      `);
    }
  }
  // Public methods
  insertHint(hint) {
    this.prepareStatements();
    this.statements.insertHint.run(
      hint.id,
      hint.domain,
      hint.path_pattern || null,
      hint.url_hash,
      hint.pattern_type,
      hint.selector_guard || null,
      hint.dom_fingerprint || null,
      JSON.stringify(hint.recipe),
      hint.description,
      hint.context ? JSON.stringify(hint.context) : null,
      hint.author_id,
      hint.created_at,
      hint.confidence || 0.5
    );
  }
  getHintById(id) {
    this.prepareStatements();
    const row = this.statements.getHintById.get(id);
    return row ? this.parseHintRow(row) : null;
  }
  getHintsByUrl(urlHash, limit = 5) {
    this.prepareStatements();
    const rows = this.statements.getHintsByUrl.all(urlHash, limit);
    return rows.map((row) => this.parseHintRow(row));
  }
  getHintsByDomain(domain, limit = 5) {
    this.prepareStatements();
    const rows = this.statements.getHintsByDomain.all(domain, limit);
    return rows.map((row) => this.parseHintRow(row));
  }
  updateHintStats(id, success) {
    this.prepareStatements();
    const successDelta = success ? 1 : 0;
    const failureDelta = success ? 0 : 1;
    const now = Date.now();
    this.statements.updateStats.run(successDelta, failureDelta, now, id);
    this.statements.updateConfidence.run(id);
    if (success) {
      this.db.prepare("UPDATE hints SET last_success_at = ? WHERE id = ?").run(now, id);
    }
  }
  recordHistory(hintId, success, errorMessage, executionTime) {
    const stmt = this.db.prepare(`
      INSERT INTO hint_history (hint_id, executed_at, success, error_message, execution_time_ms, author_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      hintId,
      Date.now(),
      success ? 1 : 0,
      errorMessage || null,
      executionTime || null,
      process.env.CLAUDE_INSTANCE_ID || "unknown"
    );
  }
  deactivateHint(id) {
    this.db.prepare("UPDATE hints SET is_active = 0 WHERE id = ?").run(id);
  }
  pruneStaleHints(daysOld) {
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1e3;
    const result = this.db.prepare(`
      UPDATE hints 
      SET is_active = 0 
      WHERE last_used_at < ? AND confidence < 0.3
    `).run(cutoff);
    return result.changes;
  }
  parseHintRow(row) {
    return {
      ...row,
      recipe: JSON.parse(row.recipe),
      context: row.context ? JSON.parse(row.context) : null,
      related_hints: row.related_hints ? JSON.parse(row.related_hints) : [],
      is_active: row.is_active === 1
    };
  }
  close() {
    this.db.close();
    _HintDatabase.instance = null;
  }
};

// src/hints/core/hint-validator.ts
var HintValidator = class {
  MAX_RECIPE_STEPS = 20;
  MAX_DESCRIPTION_LENGTH = 200;
  BLOCKED_SELECTORS = ["html", "body", "*", "script"];
  PII_PATTERNS = [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
    // Email
    /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,
    // Phone
    /\b\d{3}-\d{2}-\d{4}\b/,
    // SSN
    /\b(?:\d{4}[-\s]?){3}\d{4}\b/
    // Credit card
  ];
  validateHint(hint) {
    const errors = [];
    const warnings = [];
    if (!hint.domain) errors.push("Domain is required");
    if (!hint.pattern_type) errors.push("Pattern type is required");
    if (!hint.recipe || !Array.isArray(hint.recipe)) errors.push("Recipe must be an array");
    if (!hint.description) errors.push("Description is required");
    if (hint.domain && !this.isValidDomain(hint.domain)) {
      errors.push("Invalid domain format");
    }
    if (hint.recipe) {
      if (hint.recipe.length === 0) {
        errors.push("Recipe cannot be empty");
      }
      if (hint.recipe.length > this.MAX_RECIPE_STEPS) {
        errors.push(`Recipe cannot have more than ${this.MAX_RECIPE_STEPS} steps`);
      }
      for (const step of hint.recipe) {
        const stepErrors = this.validateToolCall(step);
        errors.push(...stepErrors);
      }
    }
    if (hint.description && hint.description.length > this.MAX_DESCRIPTION_LENGTH) {
      errors.push(`Description cannot exceed ${this.MAX_DESCRIPTION_LENGTH} characters`);
    }
    if (hint.description && this.detectPII(hint.description)) {
      errors.push("Description contains potential PII");
    }
    if (hint.selector_guard && !this.isValidSelector(hint.selector_guard)) {
      errors.push("Invalid CSS selector");
    }
    if (hint.selector_guard && this.isBlockedSelector(hint.selector_guard)) {
      errors.push("Selector targets blocked element");
    }
    if (hint.confidence !== void 0) {
      if (hint.confidence < 0 || hint.confidence > 1) {
        errors.push("Confidence must be between 0 and 1");
      }
    }
    if (hint.recipe && hint.recipe.length > 10) {
      warnings.push("Recipe has many steps, consider simplifying");
    }
    if (!hint.selector_guard) {
      warnings.push("No selector guard specified, hint may apply incorrectly");
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
  validateToolCall(step) {
    const errors = [];
    if (!step.tool) {
      errors.push("Tool call must specify tool name");
    }
    if (!step.args || typeof step.args !== "object") {
      errors.push("Tool call must have args object");
    }
    if (step.args) {
      const argsStr = JSON.stringify(step.args);
      if (this.detectPII(argsStr)) {
        errors.push("Tool args contain potential PII");
      }
      if ("password" in step.args || "secret" in step.args || "token" in step.args) {
        errors.push("Tool args cannot contain passwords or secrets");
      }
    }
    if (step.wait_after !== void 0) {
      if (typeof step.wait_after !== "number" || step.wait_after < 0 || step.wait_after > 3e4) {
        errors.push("wait_after must be between 0 and 30000 ms");
      }
    }
    return errors;
  }
  sanitizeRecipe(recipe) {
    return recipe.map((step) => this.sanitizeToolCall(step));
  }
  sanitizeToolCall(step) {
    const sanitized = {
      tool: step.tool,
      args: { ...step.args }
    };
    const sensitiveFields = ["text", "password", "secret", "token", "apiKey", "credential"];
    for (const field of sensitiveFields) {
      if (field in sanitized.args) {
        if (field === "text") {
          sanitized.args.text_length = sanitized.args[field]?.length;
        }
        delete sanitized.args[field];
      }
    }
    if (step.wait_after) sanitized.wait_after = step.wait_after;
    if (step.retry_on_failure) sanitized.retry_on_failure = step.retry_on_failure;
    if (step.fallback) sanitized.fallback = this.sanitizeToolCall(step.fallback);
    return sanitized;
  }
  detectPII(text) {
    for (const pattern of this.PII_PATTERNS) {
      if (pattern.test(text)) {
        return true;
      }
    }
    return false;
  }
  isValidDomain(domain) {
    try {
      new URL(`https://${domain}`);
      return true;
    } catch {
      return false;
    }
  }
  isValidSelector(selector) {
    try {
      if (!selector || selector.trim().length === 0) return false;
      if (selector.includes("<") || selector.includes(">")) return false;
      if (selector.includes("javascript:")) return false;
      return true;
    } catch {
      return false;
    }
  }
  isBlockedSelector(selector) {
    const normalized = selector.toLowerCase().trim();
    return this.BLOCKED_SELECTORS.some(
      (blocked) => normalized === blocked || normalized.startsWith(blocked + " ")
    );
  }
  assessHintQuality(hint) {
    let completeness = 1;
    let clarity = 1;
    let efficiency = 1;
    let safety = 1;
    if (!hint.selector_guard) completeness -= 0.2;
    if (!hint.context) completeness -= 0.1;
    if (!hint.dom_fingerprint) completeness -= 0.1;
    if (hint.recipe.length < 2) completeness -= 0.2;
    if (hint.description.length < 10) clarity -= 0.3;
    if (hint.description.length > 150) clarity -= 0.1;
    if (!hint.description.match(/[.!?]$/)) clarity -= 0.1;
    if (hint.recipe.length > 10) efficiency -= 0.3;
    if (hint.recipe.length > 15) efficiency -= 0.3;
    const totalWait = hint.recipe.reduce((sum, step) => sum + (step.wait_after || 0), 0);
    if (totalWait > 1e4) efficiency -= 0.2;
    if (this.detectPII(hint.description)) safety = 0;
    if (hint.recipe.some((step) => this.detectPII(JSON.stringify(step.args)))) safety -= 0.5;
    if (!hint.selector_guard) safety -= 0.2;
    const score = (completeness + clarity + efficiency + safety) / 4;
    return {
      score: Math.max(0, Math.min(1, score)),
      factors: {
        completeness: Math.max(0, completeness),
        clarity: Math.max(0, clarity),
        efficiency: Math.max(0, efficiency),
        safety: Math.max(0, safety)
      }
    };
  }
  detectDuplicates(hint, existing) {
    for (const other of existing) {
      if (hint.domain === other.domain && hint.selector_guard === other.selector_guard && hint.pattern_type === other.pattern_type) {
        return true;
      }
      if (JSON.stringify(hint.recipe) === JSON.stringify(other.recipe)) {
        return true;
      }
    }
    return false;
  }
};

// src/hints/core/hint-matcher.ts
import { createHash } from "crypto";
var HintMatcher = class {
  /**
   * Match URL against a pattern with wildcards
   * Supports:
   * - Exact match: /login
   * - Wildcard suffix: /admin/* (matches any path under admin)
   * - Path parameters: /user/[id]/profile (where [id] can be any segment)
   */
  matchUrl(url, pattern) {
    if (url === pattern) return true;
    let urlPath;
    let patternPath;
    try {
      urlPath = new URL(url).pathname;
      if (pattern.startsWith("http")) {
        patternPath = new URL(pattern).pathname;
      } else {
        patternPath = pattern;
      }
    } catch {
      return url === pattern;
    }
    const regexPattern = patternPath.split("/").map((segment) => {
      if (segment === "*") return "[^/]+";
      if (segment === "**") return ".*";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(urlPath);
  }
  /**
   * Validate that a CSS selector exists in the DOM
   * For MVP, we just validate selector syntax
   */
  validateSelector(dom, selector) {
    if (!selector || selector.trim().length === 0) return false;
    if (typeof dom === "object" && dom.querySelector) {
      try {
        return dom.querySelector(selector) !== null;
      } catch {
        return false;
      }
    }
    return this.isValidCSSSelector(selector);
  }
  /**
   * Extract a fingerprint from DOM structure
   * Creates a hash of important structural elements
   */
  extractDomFingerprint(dom) {
    const features = [];
    if (typeof dom === "string") {
      const formCount = (dom.match(/<form/gi) || []).length;
      const inputCount = (dom.match(/<input/gi) || []).length;
      const buttonCount = (dom.match(/<button/gi) || []).length;
      features.push(`forms:${formCount}`);
      features.push(`inputs:${inputCount}`);
      features.push(`buttons:${buttonCount}`);
      if (dom.includes("password") || dom.includes("Password")) {
        features.push("has:password");
      }
      if (dom.includes("email") || dom.includes("Email")) {
        features.push("has:email");
      }
      if (dom.includes("login") || dom.includes("Login")) {
        features.push("has:login");
      }
    } else if (dom && dom.querySelectorAll) {
      features.push(`forms:${dom.querySelectorAll("form").length}`);
      features.push(`inputs:${dom.querySelectorAll("input").length}`);
      features.push(`buttons:${dom.querySelectorAll("button").length}`);
      if (dom.querySelector('input[type="password"]')) {
        features.push("has:password");
      }
      if (dom.querySelector('input[type="email"]')) {
        features.push("has:email");
      }
    }
    const fingerprint = features.sort().join("|");
    return createHash("sha1").update(fingerprint).digest("hex").substring(0, 16);
  }
  /**
   * Compare two DOM fingerprints and return similarity score (0-1)
   */
  compareDomFingerprints(fp1, fp2) {
    if (fp1 === fp2) return 1;
    const len = Math.min(fp1.length, fp2.length);
    let matches = 0;
    for (let i = 0; i < len; i++) {
      if (fp1[i] === fp2[i]) matches++;
    }
    return matches / len;
  }
  /**
   * Check if current viewport matches required viewport
   */
  matchViewport(current, required) {
    return current.width >= required.width && current.height >= required.height;
  }
  /**
   * Check if current auth state matches required auth state
   */
  matchAuthState(current, required) {
    if (required.isAuthenticated && !current.isAuthenticated) {
      return false;
    }
    if (required.userRole && current.userRole !== required.userRole) {
      return false;
    }
    return true;
  }
  /**
   * Basic CSS selector validation
   */
  isValidCSSSelector(selector) {
    const invalid = [
      /^[0-9]/,
      // Starts with number
      /\s$/,
      // Ends with space
      /^[>~+]/,
      // Starts with combinator
      /:$/,
      // Ends with colon
      /\[.*\]$/
      // Ends with attribute selector without element
    ];
    for (const pattern of invalid) {
      if (pattern.test(selector)) return false;
    }
    let brackets = 0;
    let singleQuotes = 0;
    let doubleQuotes = 0;
    for (const char of selector) {
      if (char === "[") brackets++;
      if (char === "]") brackets--;
      if (char === "'") singleQuotes++;
      if (char === '"') doubleQuotes++;
      if (brackets < 0) return false;
    }
    return brackets === 0 && singleQuotes % 2 === 0 && doubleQuotes % 2 === 0;
  }
};

// src/hints/core/hint-store.ts
var HintStore = class {
  db;
  validator;
  matcher;
  constructor() {
    this.db = HintDatabase.getInstance();
    this.validator = new HintValidator();
    this.matcher = new HintMatcher();
  }
  async saveHint(hint) {
    const validation = this.validator.validateHint(hint);
    if (!validation.valid) {
      throw new Error(`Invalid hint: ${validation.errors.join(", ")}`);
    }
    const id = this.generateHintId(hint);
    const existing = await this.getHintById(id);
    if (existing) {
      if ((hint.confidence || 0.5) > existing.confidence) {
        await this.deactivateHint(existing.id);
      } else {
        throw new Error("Existing hint has higher confidence");
      }
    }
    const fullHint = {
      id,
      domain: hint.domain,
      path_pattern: hint.path_pattern,
      url_hash: this.hashUrl(hint.domain + (hint.path_pattern || "")),
      pattern_type: hint.pattern_type,
      selector_guard: hint.selector_guard,
      dom_fingerprint: hint.dom_fingerprint,
      recipe: hint.recipe,
      description: hint.description,
      context: hint.context,
      success_count: 0,
      failure_count: 0,
      confidence: hint.confidence || 0.5,
      author_id: process.env.CLAUDE_INSTANCE_ID || "unknown",
      created_at: Date.now(),
      version: 1,
      is_active: true,
      parent_hint_id: hint.parent_hint_id,
      related_hints: hint.related_hints
    };
    this.db.insertHint(fullHint);
    return id;
  }
  async getHints(url, limit = 5) {
    const urlHash = this.hashUrl(url);
    const domain = new URL(url).hostname;
    const urlHints = this.db.getHintsByUrl(urlHash, limit);
    const domainHints = this.db.getHintsByDomain(domain, Math.floor(limit / 2));
    const allHints = [...urlHints];
    const seenIds = new Set(urlHints.map((h) => h.id));
    for (const hint of domainHints) {
      if (!seenIds.has(hint.id)) {
        allHints.push(hint);
        seenIds.add(hint.id);
      }
    }
    allHints.sort((a, b) => {
      const scoreA = this.calculateScore(a);
      const scoreB = this.calculateScore(b);
      return scoreB - scoreA;
    });
    return allHints.slice(0, limit);
  }
  async getHintById(id) {
    return this.db.getHintById(id);
  }
  async updateHintStats(id, success) {
    this.db.updateHintStats(id, success);
    this.db.recordHistory(id, success);
    const hint = await this.getHintById(id);
    if (hint && hint.failure_count > 10 && hint.confidence < 0.2) {
      await this.deactivateHint(id);
    }
  }
  async findMatchingHints(url, dom) {
    const hints = await this.getHints(url);
    if (!dom) {
      return hints;
    }
    const validHints = [];
    for (const hint of hints) {
      if (hint.selector_guard) {
        validHints.push(hint);
      } else {
        validHints.push(hint);
      }
    }
    return validHints;
  }
  async resolveConflict(existing, challenger) {
    const existingScore = this.calculateScore(existing);
    const challengerScore = this.calculateScore({
      ...challenger,
      confidence: challenger.confidence || 0.5,
      success_count: challenger.success_count || 0,
      failure_count: challenger.failure_count || 0,
      last_success_at: challenger.last_success_at
    });
    if (challengerScore > existingScore * 1.5) {
      await this.deactivateHint(existing.id);
      const newId = await this.saveHint({
        ...challenger,
        parent_hint_id: existing.id
      });
      return await this.getHintById(newId);
    }
    return existing;
  }
  async deactivateHint(id) {
    this.db.deactivateHint(id);
  }
  async pruneStaleHints(daysOld = 90) {
    return this.db.pruneStaleHints(daysOld);
  }
  generateHintId(hint) {
    const content = `${hint.domain}${hint.path_pattern || ""}${hint.selector_guard || ""}${Date.now()}`;
    return createHash2("sha1").update(content).digest("hex");
  }
  hashUrl(url) {
    return createHash2("sha1").update(url).digest("hex");
  }
  calculateScore(hint) {
    const recency = hint.last_success_at ? (Date.now() - hint.last_success_at) / (1e3 * 60 * 60 * 24) : 30;
    const recencyFactor = Math.exp(-recency / 30);
    const usageBonus = Math.log(hint.success_count + 1);
    return hint.confidence * recencyFactor * usageBonus;
  }
};

// src/hints/tools/save-hint.ts
var browser_save_hint = {
  schema: {
    name: "browser_save_hint",
    description: "Save a successful browser automation pattern as a reusable hint for future Claudes",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL where pattern was discovered (will extract domain and path)"
        },
        pattern_type: {
          type: "string",
          enum: ["login", "form_fill", "navigation", "interaction", "wait", "modal", "dynamic", "search", "upload", "pagination"],
          description: "Type of automation pattern"
        },
        selector_guard: {
          type: "string",
          description: 'CSS selector that must exist for hint to apply (e.g., "input[name=email]")'
        },
        recipe: {
          type: "array",
          description: "Sequence of tool calls that worked",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Tool name (e.g., browser_type, browser_click)" },
              args: { type: "object", description: "Arguments for the tool" },
              wait_after: { type: "number", description: "Optional ms to wait after this step" },
              retry_on_failure: { type: "boolean", description: "Whether to retry if step fails" }
            },
            required: ["tool", "args"]
          }
        },
        description: {
          type: "string",
          description: "One-line explanation of what this hint does (max 200 chars)"
        },
        context: {
          type: "object",
          description: "Optional context requirements",
          properties: {
            viewport_min: {
              type: "object",
              properties: {
                width: { type: "number" },
                height: { type: "number" }
              }
            },
            requires_auth: { type: "boolean" },
            locale: { type: "string" },
            user_agent_pattern: { type: "string" }
          }
        },
        confidence_override: {
          type: "number",
          description: "Optional initial confidence (0-1), defaults to 0.8 for new hints"
        }
      },
      required: ["url", "pattern_type", "recipe", "description"]
    }
  },
  handle: async (context, params) => {
    try {
      const store = new HintStore();
      const urlObj = new URL(params.url);
      const domain = urlObj.hostname;
      const path2 = urlObj.pathname;
      let pathPattern;
      if (path2 !== "/" && path2 !== "") {
        if (params.pattern_type === "login") {
          pathPattern = path2;
        } else {
          pathPattern = path2.endsWith("/") ? `${path2}*` : `${path2}/*`;
        }
      }
      const existing = await store.getHints(params.url, 10);
      const similarHints = existing.filter(
        (h) => h.pattern_type === params.pattern_type && h.selector_guard === params.selector_guard
      );
      if (similarHints.length > 0) {
        const best = similarHints[0];
        if (params.confidence_override && params.confidence_override > best.confidence) {
          await store.deactivateHint(best.id);
        } else {
          return {
            status: "conflict",
            message: `Similar hint already exists with ${Math.round(best.confidence * 100)}% confidence`,
            existing_hint: {
              id: best.id,
              description: best.description,
              confidence: best.confidence
            }
          };
        }
      }
      const hintId = await store.saveHint({
        domain,
        path_pattern: pathPattern,
        pattern_type: params.pattern_type,
        selector_guard: params.selector_guard,
        recipe: params.recipe,
        description: params.description.substring(0, 200),
        context: params.context,
        confidence: params.confidence_override || 0.8,
        dom_fingerprint: context.lastDomFingerprint
        // If available from navigation
      });
      return {
        status: "success",
        hint_id: hintId,
        message: `Hint saved successfully for ${domain}${pathPattern || ""}`,
        details: {
          domain,
          path_pattern: pathPattern,
          pattern_type: params.pattern_type,
          recipe_steps: params.recipe.length
        }
      };
    } catch (error) {
      throw new BrowserMCPError(
        `Failed to save hint: ${error instanceof Error ? error.message : "Unknown error"}`,
        "HINT_SAVE_ERROR",
        false
      );
    }
  }
};

// src/hints/tools/get-hints.ts
var browser_get_hints = {
  schema: {
    name: "browser_get_hints",
    description: "Retrieve hints for a specific URL or domain to automate browser interactions",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to get hints for"
        },
        include_domain_hints: {
          type: "boolean",
          description: "Include domain-wide hints in addition to page-specific ones",
          default: true
        },
        min_confidence: {
          type: "number",
          description: "Minimum confidence threshold (0-1), default 0.3"
        },
        pattern_type: {
          type: "string",
          enum: ["login", "form_fill", "navigation", "interaction", "wait", "modal", "dynamic", "search", "upload", "pagination"],
          description: "Filter by specific pattern type"
        },
        limit: {
          type: "number",
          description: "Maximum hints to return (default 5)"
        }
      },
      required: ["url"]
    }
  },
  handle: async (context, params) => {
    try {
      const store = new HintStore();
      const hints = await store.getHints(params.url, params.limit || 5);
      let filtered = hints.filter(
        (h) => h.confidence >= (params.min_confidence || 0.3)
      );
      if (params.pattern_type) {
        filtered = filtered.filter((h) => h.pattern_type === params.pattern_type);
      }
      if (params.include_domain_hints !== false) {
        const urlObj = new URL(params.url);
        const domain = urlObj.hostname;
        const pageSpecificCount = filtered.filter((h) => h.path_pattern).length;
        if (pageSpecificCount < (params.limit || 5)) {
          const domainHints = await store.getHints(`https://${domain}`, 3);
          const existingIds = new Set(filtered.map((h) => h.id));
          for (const hint of domainHints) {
            if (!existingIds.has(hint.id) && hint.confidence >= (params.min_confidence || 0.3)) {
              filtered.push(hint);
            }
          }
        }
      }
      filtered.sort((a, b) => {
        const scoreA = a.confidence * (a.last_success_at ? 1.2 : 1);
        const scoreB = b.confidence * (b.last_success_at ? 1.2 : 1);
        return scoreB - scoreA;
      });
      const results = filtered.slice(0, params.limit || 5);
      const formattedHints = results.map(formatHintForClaude);
      return {
        status: "success",
        hints: formattedHints,
        total_found: filtered.length,
        applied_filters: {
          min_confidence: params.min_confidence || 0.3,
          pattern_type: params.pattern_type,
          include_domain: params.include_domain_hints !== false
        }
      };
    } catch (error) {
      throw new BrowserMCPError(
        `Failed to retrieve hints: ${error instanceof Error ? error.message : "Unknown error"}`,
        "HINT_RETRIEVE_ERROR",
        false
      );
    }
  }
};
function formatHintForClaude(hint) {
  return {
    id: hint.id,
    pattern_type: hint.pattern_type,
    description: hint.description,
    confidence: Math.round(hint.confidence * 100) + "%",
    // Scope
    scope: {
      domain: hint.domain,
      path: hint.path_pattern || "any",
      requires_element: hint.selector_guard
    },
    // Recipe with clear steps
    recipe: hint.recipe.map((step, index) => ({
      step: index + 1,
      tool: step.tool,
      args: step.args,
      ...step.wait_after && { wait_after_ms: step.wait_after },
      ...step.retry_on_failure && { retry_on_failure: true }
    })),
    // Context if any
    ...hint.context && { context: hint.context },
    // Usage stats
    stats: {
      success_count: hint.success_count,
      failure_count: hint.failure_count,
      last_used: hint.last_used_at ? new Date(hint.last_used_at).toISOString() : "never",
      last_success: hint.last_success_at ? new Date(hint.last_success_at).toISOString() : "never"
    }
  };
}

// package.json
var package_default = {
  name: "@browsermcp/mcp-enhanced",
  version: "0.7.2",
  description: "Enhanced MCP server for browser automation with improved element selection, tab management, debugging capabilities, and token optimization",
  author: "BrowserMCP Enhanced Contributors",
  homepage: "https://github.com/browsermcp/mcp-enhanced",
  bugs: "https://github.com/browsermcp/mcp-enhanced/issues",
  repository: {
    type: "git",
    url: "git+https://github.com/browsermcp/mcp-enhanced.git"
  },
  keywords: [
    "mcp",
    "browser",
    "automation",
    "ai",
    "claude",
    "playwright",
    "chrome",
    "extension",
    "tab-management",
    "element-selection"
  ],
  type: "module",
  bin: {
    "mcp-server-browsermcp-enhanced": "dist/index.js"
  },
  files: [
    "dist"
  ],
  scripts: {
    typecheck: "tsc --noEmit",
    build: "tsup src/index.ts --format esm && shx chmod +x dist/*.js",
    prepare: "npm run build",
    watch: "tsup src/index.ts --format esm --watch ",
    inspector: "CLIENT_PORT=9001 SERVER_PORT=9002 pnpx @modelcontextprotocol/inspector node dist/index.js",
    test: "node test-runner.js",
    "test:quick": "node test-runner.js --quick",
    "test:server": "python3 test-server.py",
    "test:coverage": "node test-runner.js --coverage",
    dev: "npm run watch",
    start: "node dist/index.js"
  },
  dependencies: {
    "@modelcontextprotocol/sdk": "^1.8.0",
    "@types/better-sqlite3": "^7.6.13",
    "better-sqlite3": "^12.2.0",
    commander: "^13.1.0",
    ws: "^8.18.3",
    zod: "^3.24.2",
    "zod-to-json-schema": "^3.24.3"
  },
  devDependencies: {
    "@types/ws": "^8.18.0",
    shx: "^0.3.4",
    tsup: "^8.4.0",
    typescript: "^5.6.2"
  }
};

// src/index.ts
function setupExitWatchdog(server) {
  process.stdin.on("close", async () => {
    setTimeout(() => process.exit(0), 15e3);
    await server.close();
    process.exit(0);
  });
}
var commonTools = [pressKey, wait2];
var customTools = [getConsoleLogs, screenshot];
var tabTools = [
  browser_tab_list,
  browser_tab_select,
  browser_tab_new,
  browser_tab_close
];
var scaffoldTools = [
  expandRegion,
  queryElements
];
var codeExecutionTools = [
  executeJS,
  commonOperations
];
var hintTools = [
  browser_save_hint,
  browser_get_hints
];
var helperTools = [
  findElement,
  verifyProduct
];
var snapshotTools = [
  browser_multitool_v3,
  // New recipe generator multitool
  browser_execute_plan,
  // Plan executor
  navigate(true),
  goBack(true),
  goForward(true),
  snapshot,
  click,
  hover,
  type,
  selectOption,
  ...commonTools,
  ...customTools,
  ...tabTools,
  ...debuggerTools,
  ...scaffoldTools,
  ...codeExecutionTools,
  ...fileUploadTools,
  ...hintTools,
  ...helperTools
];
var resources = [];
async function createServer() {
  return createServerWithTools({
    name: "browsermcp-enhanced",
    version: package_default.version,
    tools: snapshotTools,
    resources
  });
}
program.version("Version " + package_default.version).name(package_default.name).action(async () => {
  const server = await createServer();
  setupExitWatchdog(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
});
program.parse(process.argv);
