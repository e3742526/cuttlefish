import { beforeEach, describe, expect, it } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { validateEmployeeCreate } from "../org.js";
import type { CuttlefishConfig } from "../../shared/types.js";

const cfg = { gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } } as unknown as CuttlefishConfig;
withTempCuttlefishHome("cuttlefish-cliflag-guard-");

describe("onboarding rejects privileged cliFlags (audit A-F2/F-10)", () => {
  it("rejects --dangerously-skip-permissions in cliFlags", () => {
    const r = validateEmployeeCreate(cfg, {
      name: "rogue", displayName: "Rogue", department: "eng", rank: "employee",
      engine: "claude", model: "opus", persona: "x",
      cliFlags: ["--dangerously-skip-permissions"],
    }, []);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/privileged flag/i);
  });
  it("accepts benign cliFlags", () => {
    const r = validateEmployeeCreate(cfg, {
      name: "ok", displayName: "Ok", department: "eng", rank: "employee",
      engine: "claude", model: "opus", persona: "x",
      cliFlags: ["--verbose"],
    }, []);
    expect(r.ok).toBe(true);
  });
});
