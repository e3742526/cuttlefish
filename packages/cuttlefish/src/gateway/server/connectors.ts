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
  config: CuttlefishConfig,
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

  const registerAndStart = (id: string, connector: Connector, startMsg?: string): void => {
    connectors.push(connector);
    connectorMap.set(id, connector);
    connector.start().catch((err) => {
      logger.error(`Failed to start ${id} connector: ${err instanceof Error ? err.message : err}`);
    });
    if (startMsg) logger.info(startMsg);
  };

  if (config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) {
    const slackConfig = config.connectors.slack;
    const connector = new SlackConnector({
      appToken: slackConfig.appToken,
      botToken: slackConfig.botToken,
      allowFrom: slackConfig.allowFrom,
      ignoreOldMessagesOnBoot: slackConfig.ignoreOldMessagesOnBoot,
    });
    routeConnectorMessage(sessionManager, getEmployeeRegistry, config.connectors.slack?.employee, connector, "Slack");
    registerAndStart("slack", connector);
  }

  if (config.connectors?.whatsapp) {
    const connector = new WhatsAppConnector(config.connectors.whatsapp ?? {});
    routeConnectorMessage(sessionManager, getEmployeeRegistry, config.connectors.whatsapp?.employee, connector, "WhatsApp");
    registerAndStart("whatsapp", connector, "WhatsApp connector starting (scan QR code if first run)");
  }

  if (config.connectors?.twilio) {
    const connector = new TwilioConnector(config.connectors.twilio);
    routeConnectorMessage(sessionManager, getEmployeeRegistry, config.connectors.twilio.employee, connector, "Twilio SMS");
    registerAndStart("twilio", connector);
  }

  if (config.connectors?.instances) {
    for (const instance of config.connectors.instances) {
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
        const connector = buildInstanceConnector(instance, config, sessionManager, getEmployeeRegistry);
        if (!connector) continue;
        connectors.push(connector);
        connectorMap.set(id, connector);
        instanceConnectorIds.add(id);
        void connector.start().catch((err) => {
          logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
        });
        logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
      } catch (err) {
        logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const reloadConnectorInstances = async (): Promise<{ started: string[]; stopped: string[]; errors: string[] }> => {
    const freshConfig = loadConfig();
    const started: string[] = [];
    const stopped: string[] = [];
    const errors: string[] = [];

    for (const [id, connector] of connectorMap.entries()) {
      if (!instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        connectorMap.delete(id);
        instanceConnectorIds.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped connector instance "${id}" for reload`);
      } catch (err) {
        errors.push(`Failed to stop ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (freshConfig.connectors?.instances) {
      for (const instance of freshConfig.connectors.instances) {
        const { id, type, employee } = instance;
        if (!id || !type || connectorMap.has(id)) continue;
        try {
          const connector = buildInstanceConnector(instance, config, sessionManager, getEmployeeRegistry);
          if (!connector) {
            errors.push(`Unknown connector type "${type}" for instance "${id}"`);
            continue;
          }
          void connector.start().catch((err) => {
            const msg = `Failed to start "${id}": ${err instanceof Error ? err.message : err}`;
            errors.push(msg);
            logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
          });
          connectors.push(connector);
          connectorMap.set(id, connector);
          instanceConnectorIds.add(id);
          started.push(id);
          logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
        } catch (err) {
          errors.push(`Failed to start "${id}": ${err instanceof Error ? err.message : err}`);
          logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    return { started, stopped, errors };
  };

  const handleTwilioWebhook = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const connector = connectorMap.get("twilio");
    if (!(connector instanceof TwilioConnector)) {
      res.writeHead(404, { "Content-Type": "text/xml; charset=utf-8" });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }
    await connector.handleInboundWebhook(req, res);
  };

  return { connectors, connectorMap, instanceConnectorIds, reloadConnectorInstances, handleTwilioWebhook };
}
