import { lazy, Suspense, useEffect, useState, useRef, useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import type { Employee, OrgData, OrgHierarchy } from "@/lib/api";
import { EmployeeDetail } from "@/components/org/employee-detail";
import { EmployeeCreateForm } from "@/components/org/employee-create-form";
import { WorkSummary } from "@/components/org/work-summary";
import { PageLayout } from "@/components/page-layout";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSettings } from "@/routes/settings-provider";
import { useBreadcrumbs } from "@/context/breadcrumb-context";

const OrgMap = lazy(() =>
  import("@/components/org/org-map").then((m) => ({ default: m.OrgMap })),
);

const OrgMapFallback = (
  <div className="flex flex-col items-center justify-center h-full gap-[var(--space-3)] text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
    Loading map...
  </div>
);

const ALL_DEPARTMENTS_TAB = "all";

function buildVisibleOrgView(
  employees: Employee[],
  hierarchy: OrgHierarchy | undefined,
  activeDepartment: string | null,
): { employees: Employee[]; hierarchy: OrgHierarchy | undefined } {
  if (!activeDepartment) {
    return { employees, hierarchy };
  }

  const visibleEmployees = employees.filter(
    (employee) => employee.department === activeDepartment,
  );
  const visibleNames = new Set(visibleEmployees.map((employee) => employee.name));

  if (!hierarchy) {
    return { employees: visibleEmployees, hierarchy: undefined };
  }

  const sorted = hierarchy.sorted.filter((name) => visibleNames.has(name));
  const remaining = visibleEmployees
    .map((employee) => employee.name)
    .filter((name) => !sorted.includes(name));

  return {
    employees: visibleEmployees,
    hierarchy: {
      root: hierarchy.root && visibleNames.has(hierarchy.root) ? hierarchy.root : null,
      sorted: [...sorted, ...remaining],
      warnings: hierarchy.warnings.filter((warning) => visibleNames.has(warning.employee)),
    },
  };
}

export default function OrgPage() {
  useBreadcrumbs([{ label: 'Organization' }])
  const [departments, setDepartments] = useState<string[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [hierarchy, setHierarchy] = useState<OrgHierarchy | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [creating, setCreating] = useState(false);
  const [activeDepartment, setActiveDepartment] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { settings } = useSettings();

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getOrg()
      .then((data: OrgData) => {
        const coo: Employee = {
          name: (settings.portalName ?? "Jinn").toLowerCase(),
          displayName: settings.portalName ?? "Jinn",
          department: "",
          rank: "executive",
          engine: "claude",
          model: "opus",
          persona: "COO and AI gateway daemon",
        };
        setDepartments(data.departments);
        setEmployees([coo, ...data.employees]);
        setHierarchy(data.hierarchy);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [settings.portalName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (activeDepartment && !departments.includes(activeDepartment)) {
      setActiveDepartment(null);
    }
  }, [activeDepartment, departments]);

  // Focus close button when panel opens
  useEffect(() => {
    if (selected && closeRef.current) {
      closeRef.current.focus();
    }
  }, [selected]);

  // ESC closes panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && selected) {
        setSelected(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selected]);

  const handleSelectEmployee = useCallback((emp: Employee) => {
    setCreating(false);
    setSelected(emp);
  }, []);

  // After an inline edit: reload the org (so the map re-parents / re-layouts on
  // a reportsTo change) and refresh the open panel with the saved employee.
  const handleEmployeeUpdated = useCallback(
    (emp: Employee) => {
      loadData();
      setSelected(emp);
      setCreating(false);
    },
    [loadData],
  );

  // After a delete: reload the org and close the detail panel.
  const handleEmployeeDeleted = useCallback(() => {
    loadData();
    setSelected(null);
    setCreating(false);
  }, [loadData]);

  const visibleOrg = useMemo(
    () => buildVisibleOrgView(employees, hierarchy, activeDepartment),
    [activeDepartment, employees, hierarchy],
  );
  const visibleEmployeeNames = useMemo(
    () => new Set(visibleOrg.employees.map((employee) => employee.name)),
    [visibleOrg.employees],
  );

  useEffect(() => {
    if (selected && !visibleEmployeeNames.has(selected.name)) {
      setSelected(null);
    }
  }, [selected, visibleEmployeeNames]);

  if (error) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center h-full gap-[var(--space-4)] text-[var(--text-tertiary)]">
          <div className="rounded-[var(--radius-md,12px)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-body)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)" }}>
            Failed to load organization: {error}
          </div>
          <button
            onClick={loadData}
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md,12px)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-body)] font-[var(--weight-semibold)]"
          >
            Retry
          </button>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <div className="flex h-full relative bg-[var(--bg)]">
        {/* Map (the only view) */}
        <div className="flex-1 h-full relative">
          <div className="absolute top-0 left-0 z-20 flex max-w-full flex-col items-start gap-[var(--space-2)] bg-gradient-to-b from-[var(--bg)] via-[var(--bg)] to-transparent pb-[var(--space-4)]">
            <WorkSummary />
            <Tabs
              value={activeDepartment ?? ALL_DEPARTMENTS_TAB}
              onValueChange={(value) =>
                setActiveDepartment(value === ALL_DEPARTMENTS_TAB ? null : value)
              }
              className="max-w-full"
            >
              <TabsList
                aria-label="Filter organization by department"
                className="h-auto max-w-full flex-wrap justify-start border border-[var(--separator)] bg-[var(--material-regular)]/95"
              >
                <TabsTrigger value={ALL_DEPARTMENTS_TAB}>All</TabsTrigger>
                {departments.map((department) => (
                  <TabsTrigger key={department} value={department}>
                    {department}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <button
              type="button"
              onClick={() => {
                setSelected(null)
                setCreating(true)
              }}
              className="h-8 px-[var(--space-3)] rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--material-regular)]/95 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]"
            >
              Add agent
            </button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
              Loading...
            </div>
          ) : (
            <Suspense fallback={OrgMapFallback}>
              {/* Remount per department tab so React Flow's `fitView` re-runs and
                  zoom-to-fits the selected team. The key is the active team only,
                  so selecting a node (which doesn't change it) never re-zooms. */}
              <OrgMap
                key={activeDepartment ?? ALL_DEPARTMENTS_TAB}
                employees={visibleOrg.employees}
                hierarchy={visibleOrg.hierarchy}
                selectedName={selected?.name ?? null}
                onNodeClick={handleSelectEmployee}
              />
            </Suspense>
          )}
        </div>

        {/* Mobile backdrop */}
        {(selected || creating) && (
          <div
            className="fixed inset-0 z-30 lg:hidden bg-black/50"
            onClick={() => {
              setSelected(null)
              setCreating(false)
            }}
          />
        )}

        {/* Detail panel */}
        {(selected || creating) && (
          <div className="absolute top-0 right-0 bottom-0 left-0 sm:left-auto z-30">
            <div className="w-full sm:w-[420px] lg:w-[468px] xl:w-[520px] max-w-[100vw] h-full overflow-y-auto bg-[var(--bg)] flex flex-col shadow-[var(--shadow-overlay)]">
              {/* Close button */}
              <div className="sticky top-0 z-10 flex items-center justify-end px-[var(--space-4)] py-[var(--space-3)] bg-[var(--bg)]">
                <button
                  ref={closeRef}
                  onClick={() => {
                    setSelected(null)
                    setCreating(false)
                  }}
                  aria-label="Close detail panel"
                  className="w-[30px] h-[30px] rounded-full flex items-center justify-center bg-[var(--fill-tertiary)] text-[var(--text-secondary)] border-none cursor-pointer text-sm"
                >
                  &#x2715;
                </button>
              </div>

              {/* Employee detail */}
              <div className="px-[var(--space-4)] pb-[var(--space-6)]">
                {creating ? (
                  <EmployeeCreateForm
                    onCancel={() => setCreating(false)}
                    onCreated={(employee) => {
                      loadData()
                      setCreating(false)
                      setSelected(employee)
                    }}
                  />
                ) : selected ? (
                  <EmployeeDetail
                    name={selected.name}
                    prefetched={selected.rank === "executive" ? selected : undefined}
                    onUpdated={handleEmployeeUpdated}
                    onDeleted={handleEmployeeDeleted}
                  />
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
