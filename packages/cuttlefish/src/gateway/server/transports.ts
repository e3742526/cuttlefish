import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { isLoopbackHost } from "../auth.js";
import { logger } from "../../shared/logger.js";
import type { ApiContext } from "../api.js";
import { attachPtyWebSocket } from "../pty-ws.js";
import { startWsHeartbeat, trackHeartbeat } from "../ws-heartbeat.js";
import type { Engine } from "../../shared/types.js";
import type { PtyViewEngine } from "../../engines/pty-view-engine.js";
import { isAllowedCorsOrigin, serveStatic, setCorsHeaders } from "./http-static.js";
import { isBlockedCrossSiteWrite, isHostAllowed, isPtyUpgradeAllowed } from "./request-guards.js";
import { resolvePrincipalGate } from "./auth-gate.js";

interface GatewayTransportDeps {
  apiContext: ApiContext;
  authRequiredNow: () => boolean;
  gatewayAuthToken: string;
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
    // CF2-120: resolve the principal and enforce scoped-token constraints
    // unconditionally — not just when authRequiredNow() is true — so a
    // presented scoped session token is always honored as a constraint, even
    // on the default (loopback, auth-not-required) deployment. See
    // auth-gate.ts for the full rationale.
    const gate = resolvePrincipalGate({
      req,
      method: req.method,
      pathname,
      authRequiredNow,
      gatewayAuthToken,
      cuttlefishHome,
    });
    if (gate.status !== 200) {
      res.writeHead(gate.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: gate.reason || (gate.status === 401 ? "Unauthorized" : "Forbidden") }));
      return;
    }
    // Attach principal so route handlers can apply per-principal scoping.
    if (gate.principal) {
      (req as http.IncomingMessage & { cuttlefishPrincipal?: unknown }).cuttlefishPrincipal = gate.principal;
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

    // DNS-rebinding guard — the HTTP handler above applies this to every
    // request; `server.on("upgrade")` is a separate listener and previously
    // had no equivalent check at all for the generic /ws path (CF2-102).
    if (!isHostAllowed(boundLoopback, req.headers.host)) {
      socket.write("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const gate = resolvePrincipalGate({
      req,
      method: "GET",
      pathname,
      authRequiredNow,
      gatewayAuthToken,
      cuttlefishHome,
    });
    if (gate.status !== 200) {
      socket.write(`HTTP/1.1 ${gate.status} ${gate.status === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    if (reqUrl === "/ws") {
      // CF2-102 (Cross-Site WebSocket Hijacking): WebSocket handshakes bypass
      // CORS/SOP, so without an explicit Origin check any page open in the
      // operator's browser could open `new WebSocket("ws://127.0.0.1:.../ws")`
      // and receive the live event stream. `resolvePrincipalGate` above
      // already confines a *presented* scoped token; this adds the same
      // Origin allowlist `/ws/pty` already enforces via `isPtyUpgradeAllowed`.
      if (!isAllowedCorsOrigin(req.headers.origin, req.headers.host)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
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
