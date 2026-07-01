import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { authenticateGatewayRequest, authRequiredForRequest, isAuthenticatedRequest, isLoopbackHost, scopedTokenForbidden } from "../auth.js";
import { logger } from "../../shared/logger.js";
import type { ApiContext } from "../api.js";
import { attachPtyWebSocket } from "../pty-ws.js";
import { startWsHeartbeat, trackHeartbeat } from "../ws-heartbeat.js";
import type { Engine } from "../../shared/types.js";
import type { PtyViewEngine } from "../../engines/pty-view-engine.js";
import { serveStatic, setCorsHeaders } from "./http-static.js";
import { isBlockedCrossSiteWrite, isHostAllowed, isPtyUpgradeAllowed } from "./request-guards.js";

interface GatewayTransportDeps {
  apiContext: ApiContext;
  authRequiredNow: () => boolean;
  gatewayAuthToken: string;
  gatewayInfoToken: string;
  gatewayName: string;
  handleApiRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  host: string;
  cuttlefishHome: string;
  port: number;
  ptyViewEngines: Record<string, Engine & PtyViewEngine>;
  getSession: (id: string) => { engine: string } | undefined;
  webDir: string;
  wsClients: Set<WebSocket>;
}

export function createGatewayTransports({
  apiContext,
  authRequiredNow,
  gatewayAuthToken,
  gatewayInfoToken,
  gatewayName,
  handleApiRequest,
  host,
  cuttlefishHome,
  port,
  ptyViewEngines,
  getSession,
  webDir,
  wsClients,
}: GatewayTransportDeps) {
  const boundLoopback = isLoopbackHost(host);

  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";
    const corsAllowed = setCorsHeaders(req, res);

    if (url.startsWith("/api/") && !corsAllowed) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Origin not allowed" }));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // DNS-rebinding guard
    if (!isHostAllowed(boundLoopback, req.headers.host)) {
      res.writeHead(421, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Misdirected request" }));
      return;
    }

    // Defense-in-depth CSRF guard
    if (isBlockedCrossSiteWrite(req.method, req.headers["sec-fetch-site"] as string | undefined)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Cross-site write blocked" }));
      return;
    }

    const pathname = url.split("?")[0];
    if (authRequiredNow() && authRequiredForRequest(req.method, pathname)) {
      const auth = authenticateGatewayRequest(req, gatewayAuthToken, cuttlefishHome);
      if (!auth.ok) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: auth.reason || "Unauthorized" }));
        return;
      }
      if (auth.principal?.kind === "session" && scopedTokenForbidden(req.method, pathname)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden for session-scoped tokens" }));
        return;
      }
      // Attach principal so route handlers can apply per-principal scoping.
      if (auth.principal) {
        (req as http.IncomingMessage & { cuttlefishPrincipal?: unknown }).cuttlefishPrincipal = auth.principal;
      }
    }

    if (url.startsWith("/api/")) {
      handleApiRequest(req, res);
      return;
    }

    if (!serveStatic(req, res, webDir)) {
      if (url === "/" || url === "/index.html") {
        res.writeHead(503, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Web UI not built</h1><p>Run <code>pnpm build</code> from the project root to build the web UI.</p></body></html>");
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const ptyWss = new WebSocketServer({ noServer: true });
  const stopWsHeartbeat = startWsHeartbeat([wss, ptyWss], {
    onSweep: (result) => {
      if (result.terminated > 0) logger.info(`WS heartbeat reaped ${result.terminated} dead socket(s)`);
    },
  });

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    trackHeartbeat(ws);
    logger.info(`WebSocket client connected (${wsClients.size} total)`);

    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m?.event === "ping" && ws.readyState === 1) {
          ws.send(JSON.stringify({ event: "pong", payload: {} }));
        }
      } catch {
      }
    });

    ws.on("close", () => {
      wsClients.delete(ws);
      logger.info(`WebSocket client disconnected (${wsClients.size} total)`);
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket error: ${err.message}`);
      wsClients.delete(ws);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = req.url || "";
    const pathname = reqUrl.split("?")[0];
    if (authRequiredNow() && authRequiredForRequest("GET", pathname)) {
      const auth = authenticateGatewayRequest(req, gatewayAuthToken, cuttlefishHome);
      if (!auth.ok) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    if (reqUrl === "/ws") {
      if (authRequiredNow() && !isAuthenticatedRequest(req, gatewayInfoToken)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    const ptyMatch = reqUrl.split("?")[0].match(/^\/ws\/pty\/([^/]+)$/);
    if (ptyMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(ptyMatch[1]);
      } catch {
        socket.destroy();
        return;
      }
      const queryToken = new URLSearchParams(reqUrl.split("?")[1] ?? "").get("token") ?? "";
      if (!isPtyUpgradeAllowed({
        boundLoopback,
        reqHost: req.headers.host,
        origin: req.headers.origin,
        sessionId,
        token: queryToken,
        secret: gatewayAuthToken,
      })) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const ptySession = getSession(sessionId);
      const ptyEngine = ptySession ? ptyViewEngines[ptySession.engine] : undefined;
      if (!ptyEngine) {
        socket.destroy();
        return;
      }
      ptyWss.handleUpgrade(req, socket, head, (ws) => {
        trackHeartbeat(ws);
        try {
          attachPtyWebSocket(ws, sessionId, ptyEngine);
        } catch (err) {
          logger.warn(`PTY websocket attach failed for ${sessionId}: ${err instanceof Error ? err.message : err}`);
          ws.close();
        }
      });
      return;
    }
    socket.destroy();
  });

  const startListening = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const retryForMs = 15_000;
      const retryDelayMs = 250;
      const listen = () => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          if (err.code === "EADDRINUSE" && Date.now() - startedAt < retryForMs) {
            setTimeout(listen, retryDelayMs).unref?.();
            return;
          }
          if (err.code === "EADDRINUSE") {
            const msg = `Port ${port} is already in use.`;
            logger.error(msg);
            console.error(`\nError: ${msg}`);
            console.error(`\nTry: cuttlefish start -p ${port + 1}`);
            console.error("Or update the port in config.yaml\n");
            process.exit(1);
          }
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          logger.info(`${gatewayName} gateway listening on http://${host}:${port}`);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      };
      listen();
    });
  };

  return { ptyWss, server, startListening, stopWsHeartbeat, wsClients, wss };
}
