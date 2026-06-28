import { describe, expect, it } from "vitest"
import { buildSupervisorOptions, portalSupervisorName } from "./supervisor-options"

describe("supervisor options", () => {
  it("only returns real org employees as supervisor options", () => {
    expect(buildSupervisorOptions(
      [{ name: "parliamentarian" }, { name: "worker" }] as Array<{ name: string }>,
      { portalName: "Cuttlefish" },
    )).toEqual(["parliamentarian", "worker"])
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
