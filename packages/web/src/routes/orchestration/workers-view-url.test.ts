import { describe, expect, it } from "vitest"
import {
  buildOrchestrationViewSearch,
  readOrchestrationTab,
  readWorkersViewUrlState,
} from "./workers-view-url"

describe("Workers DataView URL state", () => {
  it("reads a shareable Workers view and rejects an invalid tab", () => {
    const search = "?tab=Workers&workersSearch=openai&workersSort=provider&workersDirection=desc&workersColumns=capabilities,workspace,capabilities&worker=worker-2"

    expect(readOrchestrationTab(search)).toBe("Workers")
    expect(readWorkersViewUrlState(search)).toEqual({
      search: "openai",
      sort: { key: "provider", direction: "desc" },
      hiddenColumns: ["capabilities", "workspace"],
      selectedWorkerId: "worker-2",
    })
    expect(readOrchestrationTab("?tab=unknown")).toBe("Overview")
  })

  it("updates only FleetView parameters and retains unrelated route state", () => {
    const query = buildOrchestrationViewSearch("?source=notice&tab=Queue", {
      tab: "Workers",
      workers: {
        search: "openai",
        sort: { key: "provider", direction: "asc" },
        hiddenColumns: ["capabilities"],
        selectedWorkerId: "worker-2",
      },
    })
    const params = new URLSearchParams(query)

    expect(params.get("source")).toBe("notice")
    expect(params.get("tab")).toBe("Workers")
    expect(params.get("workersSearch")).toBe("openai")
    expect(params.get("workersSort")).toBe("provider")
    expect(params.get("workersDirection")).toBe("asc")
    expect(params.get("workersColumns")).toBe("capabilities")
    expect(params.get("worker")).toBe("worker-2")
  })

  it("removes default Workers parameters without dropping unrelated query state", () => {
    const query = buildOrchestrationViewSearch("?source=notice&tab=Workers&worker=worker-2", {
      tab: "Overview",
      workers: { search: "", sort: null, hiddenColumns: [], selectedWorkerId: null },
    })

    expect(query).toBe("source=notice")
  })
})
