import { describe, expect, it } from "vitest"
import { buildSupervisorOptions, portalSupervisorName } from "./supervisor-options"

describe("supervisor options", () => {
  it("prepends the COO option when /api/org does not include it", () => {
    expect(buildSupervisorOptions(
      [{ name: "parliamentarian" }, { name: "worker" }] as Array<{ name: string }>,
      { portalName: "Cuttlefish" },
    )).toEqual(["cuttlefish", "parliamentarian", "worker"])
  })

  it("does not duplicate the COO when it is already present", () => {
    expect(buildSupervisorOptions(
      [{ name: "cuttlefish" }, { name: "parliamentarian" }] as Array<{ name: string }>,
      { portalName: "Cuttlefish" },
    )).toEqual(["cuttlefish", "parliamentarian"])
  })

  it("excludes the employee currently being edited from the list", () => {
    expect(buildSupervisorOptions(
      [{ name: "cuttlefish" }, { name: "parliamentarian" }] as Array<{ name: string }>,
      { portalName: "Cuttlefish", excludeName: "cuttlefish" },
    )).toEqual(["parliamentarian"])
  })

  it("uses the current portal name to derive the COO slug", () => {
    expect(portalSupervisorName("Octo Ops")).toBe("octo-ops")
  })
})
