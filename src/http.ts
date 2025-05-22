import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express, { Request, Response } from "express";
import { mcpNotificationPayload } from "./lib/mcpMessages";
import { serverFactory } from "@modelcontextprotocol/sdk"; // ✅ key change here
import { statefulMcpServerFactory } from "./stateful-mcp-server";
import "./tracer";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

const app = express();
app.use(cors());
app.use(express.json());

const transports: Record<string, SSEServerTransport> = {};
const httpTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
const userMcpSessions: Record<string, Record<string, string>[]> = {};

app.get("/", (req, res) => {
  console.log("Hello World");
  res.send("Hello World");
});

app.all("/v1/:uuid/:app", async (req: Request, res: Response) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: "Method not allowed",
      },
      id: null,
    });
  }

  console.log("Received MCP request:", req.body);

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    console.log(`Starting serverFactory for app: ${req.params.app}, uuid: ${req.params.uuid}`);
    const server = await serverFactory({
      app: req.params.app,
      uuid: req.params.uuid,
    });

    console.log("Server factory successful, connecting transport");
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.post("/v1/:uuid", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  try {
    if (sessionId && httpTransports[sessionId]) {
      const chatId = req.headers["x-pd-mcp-chat-id"];
      transport = httpTransports[sessionId];
      console.log(`Session resumed with ID: ${sessionId} for uuid: ${req.params.uuid} chatId: ${chatId}`);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          httpTransports[sessionId] = transport;
          const chatId = req.headers["x-pd-mcp-chat-id"];
          const currentSessions = userMcpSessions[req.params.uuid] ?? {};
          currentSessions[chatId] = sessionId;
          userMcpSessions[req.params.uuid] = currentSessions;
          console.log(`Session initialized with ID: ${sessionId} for uuid: ${req.params.uuid} chatId: ${chatId}`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`Transport closed for session ${sid}, removing from transports map`);
          delete transports[sid];
        }
      };

      console.log(`Starting dynamicServerFactory for uuid: ${req.params.uuid}`);
      const server = await statefulMcpServerFactory({
        uuid: req.params.uuid,
      });
      console.log("Server factory successful, connecting transport");
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    console.log("Connected to MCP server");
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/v1/:uuid", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const lastEventId = req.headers["last-event-id"] as string | undefined;
  if (lastEventId) {
    console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
  } else {
    console.log(`Establishing new SSE stream for session ${sessionId}`);
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

app.delete("/v1/:uuid", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  console.log(`Received session termination request for session ${sessionId}`);

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("Error handling session termination:", error);
    if (!res.headersSent) {
      res.status(500).send("Error processing session termination");
    }
  }
});

app.get("/:uuid", async (req: Request, res: Response) => {
  const messagePath = `/${req.params.uuid}/messages`;
  const transport = new SSEServerTransport(messagePath, res);
  transports[transport.sessionId] = transport;

  try {
    console.log(`Starting dynamicServerFactory for uuid: ${req.params.uuid}`);
    const server = await statefulMcpServerFactory({ uuid: req.params.uuid });
    console.log("Server factory successful, connecting transport");
    await server.connect(transport);

    res.write(`${mcpNotificationPayload({ method: "connection_established" })}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(`${mcpNotificationPayload({ method: "keepalive" })}\n\n`);
      } catch {
        clearInterval(keepAlive);
      }
    }, 20000);

    req.on("close", () => {
      console.log("SSE connection closed");
      delete transports[transport.sessionId];
      clearInterval(keepAlive);
    });
  } catch (error) {
    res.status(500).end(`Failed to establish SSE connection: ${error.message}`);
  }
});

app.listen(3010, () => {
  console.log("Server is running on port 3010");
  console.log("Routes configured:");
  console.log("- GET / - Health check");
  console.log("- GET /:uuid - Dynamic SSE connection endpoint");
  console.log("- POST /:uuid/messages - Dynamic message handler");
  console.log("- GET /:uuid/:app - App-specific SSE connection endpoint");
  console.log("- POST /:uuid/:app/messages - App-specific message handler");
});
