import { describe, expect, it } from "vitest";
import { scopedTokenForbidden } from "../scoped-token.js";

describe("scopedTokenForbidden — operator control plane", () => {
  it("blocks the pre-existing operator surfaces", () => {
    expect(scopedTokenForbidden("PUT", "/api/config")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/logs")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/instances")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/auth/pair")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/org/employees")).toBe(true);
  });

  it("blocks human-oversight writes (approvals, checkpoints) but allows reads", () => {
    expect(scopedTokenForbidden("POST", "/api/approvals/abc/approve")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/checkpoints/xyz/decision")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/checkpoints")).toBe(true);
    // An agent may still poll the status of its own pending approval/checkpoint.
    expect(scopedTokenForbidden("GET", "/api/approvals")).toBe(false);
    expect(scopedTokenForbidden("GET", "/api/checkpoints/xyz")).toBe(false);
  });

  it("blocks cron and orchestration mutations but allows reads", () => {
    expect(scopedTokenForbidden("POST", "/api/cron")).toBe(true);
    expect(scopedTokenForbidden("DELETE", "/api/cron/job-1")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/orchestration/queue/pause")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/orchestration/leases/stop")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/orchestration/run")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/cron")).toBe(false);
    expect(scopedTokenForbidden("GET", "/api/orchestration/status")).toBe(false);
  });

  it("still allows the endpoints an agent legitimately needs", () => {
    expect(scopedTokenForbidden("GET", "/api/org")).toBe(false);
    expect(scopedTokenForbidden("GET", "/api/status")).toBe(false);
    expect(scopedTokenForbidden("POST", "/api/sessions")).toBe(false);
    expect(scopedTokenForbidden("POST", "/api/sessions/s-1/message")).toBe(false);
    expect(scopedTokenForbidden("POST", "/api/files")).toBe(false);
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
});
