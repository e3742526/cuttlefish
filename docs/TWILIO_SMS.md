# Twilio SMS Setup

Cuttlefish's Twilio connector sends SMS through Twilio's official Node helper
library and accepts only signed inbound SMS webhooks. It does not store Twilio
credentials in `~/.cuttlefish/config.yaml`.

## 1. Add credentials locally

From a source checkout, create or update the ignored `.env` file:

```dotenv
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token
```

The connector also accepts the operator's existing `TWILIO_SID` and
`TWILIO_CLIENT_SECRET` names as compatibility aliases. They must respectively
contain the **Account SID** and **Auth Token** used by Twilio's Programmable
Messaging API; an OAuth client secret is not a substitute for an Auth Token.

When Cuttlefish starts from the checkout, it loads only `TWILIO_*` variables
from this `.env` file. These variables are excluded from all agent subprocesses.

## 2. Configure the connector

Add this non-secret block to `~/.cuttlefish/config.yaml`, replacing the example
numbers and URL:

```yaml
connectors:
  twilio:
    fromNumber: "+15551234567" # An SMS-capable Twilio number in E.164 form
    webhookUrl: "https://sms.example.com/webhooks/twilio/sms"
    allowFrom:
      - "+15557654321"         # Only these senders may start SMS sessions
    # employee: assistant       # Optional employee to own inbound SMS sessions
```

Use `messagingServiceSid: "MG..."` instead of `fromNumber` when sending through
a Twilio Messaging Service. `webhookUrl` must be the exact public HTTPS URL
configured in Twilio, including any path and query string.

## 3. Configure Twilio

1. Obtain an SMS-capable Twilio phone number (or Messaging Service).
2. Expose the local gateway through a public HTTPS URL for development, or deploy
   it behind TLS.
3. In the number's **A message comes in** setting, choose `POST` and set the URL
   to the same `webhookUrl` configured above.
4. Restart Cuttlefish from the source checkout (`pnpm cuttlefish start`).

Twilio sends form-encoded inbound SMS payloads to this URL. Cuttlefish verifies
the `X-Twilio-Signature` with Twilio's official helper before routing an SMS, and
returns empty TwiML immediately; the agent response is sent later through the
Messages API. Unsigned, oversized, duplicate, and non-allowlisted requests do
not reach an agent.

Use a real TLS certificate for public deployments. Twilio's official guides cover
[sending SMS](https://www.twilio.com/docs/messaging/quickstart),
[incoming-message webhooks](https://www.twilio.com/docs/usage/webhooks/messaging-webhooks),
and [webhook request validation](https://www.twilio.com/docs/usage/security).
