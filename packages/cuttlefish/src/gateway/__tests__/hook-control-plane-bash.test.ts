import { describe, expect, it } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { bashReferencesControlPlane } from "../hook-endpoint.js";
import { CUTTLEFISH_HOME } from "../../shared/paths.js";

withTempCuttlefishHome("cuttlefish-hook-cp-");

describe("Bash control-plane guard (audit F-03/G-01/G-06)", () => {
  it("blocks an absolute-path read of the gateway credentials", () => {
    expect(bashReferencesControlPlane(`cat ${CUTTLEFISH_HOME}/gateway.json`)).toBe(true);
  });
  it("blocks a write to config.yaml", () => {
    expect(bashReferencesControlPlane(`echo pwn >> ${CUTTLEFISH_HOME}/config.yaml`)).toBe(true);
  });
  it("blocks a sed -i against the org roster", () => {
    expect(bashReferencesControlPlane(`sed -i s/a/b/ ${CUTTLEFISH_HOME}/org/coo.yaml`)).toBe(true);
  });
  it("allows an unrelated command", () => {
    expect(bashReferencesControlPlane("ls -la /tmp && cat README.md")).toBe(false);
  });
});
