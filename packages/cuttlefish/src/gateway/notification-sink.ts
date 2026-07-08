import type { SessionNotificationSink } from "../sessions/notification-sink.js";
import { logger } from "../shared/logger.js";
import type { ApiContext } from "./api/context.js";
import { dispatchSessionNotification } from "./api/session-dispatch.js";

export function createGatewayNotificationSink(context: ApiContext): SessionNotificationSink {
  return {
    async sendSessionNotification(sessionId, message, displayMessage) {
      await dispatchSessionNotification(sessionId, message, displayMessage, context);
    },

    async sendConnectorNotification(message) {
      const config = context.getConfig();
      const connectorName = config.notifications?.connector || "slack";
      const channel = config.notifications?.channel;
      if (!channel) {
        logger.debug("[callbacks] No notifications.channel configured — skipping connector notification");
        return;
      }

      const connector = context.connectors.get(connectorName);
      if (!connector) {
        logger.warn(`[callbacks] Notification connector "${connectorName}" is not running`);
        return;
      }

      await connector.sendMessage({ channel }, message);
    },
  };
}
