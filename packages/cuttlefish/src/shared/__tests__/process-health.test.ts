import { beforeEach, describe, expect, it } from "vitest";
import {
  getProcessHealth,
  isProcessStable,
  recordDroppedNotification,
  recordUncaughtException,
  resetProcessHealthForTest,
} from "../process-health.js";

describe("process-health signals (audit E1/E7)", () => {
  beforeEach(() => resetProcessHealthForTest());

  it("starts stable and clean", () => {
    expect(isProcessStable()).toBe(true);
    expect(getProcessHealth().uncaughtExceptions).toBe(0);
    expect(getProcessHealth().droppedNotifications).toBe(0);
  });

  it("records an uncaught exception and reports unstable (E1)", () => {
    recordUncaughtException(new Error("boom"));
    expect(isProcessStable()).toBe(false);
    const h = getProcessHealth();
    expect(h.uncaughtExceptions).toBe(1);
    expect(h.lastUncaughtMessage).toBe("boom");
    expect(h.lastUncaughtAt).not.toBeNull();
  });

  it("records dropped operator notifications (E7)", () => {
    recordDroppedNotification("connector \"slack\" not running");
    const h = getProcessHealth();
    expect(h.droppedNotifications).toBe(1);
    expect(h.lastDroppedNotificationReason).toContain("slack");
  });
});
