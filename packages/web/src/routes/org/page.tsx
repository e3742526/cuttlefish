import { lazy, Suspense, useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { Users } from "lucide-react";
import { api } from "@/lib/api";
import type { Employee, OrgData, OrgHierarchy } from "@/lib/api";
import { EmployeeDetail } from "@/components/org/employee-detail";
import { EmployeeCreateForm } from "@/components/org/employee-create-form";
import { WorkSummary } from "@/components/org/work-summary";
import { PageLayout } from "@/components/page-layout";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useSettings } from "@/routes/settings-provider";
import { useBreadcrumbs } from "@/context/breadcrumb-context";
import { portalEmployeeSlug } from "@/lib/portal-slug";

const OrgMap = lazy(() =>
  import("@/components/org/org-map").then((m) => ({ default: m.OrgMap })),
);

const OrgMapFallback = (
  <div className="flex flex-col items-center justify-center h-full gap-[var(--space-3)] text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
    Loading map...
  </div>
);

const ALL_DEPARTMENTS_TAB = "all";
const UNASSIGNED_DEPARTMENT_TAB = "__unassigned__";
const HR_EMPLOYEE_NAME = "hr-manager";

function mergeDepartmentOption(departments: string[], department: string | undefined): string[] {
  const next = department?.trim();
  if (!next || departments.includes(next)) return departments;
  return [...departments, next];
}

function buildVisibleOrgView(
  employees: Employee[],
  hierarchy: OrgHierarchy | undefined,
  activeDepartment: string | null,
): { employees: Employee[]; hierarchy: OrgHierarchy | undefined } {
  if (!activeDepartment) {
    return { employees, hierarchy };
  }

  const visibleEmployees = employees.filter((employee) => {
    if (activeDepartment === UNASSIGNED_DEPARTMENT_TAB) {
      return employee.rank !== "executive" && !employee.department;
    }
    return employee.department === activeDepartment;
  });
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
  const [renamingDepartment, setRenamingDepartment] = useState(false);
  const [renameDepartmentValue, setRenameDepartmentValue] = useState("");
  const [renameDepartmentSaving, setRenameDepartmentSaving] = useState(false);
  const [renameDepartmentError, setRenameDepartmentError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { settings } = useSettings();

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getOrg()
      .then((data: OrgData) => {
        const coo: Employee = {
          name: portalEmployeeSlug(settings.portalName),
          displayName: settings.portalName ?? "Jinn",
          department: "",
          rank: "executive",
          engine: "claude",
          model: "opus",
          persona: "COO and AI gateway daemon",
        };
        const employees = data.employees.some((employee) => employee.name === coo.name)
          ? data.employees
          : [coo, ...data.employees];
        setDepartments(data.departments);
        setEmployees(employees);
        setHierarchy(data.hierarchy);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [settings.portalName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (
      activeDepartment &&
      activeDepartment !== UNASSIGNED_DEPARTMENT_TAB &&
      !departments.includes(activeDepartment)
    ) {
      setActiveDepartment(null);
    }
  }, [activeDepartment, departments]);

  useEffect(() => {
    setRenamingDepartment(false);
    setRenameDepartmentValue(activeDepartment ?? "");
    setRenameDepartmentError(null);
  }, [activeDepartment]);

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

  const startRenameDepartment = useCallback(() => {
    if (!activeDepartment || activeDepartment === UNASSIGNED_DEPARTMENT_TAB) return;
    setRenameDepartmentValue(activeDepartment);
    setRenameDepartmentError(null);
    setRenamingDepartment(true);
  }, [activeDepartment]);

  const submitRenameDepartment = useCallback(async () => {
    if (!activeDepartment || activeDepartment === UNASSIGNED_DEPARTMENT_TAB) return;
    const nextName = renameDepartmentValue.trim();
    if (!nextName || nextName === activeDepartment) {
      setRenameDepartmentError("Choose a different department name.");
      return;
    }
    setRenameDepartmentSaving(true);
    setRenameDepartmentError(null);
    try {
      const result = await api.renameDepartment(activeDepartment, nextName);
      setDepartments((current) => current.map((entry) => entry === activeDepartment ? result.department : entry));
      setActiveDepartment(result.department);
      setRenamingDepartment(false);
      loadData();
    } catch (err) {
      setRenameDepartmentError(err instanceof Error ? err.message : "Failed to rename department.");
    } finally {
      setRenameDepartmentSaving(false);
    }
  }, [activeDepartment, loadData, renameDepartmentValue]);

  // After an inline edit: reload the org (so the map re-parents / re-layouts on
  // a reportsTo change) and refresh the open panel with the saved employee.
  const handleEmployeeUpdated = useCallback(
    (emp: Employee) => {
      setDepartments((current) => mergeDepartmentOption(current, emp.department));
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

  // Drag-to-reassign from the map (see OrgMap's onReassign) — a single new
  // primary supervisor, matching the plan's "drag with explicit drop
  // confirmation" interaction. Multi-supervisor reassignment stays in the
  // full employee editor form.
  const handleReassignEmployee = useCallback(
    async (employee: Employee, newManagerName: string) => {
      await api.updateEmployee(employee.name, { reportsTo: [newManagerName] });
      loadData();
    },
    [loadData],
  );

  const visibleOrg = useMemo(
    () => buildVisibleOrgView(employees, hierarchy, activeDepartment),
    [activeDepartment, employees, hierarchy],
  );
  const hasUnassignedEmployees = useMemo(
    () => employees.some((employee) => employee.rank !== "executive" && !employee.department),
    [employees],
  );
  const hasHrSteward = useMemo(
    () => employees.some((employee) => employee.name === HR_EMPLOYEE_NAME),
    [employees],
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
        <div className="flex h-full items-center justify-center p-[var(--space-6)]">
          <ErrorState className="max-w-md" message={`Failed to load organization: ${error}`} onRetry={loadData} />
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
                {hasUnassignedEmployees && (
                  <TabsTrigger value={UNASSIGNED_DEPARTMENT_TAB}>
                    Unassigned
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>
            {activeDepartment && activeDepartment !== UNASSIGNED_DEPARTMENT_TAB && (
              <div className="flex max-w-full flex-wrap items-center gap-[var(--space-2)]">
                {renamingDepartment ? (
                  <>
                    <input
                      className="h-8 w-[min(240px,calc(100vw-160px))] rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--material-regular)]/95 px-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                      value={renameDepartmentValue}
                      aria-label="Department name"
                      onChange={(event) => setRenameDepartmentValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void submitRenameDepartment();
                        if (event.key === "Escape") setRenamingDepartment(false);
                      }}
                      disabled={renameDepartmentSaving}
                    />
                    <button
                      type="button"
                      onClick={() => void submitRenameDepartment()}
                      disabled={renameDepartmentSaving}
                      className="h-8 px-[var(--space-3)] rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)] text-[length:var(--text-footnote)] font-[var(--weight-semibold)] disabled:opacity-60"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenamingDepartment(false)}
                      disabled={renameDepartmentSaving}
                      className="h-8 px-[var(--space-3)] rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--material-regular)]/95 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)] disabled:opacity-60"
                    >
                      Cancel
                    </button>
                    {renameDepartmentError && (
                      <span className="text-[length:var(--text-caption2)] text-[var(--system-red)]">
                        {renameDepartmentError}
                      </span>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={startRenameDepartment}
                    className="h-8 px-[var(--space-3)] rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--material-regular)]/95 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]"
                  >
                    Rename department
                  </button>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-[var(--space-2)]">
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
              {hasHrSteward && (
                <Link
                  to={`/?employee=${encodeURIComponent(HR_EMPLOYEE_NAME)}`}
                  className="inline-flex h-8 items-center rounded-[var(--radius-sm)] border border-[color-mix(in_srgb,var(--accent)_28%,var(--separator))] bg-[color-mix(in_srgb,var(--accent)_10%,var(--material-regular))] px-[var(--space-3)] text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent)]"
                >
                  HR chat
                </Link>
              )}
            </div>
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
              Loading...
            </div>
          ) : visibleOrg.employees.length === 0 ? (
            <EmptyState
              className="h-full"
              icon={Users}
              title={activeDepartment ? "No employees in this department" : "No employees yet"}
              description={
                activeDepartment
                  ? "Reassign an employee here, or pick a different department tab."
                  : "Add your first employee to start building the org."
              }
            />
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
                onReassign={handleReassignEmployee}
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
                      setDepartments((current) => mergeDepartmentOption(current, employee.department))
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
