import type http from "node:http";
import type { Connector, Employee, CuttlefishConfig } from "../../shared/types.js";
import { loadConfig } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import type { RouteOptions } from "../../sessions/manager.js";
import type { SessionManager } from "../../sessions/manager.js";
import { SlackConnector } from "../../connectors/slack/index.js";
import { WhatsAppConnector } from "../../connectors/whatsapp/index.js";
import { TwilioConnector } from "../../connectors/twilio/index.js";

interface ConnectorLifecycle {
  connectors: Connector[];
  connectorMap: Map<string, Connector>;
  instanceConnectorIds: Set<string>;
  reloadConfiguredConnectors: (config: CuttlefishConfig) => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
  reloadConnectorInstances: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
  handleTwilioWebhook: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
}

interface ConnectorSetupDeps {
  config: CuttlefishConfig;
  sessionManager: SessionManager;
  getEmployeeRegistry: () => Map<string, Employee>;
}

function routeConnectorMessage(
  sessionManager: SessionManager,
  getEmployeeRegistry: () => Map<string, Employee>,
  employeeName: string | undefined,
  connector: Connector,
  label: string,
): void {
  connector.onMessage((msg) => {
    const routeOpts: RouteOptions = {};
    if (employeeName) {
      const emp = getEmployeeRegistry().get(employeeName);
      if (emp) routeOpts.employee = emp;
    }
    sessionManager.route(msg, connector, routeOpts).catch((err) => {
      logger.error(`${label} route error: ${err instanceof Error ? err.message : err}`);
    });
  });
}

function buildInstanceConnector(
  instance: Record<string, unknown> & { id: string; type: string; employee?: string },
  sessionManager: SessionManager,
  getEmployeeRegistry: () => Map<string, Employee>,
): Connector | null {
  const { id, type, employee, ...typeConfig } = instance;
  switch (type) {
    case "slack": {
      const connector = new SlackConnector({ ...typeConfig, id } as never);
      routeConnectorMessage(sessionManager, getEmployeeRegistry, employee, connector, id);
      return connector;
    }
    case "whatsapp": {
      const connector = new WhatsAppConnector({ ...typeConfig } as never);
      routeConnectorMessage(sessionManager, getEmployeeRegistry, employee, connector, id);
      return connector;
    }
    default:
      logger.warn(`Unknown connector type "${type}" for instance "${id}"`);
      return null;
  }
}

export function startConfiguredConnectors({
  config,
  sessionManager,
  getEmployeeRegistry,
}: ConnectorSetupDeps): ConnectorLifecycle {
  const connectors: Connector[] = [];
  const connectorMap = new Map<string, Connector>();
  const instanceConnectorIds = new Set<string>();
  let reloadGeneration = 0;

  const registerAndStart = (id: string, connector: Connector, startMsg?: string): void => {
    connectors.push(connector);
    connectorMap.set(id, connector);
    connector.start().catch((err) => {
      logger.error(`Failed to start ${id} connector: ${err instanceof Error ? err.message : err}`);
    });
    if (startMsg) logger.info(startMsg);
  };

  const addConfiguredConnectors = (
    nextConfig: CuttlefishConfig,
    started?: string[],
    errors?: string[],
  ): void => {
    if (nextConfig.connectors?.slack?.appToken && nextConfig.connectors?.slack?.botToken) {
      try {
        const slackConfig = nextConfig.connectors.slack;
        const connector = new SlackConnector({
          appToken: slackConfig.appToken,
          botToken: slackConfig.botToken,
          allowFrom: slackConfig.allowFrom,
          ignoreOldMessagesOnBoot: slackConfig.ignoreOldMessagesOnBoot,
        });
        routeConnectorMessage(sessionManager, getEmployeeRegistry, slackConfig.employee, connector, "Slack");
        registerAndStart("slack", connector);
        started?.push("slack");
      } catch (err) {
        const message = `Failed to configure Slack connector: ${err instanceof Error ? err.message : err}`;
        errors?.push(message);
        logger.error(message);
      }
    }

    if (nextConfig.connectors?.whatsapp) {
      try {
        const connector = new WhatsAppConnector(nextConfig.connectors.whatsapp ?? {});
        routeConnectorMessage(sessionManager, getEmployeeRegistry, nextConfig.connectors.whatsapp.employee, connector, "WhatsApp");
        registerAndStart("whatsapp", connector, "WhatsApp connector starting (scan QR code if first run)");
        started?.push("whatsapp");
      } catch (err) {
        const message = `Failed to configure WhatsApp connector: ${err instanceof Error ? err.message : err}`;
        errors?.push(message);
        logger.error(message);
      }
    }

    if (nextConfig.connectors?.twilio) {
      try {
        const connector = new TwilioConnector(nextConfig.connectors.twilio);
        routeConnectorMessage(sessionManager, getEmployeeRegistry, nextConfig.connectors.twilio.employee, connector, "Twilio SMS");
        registerAndStart("twilio", connector);
        started?.push("twilio");
      } catch (err) {
        const message = `Failed to configure Twilio SMS connector: ${err instanceof Error ? err.message : err}`;
        errors?.push(message);
        logger.error(message);
      }
    }

    if (nextConfig.connectors?.instances) {
      for (const instance of nextConfig.connectors.instances) {
        const { id, type, employee } = instance;
        if (!id || !type) {
          logger.warn("Skipping connector instance without id or type");
          continue;
        }
        if (connectorMap.has(id)) {
          logger.warn(`Duplicate connector instance id "${id}", skipping`);
          continue;
        }
        try {
          const connector = buildInstanceConnector(instance, sessionManager, getEmployeeRegistry);
          if (!connector) continue;
          connectors.push(connector);
          connectorMap.set(id, connector);
          instanceConnectorIds.add(id);
          void connector.start().catch((err) => {
            logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
          });
          started?.push(id);
          logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
        } catch (err) {
          const message = `Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`;
          errors?.push(message);
          logger.error(message);
        }
      }
    }
  };

  addConfiguredConnectors(config);

  const reloadConfiguredConnectors = async (
    nextConfig: CuttlefishConfig,
  ): Promise<{ started: string[]; stopped: string[]; errors: string[] }> => {
    const generation = ++reloadGeneration;
    const started: string[] = [];
    const stopped: string[] = [];
    const errors: string[] = [];
    const previous = [...connectorMap.entries()];

    // Remove every active connector from routing before awaiting shutdown. This
    // makes credential/allowlist revocations effective immediately, including
    // top-level Slack, WhatsApp, and Twilio connectors.
    for (const [id, connector] of previous) {
      connectorMap.delete(id);
      instanceConnectorIds.delete(id);
      const idx = connectors.indexOf(connector);
      if (idx >= 0) connectors.splice(idx, 1);
    }

    for (const [id, connector] of previous) {
      try {
        await connector.stop();
        stopped.push(id);
        logger.info(`Stopped connector "${id}" for reload`);
      } catch (err) {
        errors.push(`Failed to stop ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // A newer config reload may have already rebuilt the map while an earlier
    // connector was stopping. Never re-introduce the older configuration.
    if (generation !== reloadGeneration) return { started, stopped, errors };
    addConfiguredConnectors(nextConfig, started, errors);
    return { started, stopped, errors };
  };

  const reloadConnectorInstances = (): Promise<{ started: string[]; stopped: string[]; errors: string[] }> =>
    reloadConfiguredConnectors(loadConfig());

  const handleTwilioWebhook = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const connector = connectorMap.get("twilio");
    if (!(connector instanceof TwilioConnector)) {
      res.writeHead(404, { "Content-Type": "text/xml; charset=utf-8" });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }
    await connector.handleInboundWebhook(req, res);
  };

  return {
    connectors,
    connectorMap,
    instanceConnectorIds,
    reloadConfiguredConnectors,
    reloadConnectorInstances,
    handleTwilioWebhook,
  };
}
