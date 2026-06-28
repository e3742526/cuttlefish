import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Employee, OrgData, OrgHierarchy } from "@/lib/api";

const { getOrg, orgMapState } = vi.hoisted(() => ({
  getOrg: vi.fn<() => Promise<OrgData>>(),
  orgMapState: {
    employees: [] as Employee[],
    hierarchy: undefined as OrgHierarchy | undefined,
    selectedName: null as string | null,
  },
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      getOrg,
    },
  };
});

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({
    settings: { portalName: "Cuttlefish" },
  }),
}));

vi.mock("@/context/breadcrumb-context", () => ({
  useBreadcrumbs: () => undefined,
}));

vi.mock("@/components/org/work-summary", () => ({
  WorkSummary: () => <div>Work summary</div>,
}));

vi.mock("@/components/org/employee-detail", () => ({
  EmployeeDetail: ({ name }: { name: string }) => (
    <div data-testid="employee-detail">{name}</div>
  ),
}));

vi.mock("@/components/org/employee-create-form", () => ({
  EmployeeCreateForm: ({ onCancel }: { onCancel: () => void }) => (
    <div>
      <div data-testid="employee-create-form">create form</div>
      <button type="button" onClick={onCancel}>cancel create</button>
    </div>
  ),
}));

vi.mock("@/components/org/org-map", () => ({
  OrgMap: ({
    employees,
    hierarchy,
    selectedName,
    onNodeClick,
  }: {
    employees: Employee[];
    hierarchy?: OrgHierarchy;
    selectedName: string | null;
    onNodeClick: (employee: Employee) => void;
  }) => {
    orgMapState.employees = employees;
    orgMapState.hierarchy = hierarchy;
    orgMapState.selectedName = selectedName;

    return (
      <div data-testid="org-map">
        <div data-testid="org-map-selected">{selectedName ?? "none"}</div>
        {employees.map((employee) => (
          <button
            key={employee.name}
            onClick={() => onNodeClick(employee)}
            type="button"
          >
            {employee.displayName}
          </button>
        ))}
      </div>
    );
  },
}));

import OrgPage from "./page";

function employee(
  partial: Partial<Employee> & { name: string; displayName: string; department: string },
): Employee {
  return {
    rank: "employee",
    engine: "claude",
    model: "sonnet",
    persona: "persona",
    ...partial,
  };
}

const orgData: OrgData = {
  departments: ["Engineering", "Marketing"],
  employees: [
    employee({
      name: "eng-lead",
      displayName: "Eng Lead",
      department: "Engineering",
      rank: "manager",
      directReports: ["engineer"],
      chain: ["eng-lead"],
    }),
    employee({
      name: "engineer",
      displayName: "Engineer",
      department: "Engineering",
      parentName: "eng-lead",
      chain: ["eng-lead", "engineer"],
    }),
    employee({
      name: "marketing-lead",
      displayName: "Marketing Lead",
      department: "Marketing",
      rank: "manager",
      directReports: ["writer"],
      chain: ["marketing-lead"],
    }),
    employee({
      name: "writer",
      displayName: "Writer",
      department: "Marketing",
      parentName: "marketing-lead",
      chain: ["marketing-lead", "writer"],
    }),
  ],
  hierarchy: {
    root: "cuttlefish",
    sorted: ["eng-lead", "engineer", "marketing-lead", "writer"],
    warnings: [],
  },
};

describe("OrgPage department tabs", () => {
  beforeEach(() => {
    getOrg.mockReset();
    getOrg.mockResolvedValue(orgData);
    orgMapState.employees = [];
    orgMapState.hierarchy = undefined;
    orgMapState.selectedName = null;
  });

  function selectTab(name: string) {
    const tab = screen.getByRole("tab", { name });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
  }

  it("renders the All tab plus one tab per department", async () => {
    render(<OrgPage />);

    expect(await screen.findByRole("tab", { name: "All" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Engineering" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Marketing" })).toBeDefined();
  });

  it("switches from All to a department tab and passes only visible employees to the map", async () => {
    render(<OrgPage />);

    await screen.findByTestId("org-map");
    expect(orgMapState.employees.map((employee) => employee.name)).toEqual([
      "cuttlefish",
      "eng-lead",
      "engineer",
      "marketing-lead",
      "writer",
    ]);

    selectTab("Engineering");

    await waitFor(() =>
      expect(orgMapState.employees.map((employee) => employee.name)).toEqual([
        "eng-lead",
        "engineer",
      ]),
    );
    expect(orgMapState.hierarchy?.sorted).toEqual(["eng-lead", "engineer"]);
  });

  it("clears the selection when the selected employee is hidden by a tab switch", async () => {
    render(<OrgPage />);

    await screen.findByTestId("org-map");
    fireEvent.click(screen.getByRole("button", { name: "Marketing Lead" }));

    expect((await screen.findByTestId("employee-detail")).textContent).toContain("marketing-lead");

    selectTab("Engineering");

    await waitFor(() => {
      expect(screen.queryByTestId("employee-detail")).toBeNull();
      expect(orgMapState.selectedName).toBeNull();
    });
  });

  it("preserves employee selection behavior for visible employees in a department tab", async () => {
    render(<OrgPage />);

    await screen.findByTestId("org-map");
    selectTab("Engineering");

    await waitFor(() =>
      expect(orgMapState.employees.map((employee) => employee.name)).toEqual([
        "eng-lead",
        "engineer",
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Engineer" }));

    expect((await screen.findByTestId("employee-detail")).textContent).toContain("engineer");
    expect(orgMapState.selectedName).toBe("engineer");
  });

  it("opens the create-agent panel from the toolbar", async () => {
    render(<OrgPage />);

    await screen.findByTestId("org-map");
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));

    expect(await screen.findByTestId("employee-create-form")).toBeDefined();
    expect(screen.queryByTestId("employee-detail")).toBeNull();
  });

  it("renders the HR steward entry under the org actions", async () => {
    render(<OrgPage />);

    await screen.findByTestId("org-map");
    const link = screen.getByRole("link", { name: "HR / Org Steward" });
    expect(link.getAttribute("href")).toBe("/hr");
  });
});
