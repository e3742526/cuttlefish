import { describe, it, expect } from "vitest";
import { summarizeConnectorErrors, summarizeEmailReadiness } from "../status.js";

describe("summarizeConnectorErrors", () => {
  it("returns an empty summary when no connector is in error", () => {
    const result = summarizeConnectorErrors({
      slack: { status: "ok" },
      whatsapp: { status: "ok" },
    });
    expect(result).toEqual({ count: 0, names: [] });
  });

  it("handles null or undefined connector health gracefully without throwing", () => {
    const result = summarizeConnectorErrors({
      slack: { status: "ok" },
      whatsapp: null,
      email: undefined,
    });
    expect(result).toEqual({ count: 0, names: [] });
  });

  it("names the specific connector(s) in error instead of only a count", () => {
    const result = summarizeConnectorErrors({
      slack: { status: "ok" },
      whatsapp: { status: "error" },
    });
    expect(result).toEqual({ count: 1, names: ["whatsapp"] });
  });

  it("names every connector in error so two distinct failures are distinguishable", () => {
    const result = summarizeConnectorErrors({
      slack: { status: "error" },
      whatsapp: { status: "error" },
      email: { status: "ok" },
    });
    expect(result.count).toBe(2);
    expect(result.names).toEqual(["slack", "whatsapp"]);
  });
});

describe("summarizeEmailReadiness", () => {
  it("does not make disabled email a readiness dependency", () => {
    expect(summarizeEmailReadiness(false, false, [])).toEqual({ status: "ok" });
  });

  it("reports enabled inbox failures and uninitialized inboxes honestly", () => {
    expect(summarizeEmailReadiness(true, false, [])).toMatchObject({ status: "error" });
    expect(summarizeEmailReadiness(true, true, [{ id: "ops", health: { status: "error" } }])).toMatchObject({
      status: "error",
      detail: expect.stringContaining("ops"),
    });
    expect(summarizeEmailReadiness(true, true, [{ id: "ops" }])).toMatchObject({ status: "degraded" });
  });
});
