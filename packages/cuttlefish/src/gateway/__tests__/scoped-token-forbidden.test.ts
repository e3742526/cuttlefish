import { describe, expect, it } from "vitest";
import {
  principalBodySessionForbidden,
  scopedTokenCollectionForbidden,
  scopedTokenForbidden,
  scopedTokenSessionMismatch,
} from "../scoped-token.js";

describe("scopedTokenForbidden — operator control plane", () => {
  it("blocks the pre-existing operator surfaces", () => {
    expect(scopedTokenForbidden("PUT", "/api/config")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/logs")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/instances")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/auth/pair")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/org/employees")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/archives")).toBe(true);
    expect(scopedTokenForbidden("DELETE", "/api/archives/archive-1")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/talk/engine")).toBe(true);
    expect(scopedTokenForbidden("DELETE", "/api/skills/playtest")).toBe(true);
  });

  it("blocks human-oversight collections because handlers do not bind records to the token session", () => {
    expect(scopedTokenForbidden("POST", "/api/approvals/abc/approve")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/checkpoints/xyz/decision")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/checkpoints")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/approvals")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/checkpoints/xyz")).toBe(true);
  });

  it("blocks cron and orchestration collections, not only mutations", () => {
    expect(scopedTokenForbidden("POST", "/api/cron")).toBe(true);
    expect(scopedTokenForbidden("DELETE", "/api/cron/job-1")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/orchestration/queue/pause")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/orchestration/leases/stop")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/orchestration/run")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/cron")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/orchestration/status")).toBe(true);
  });

  it("still allows the endpoints an agent legitimately needs", () => {
    expect(scopedTokenForbidden("GET", "/api/org")).toBe(false);
    expect(scopedTokenForbidden("GET", "/api/status")).toBe(false);
    expect(scopedTokenForbidden("POST", "/api/sessions")).toBe(false);
    expect(scopedTokenForbidden("POST", "/api/sessions/s-1/message")).toBe(false);
    expect(scopedTokenForbidden("POST", "/api/files")).toBe(false);
    expect(scopedTokenForbidden("GET", "/api/skills")).toBe(false);
    expect(scopedTokenForbidden("GET", "/api/talk/engine")).toBe(false);
  });

  it("blocks path-traversal, redundant-slash, and case bypass attempts", () => {
    // The router resolves `..` before dispatch, so the deny list must too.
    expect(scopedTokenForbidden("POST", "/api/sessions/../approvals/abc/approve")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/sessions/../org/employees")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/foo/../../api/config")).toBe(true);
    // Redundant slashes collapse to the canonical path.
    expect(scopedTokenForbidden("POST", "/api/approvals//abc/approve")).toBe(true);
    // Case-folding closes a case-mismatch gap regardless of router casing.
    expect(scopedTokenForbidden("POST", "/api/Approvals/abc/approve")).toBe(true);
    expect(scopedTokenForbidden("PUT", "/api/Config")).toBe(true);
    // A traversal that resolves back to an allowed path stays allowed.
    expect(scopedTokenForbidden("POST", "/api/approvals/../sessions/s-1/message")).toBe(false);
  });

  it("blocks operator onboarding and bulk session delete for agent tokens (IAPI-CF-001, IAPI-CF-002)", () => {
    expect(scopedTokenForbidden("POST", "/api/onboarding")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/onboarding/step")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/sessions/bulk-delete")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/sessions/cancel-all")).toBe(true);
    // Onboarding bypass via traversal collapses and is still blocked.
    expect(scopedTokenForbidden("POST", "/api/sessions/../onboarding")).toBe(true);
  });

  it("blocks global message, integration, artifact, filesystem, and operator-work reads", () => {
    for (const pathname of [
      "/api/sessions/interrupted",
      "/api/talk/search",
      "/api/email/inboxes",
      "/api/email/messages/message-1",
      "/api/artifacts",
      "/api/artifacts/bundle",
      "/api/knowledge/outbox",
      "/api/fs/list",
      "/api/fs/recent",
      "/api/inspect/runs",
      "/api/activity",
      "/api/work",
      "/api/command-center",
      "/api/workspace-profiles",
      "/api/connectors",
      "/api/connectors/whatsapp/qr",
    ]) {
      expect(scopedTokenForbidden("GET", pathname)).toBe(true);
    }
  });
});

describe("scopedTokenCollectionForbidden — cross-session collections (AR-01)", () => {
  it("blocks the global session roster + search for agent tokens", () => {
    // The gate receives the URL pathname with the query already stripped upstream;
    // `?q=` search resolves to the same `/api/sessions` path.
    expect(scopedTokenCollectionForbidden("GET", "/api/sessions")).toBe(true);
  });

  it("blocks the managed-file registry: list, download, meta, delete", () => {
    expect(scopedTokenCollectionForbidden("GET", "/api/files")).toBe(true);
    expect(scopedTokenCollectionForbidden("GET", "/api/files/abc123")).toBe(true);
    expect(scopedTokenCollectionForbidden("GET", "/api/files/abc123/meta")).toBe(true);
    expect(scopedTokenCollectionForbidden("DELETE", "/api/files/abc123")).toBe(true);
  });

  it("still allows the file routes an agent legitimately needs", () => {
    expect(scopedTokenCollectionForbidden("POST", "/api/files")).toBe(false); // push attachment
    expect(scopedTokenCollectionForbidden("GET", "/api/files/read")).toBe(false); // root-file read
    expect(scopedTokenCollectionForbidden("POST", "/api/files/transfer")).toBe(false);
    // Spawning a child session and driving one's own session stay open.
    expect(scopedTokenCollectionForbidden("POST", "/api/sessions")).toBe(false);
    expect(scopedTokenCollectionForbidden("GET", "/api/sessions/s-1")).toBe(false);
    expect(scopedTokenCollectionForbidden("GET", "/api/sessions/s-1/transcript")).toBe(false);
  });

  it("collapses traversal/case so the collection block cannot be bypassed", () => {
    expect(scopedTokenCollectionForbidden("GET", "/api/files/../files")).toBe(true);
    expect(scopedTokenCollectionForbidden("GET", "/api/Files/abc123")).toBe(true);
    // A read-route lookalike stays allowed only for the literal /read + /transfer.
    expect(scopedTokenCollectionForbidden("GET", "/api/files/READ")).toBe(false);
  });
});

describe("principalBodySessionForbidden — body-scoped confinement (AR-04)", () => {
  it("blocks a session token targeting a different session id in the body", () => {
    expect(principalBodySessionForbidden({ kind: "session", sessionId: "s-1" }, "s-2")).toBe(true);
    expect(principalBodySessionForbidden({ kind: "session", sessionId: "s-1" }, "S-2")).toBe(true);
  });

  it("allows a session token acting on its own session (case-insensitive)", () => {
    expect(principalBodySessionForbidden({ kind: "session", sessionId: "s-1" }, "s-1")).toBe(false);
    expect(principalBodySessionForbidden({ kind: "session", sessionId: "S-1" }, "s-1")).toBe(false);
  });

  it("never constrains admin/internal principals or absent ids", () => {
    expect(principalBodySessionForbidden({ kind: "admin" }, "s-2")).toBe(false);
    expect(principalBodySessionForbidden(undefined, "s-2")).toBe(false);
    expect(principalBodySessionForbidden({ kind: "session", sessionId: "s-1" }, undefined)).toBe(false);
    expect(principalBodySessionForbidden({ kind: "session", sessionId: "s-1" }, "")).toBe(false);
  });
});

describe("scopedTokenSessionMismatch — per-session confinement (ARC-CF-001)", () => {
  it("allows a token to reach its own session's routes", () => {
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-1")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-1/message")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-1/queue/pause")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-1/queue/item-9")).toBe(false);
  });

  it("blocks a token from reaching another session's routes", () => {
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-2")).toBe(true);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-2/message")).toBe(true);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-2/reset")).toBe(true);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/other/duplicate")).toBe(true);
  });

  it("does not apply to non-:id collection routes (governed elsewhere)", () => {
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/bulk-delete")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/status")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/org")).toBe(false);
  });

  it("collapses traversal/case before comparing so it cannot be bypassed", () => {
    // Encoded/relative variant that resolves to another session is blocked.
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-1/../s-2/message")).toBe(true);
    // Case-folding: the id compare is case-insensitive both ways.
    expect(scopedTokenSessionMismatch("S-1", "/api/sessions/s-1/message")).toBe(false);
    // A traversal resolving back to the own session stays allowed.
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-2/../s-1/message")).toBe(false);
  });
});
