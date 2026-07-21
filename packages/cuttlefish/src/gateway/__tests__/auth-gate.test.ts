import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuthSession, createScopedSessionToken } from "../auth.js";
import { resolvePrincipalGate } from "../server/auth-gate.js";
import { operatorDelegationPromptHash } from "../../sessions/operator-delegation.js";

function req(headers: Record<string, string | undefined>, remoteAddress = "127.0.0.1") {
  return { headers, socket: { remoteAddress } } as any;
}

const TOKEN = "gateway-secret-token-1234567890";

describe("resolvePrincipalGate (CF2-120)", () => {
  it("lets an unauthenticated loopback request through with no principal when auth is not required (default UX unchanged)", () => {
    const gate = resolvePrincipalGate({
      req: req({}),
      method: "GET",
      pathname: "/api/sessions",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(200);
    expect(gate.principal).toBeUndefined();
  });

  it("401s when auth is required, the route requires it, and no credential is presented", () => {
    const gate = resolvePrincipalGate({
      req: req({}),
      method: "GET",
      pathname: "/api/sessions",
      authRequiredNow: () => true,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(401);
  });

  it("requires an authenticated identity to submit an org change even on loopback", () => {
    const gate = resolvePrincipalGate({
      req: req({}),
      method: "POST",
      pathname: "/api/org/change-requests",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(401);
  });

  it("requires identity for checkpoint creation and allows an authenticated scoped chat", () => {
    const anonymous = resolvePrincipalGate({
      req: req({}),
      method: "POST",
      pathname: "/api/checkpoints",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(anonymous.status).toBe(401);

    const scoped = createScopedSessionToken("session-abc", TOKEN);
    const authenticated = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "POST",
      pathname: "/api/checkpoints",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(authenticated).toMatchObject({ status: 200, principal: { kind: "session", sessionId: "session-abc" } });
  });

  it("allows a scoped chat token to submit an org change but not resolve it", () => {
    const scoped = createScopedSessionToken("session-abc", TOKEN);
    const proposal = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "POST",
      pathname: "/api/org/change-requests",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(proposal).toMatchObject({ status: 200, principal: { kind: "session", sessionId: "session-abc" } });

    const decision = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "POST",
      pathname: "/api/org/change-requests/change-1/approve",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(decision.status).toBe(403);
  });

  it("requires an operator credential to resolve approval actions even on loopback", () => {
    const gate = resolvePrincipalGate({
      req: req({}),
      method: "POST",
      pathname: "/api/approvals/approval-1/approve",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(401);
  });

  it("allows only a live, prompt-bound delegated COO/Program Manager token to resolve decisions", () => {
    const delegationId = operatorDelegationPromptHash("authorized turn");
    const scoped = createScopedSessionToken("program-manager-run", TOKEN, {
      delegatedScopes: ["approve"],
      operatorDelegationId: delegationId,
    });
    const allowed = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "POST",
      pathname: "/api/approvals/approval-1/approve",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
      isHumanDelegationSessionEligible: (sessionId, activeId) => sessionId === "program-manager-run" && activeId === delegationId,
    });
    expect(allowed).toMatchObject({
      status: 200,
      principal: { kind: "session", sessionId: "program-manager-run", delegatedScopes: ["approve"], operatorDelegationId: delegationId },
    });

    const replayed = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "POST",
      pathname: "/api/approvals/approval-1/approve",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
      isHumanDelegationSessionEligible: (_sessionId, activeId) => activeId !== delegationId,
    });
    expect(replayed.status).toBe(403);
  });

  it("does not let approve-only authority reject, reach direct org decisions, or omit prompt binding", () => {
    const delegationId = operatorDelegationPromptHash("approve only");
    const scoped = createScopedSessionToken("coo-run", TOKEN, {
      delegatedScopes: ["approve"],
      operatorDelegationId: delegationId,
    });
    const common = {
      req: req({ authorization: `Bearer ${scoped}` }),
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
      isHumanDelegationSessionEligible: () => true,
    };
    expect(resolvePrincipalGate({ ...common, method: "POST", pathname: "/api/approvals/a/reject" }).status).toBe(403);
    expect(resolvePrincipalGate({ ...common, method: "POST", pathname: "/api/org/change-requests/c/approve" }).status).toBe(403);
    expect(() => createScopedSessionToken("coo-run", TOKEN, { delegatedScopes: ["approve"] })).toThrow(/prompt hash/);
  });

  it("403s a scoped session token hitting a forbidden control-plane path even when auth is NOT required (loopback default) — this is the CF2-120 regression", () => {
    const scoped = createScopedSessionToken("session-abc", TOKEN);
    const gate = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "GET",
      pathname: "/api/config",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(403);
  });

  it("403s a scoped session token confined to a different session's resource, auth not required", () => {
    const scoped = createScopedSessionToken("session-abc", TOKEN);
    const gate = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "GET",
      pathname: "/api/sessions/session-xyz",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
      isDirectChildSession: () => false,
    });
    expect(gate.status).toBe(403);
  });

  it("allows a parent session to poll the detail/messages of its direct delegated child", () => {
    const scoped = createScopedSessionToken("manager-run", TOKEN);
    const gate = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "GET",
      pathname: "/api/sessions/child-run",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
      isDirectChildSession: (parentId, childId) => parentId === "manager-run" && childId === "child-run",
    });
    expect(gate).toMatchObject({ status: 200, principal: { kind: "session", sessionId: "manager-run" } });
  });

  it("keeps sibling, grandchild, raw-transcript, and mutation access confined", () => {
    const scoped = createScopedSessionToken("manager-run", TOKEN);
    const directChild = (parentId: string, childId: string) => parentId === "manager-run" && childId === "child-run";
    for (const [method, pathname] of [
      ["GET", "/api/sessions/sibling-run"],
      ["GET", "/api/sessions/grandchild-run"],
      ["GET", "/api/sessions/child-run/transcript"],
      ["GET", "/api/sessions/child-run/children"],
      ["POST", "/api/sessions/child-run/message"],
    ] as const) {
      const gate = resolvePrincipalGate({
        req: req({ authorization: `Bearer ${scoped}` }),
        method,
        pathname,
        authRequiredNow: () => false,
        gatewayAuthToken: TOKEN,
        cuttlefishHome: "/tmp/does-not-matter",
        isDirectChildSession: directChild,
      });
      expect(gate.status, `${method} ${pathname}`).toBe(403);
    }
  });

  it("allows a COO session to send a follow-up message to any session", () => {
    const scoped = createScopedSessionToken("coo-run", TOKEN);
    const gate = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "POST",
      pathname: "/api/sessions/worker-run/message",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
      isCooSession: (sessionId) => sessionId === "coo-run",
    });
    expect(gate).toMatchObject({ status: 200, principal: { kind: "session", sessionId: "coo-run" } });
  });

  it("does not let an ordinary manager message an unrelated session", () => {
    const scoped = createScopedSessionToken("manager-run", TOKEN);
    const gate = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "POST",
      pathname: "/api/sessions/unrelated-run/message",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
      isCooSession: () => false,
    });
    expect(gate.status).toBe(403);
  });

  it("keeps COO cross-session authority limited to the message endpoint", () => {
    const scoped = createScopedSessionToken("coo-run", TOKEN);
    for (const [method, pathname] of [
      ["GET", "/api/sessions/worker-run"],
      ["GET", "/api/sessions/worker-run/transcript"],
      ["POST", "/api/sessions/worker-run/stop"],
      ["POST", "/api/sessions/worker-run/reset"],
      ["DELETE", "/api/sessions/worker-run"],
    ] as const) {
      const gate = resolvePrincipalGate({
        req: req({ authorization: `Bearer ${scoped}` }),
        method,
        pathname,
        authRequiredNow: () => false,
        gatewayAuthToken: TOKEN,
        cuttlefishHome: "/tmp/does-not-matter",
        isDirectChildSession: () => false,
        isCooSession: () => true,
      });
      expect(gate.status, `${method} ${pathname}`).toBe(403);
    }
  });

  it("403s a scoped session token on global integration and message-search reads", () => {
    const scoped = createScopedSessionToken("session-abc", TOKEN);
    for (const pathname of ["/api/talk/search", "/api/email/inboxes", "/api/artifacts", "/api/knowledge/outbox", "/api/fs/list"]) {
      const gate = resolvePrincipalGate({
        req: req({ authorization: `Bearer ${scoped}` }),
        method: "GET",
        pathname,
        authRequiredNow: () => false,
        gatewayAuthToken: TOKEN,
        cuttlefishHome: "/tmp/does-not-matter",
      });
      expect(gate.status).toBe(403);
    }
  });

  it("attaches the resolved principal even when authRequiredNow() is false (CF2-112: connector-send-policy sees the real caller on loopback)", () => {
    const scoped = createScopedSessionToken("session-abc", TOKEN);
    const gate = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "GET",
      pathname: "/api/connectors/slack/send",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(200);
    expect(gate.principal).toEqual({ kind: "session", sessionId: "session-abc" });
  });

  it("allows a legitimately device-cookie-authenticated browser, resolving an admin principal (Ledger-0007 Finding 5 regression)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-auth-gate-device-"));
    const session = createAuthSession(home, req({ "user-agent": "Mozilla/5.0" }, "127.0.0.1"));
    const gate = resolvePrincipalGate({
      req: req({ cookie: `cuttlefish_auth=${session.secret}; cuttlefish_device=${session.device.id}` }, "127.0.0.1"),
      method: "GET",
      pathname: "/ws",
      authRequiredNow: () => true,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: home,
    });
    expect(gate.status).toBe(200);
    expect(gate.principal).toEqual({ kind: "admin" });

    const approval = resolvePrincipalGate({
      req: req({ cookie: `cuttlefish_auth=${session.secret}; cuttlefish_device=${session.device.id}` }, "127.0.0.1"),
      method: "POST",
      pathname: "/api/org/change-requests/change-1/approve",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: home,
    });
    expect(approval).toMatchObject({ status: 200, principal: { kind: "admin" } });
  });

  it("still 401s a /ws upgrade with no credential when auth is required", () => {
    const gate = resolvePrincipalGate({
      req: req({}),
      method: "GET",
      pathname: "/ws",
      authRequiredNow: () => true,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(401);
  });
});
