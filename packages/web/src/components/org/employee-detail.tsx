import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Employee } from "@/lib/api";
import { EmployeeAvatar } from "@/components/ui/employee-avatar";
import { EmployeeEditor } from "@/components/org/employee-editor";
import { describeRolePolicy } from "@/lib/role-policy";

interface SessionData {
  id: string;
  employee?: string | null;
  status?: string;
  createdAt?: string;
  source?: string;
  [key: string]: unknown;
}

function RankBadge({ rank }: { rank: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    executive: {
      bg: "color-mix(in srgb, var(--system-purple) 15%, transparent)",
      text: "var(--system-purple)",
    },
    manager: {
      bg: "color-mix(in srgb, var(--system-blue) 15%, transparent)",
      text: "var(--system-blue)",
    },
    senior: {
      bg: "color-mix(in srgb, var(--system-green) 15%, transparent)",
      text: "var(--system-green)",
    },
    employee: {
      bg: "var(--fill-tertiary)",
      text: "var(--text-tertiary)",
    },
  };
  const c = colors[rank] || colors.employee;

  return (
    <span
      className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] px-[10px] py-[2px] rounded-[10px] uppercase tracking-[0.02em]"
      style={{ color: c.text, background: c.bg }}
    >
      {rank}
    </span>
  );
}

function LifecycleBadge({ lifecycle }: { lifecycle: string }) {
  // Only non-active states reach here; flag them with a muted/amber/red tone.
  const tone =
    lifecycle === "retired" || lifecycle === "disabled"
      ? { bg: "color-mix(in srgb, var(--system-red) 15%, transparent)", text: "var(--system-red)" }
      : { bg: "color-mix(in srgb, var(--system-orange) 15%, transparent)", text: "var(--system-orange)" };
  return (
    <span
      className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] px-[10px] py-[2px] rounded-[10px] uppercase tracking-[0.02em]"
      style={{ color: tone.text, background: tone.bg }}
    >
      {lifecycle}
    </span>
  );
}

function executionProfileLabel(tier: string | undefined, fallback: string | undefined): string {
  if (tier === "mid_pair") return "Review profile"
  return fallback || "Solo"
}

export function EmployeeDetail({
  name,
  prefetched,
  onUpdated,
  onDeleted,
}: {
  name: string;
  prefetched?: Employee;
  onUpdated?: (emp: Employee) => void;
  onDeleted?: (emp: Employee) => void;
}) {
  const [employee, setEmployee] = useState<Employee | null>(prefetched ?? null);
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [loading, setLoading] = useState(!prefetched);
  const [error, setError] = useState<string | null>(null);
  const [personaExpanded, setPersonaExpanded] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setPersonaExpanded(false);
    setEditing(false);

    if (prefetched) {
      setEmployee(prefetched);
      setLoading(true);
      setError(null);
      api.getSessionsForGroup(name, 0, 10)
        .then((empSessions) => setSessions(empSessions as SessionData[]))
        .catch(() => setSessions([]))
        .finally(() => setLoading(false));
      return;
    }

    setLoading(true);
    setError(null);

    Promise.all([api.getEmployee(name), api.getSessionsForGroup(name, 0, 10)])
      .then(([emp, empSessions]) => {
        setEmployee(emp);
        setSessions(empSessions as SessionData[]);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [name, prefetched]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-[var(--radius-md,12px)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]"
        style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)" }}
      >
        Failed to load employee: {error}
      </div>
    );
  }

  if (!employee) return null;

  if (editing) {
    return (
      <EmployeeEditor
        employee={employee}
        onCancel={() => setEditing(false)}
        onSaved={(emp) => {
          setEmployee(emp);
          setEditing(false);
          onUpdated?.(emp);
        }}
        onDeleted={(emp) => {
          setEditing(false);
          onDeleted?.(emp);
        }}
      />
    );
  }

  const rank = employee.rank || "employee";
  const persona = employee.persona || "";
  const editable = rank !== "executive";
  const truncatedPersona =
    persona.length > 200 && !personaExpanded
      ? persona.slice(0, 200) + "..."
      : persona;

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      {/* Main info card */}
      <div className="rounded-[var(--radius-lg,16px)] border border-[var(--separator)] bg-[var(--material-regular)] p-[var(--space-6)]">
        <div className="flex items-start justify-between mb-[var(--space-4)]">
          <div className="flex items-center gap-[var(--space-3)]">
            <EmployeeAvatar
              name={employee.name}
              avatar={employee.avatar}
              emoji={employee.emoji}
              size={36}
              onClick={editable ? () => setEditing(true) : undefined}
            />
            <div>
              <h2 className="text-[length:var(--text-title2)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] m-0">
                {employee.displayName || employee.name}
              </h2>
              <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[2px] mb-0 ml-0 mr-0 font-[family-name:var(--font-mono)]">
                {employee.name}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-[var(--space-2)]">
            <RankBadge rank={rank} />
            {employee.lifecycle && employee.lifecycle !== "active" && (
              <LifecycleBadge lifecycle={employee.lifecycle} />
            )}
            {/* The COO node is injected client-side (no YAML) — not editable. */}
            {editable && (
              <button
                onClick={() => setEditing(true)}
                aria-label="Edit employee"
                className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] px-[10px] py-[3px] rounded-[10px] border border-[var(--separator)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] bg-transparent cursor-pointer transition-colors"
              >
                Edit
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-[var(--space-4)]">
          <div>
            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
              Department
            </p>
            <p className="text-[length:var(--text-body)] text-[var(--text-primary)] m-0">
              {employee.department || "None"}
            </p>
          </div>
          <div>
            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
              Engine
            </p>
            <p className="text-[length:var(--text-body)] text-[var(--text-primary)] m-0">
              {employee.engine || "claude"}{" "}
              <span className="text-[var(--text-tertiary)]">
                / {employee.model || "default"}
              </span>
            </p>
          </div>
        </div>

        {employee.executionProfileSummary && (
          <div className="mt-[var(--space-4)] pt-[var(--space-4)] border-t border-[var(--separator)]">
            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
              Execution profile
            </p>
            <div className="flex flex-wrap items-center gap-[var(--space-2)]">
              <span
                className="rounded-[10px] px-[10px] py-[2px] text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[0.02em]"
                style={
                  employee.executionProfileSummary.tier === "mid_pair"
                    ? {
                        color: "var(--system-purple)",
                        background: "color-mix(in srgb, var(--system-purple) 15%, transparent)",
                      }
                    : {
                        color: "var(--text-tertiary)",
                        background: "var(--fill-tertiary)",
                      }
                }
              >
                {executionProfileLabel(employee.executionProfileSummary.tier, employee.executionProfileSummary.label)}
              </span>
              {employee.executionProfileSummary.tier === "mid_pair" && (
                <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                  configuration only unless the gateway enables multi-role execution
                </span>
              )}
              {employee.executionProfileSummary.tier === "mid_pair" && employee.executionProfileSummary.reviewerLossPolicy && (
                <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                  on reviewer loss: {employee.executionProfileSummary.reviewerLossPolicy.replace(/_/g, " ")}
                </span>
              )}
              {employee.executionProfileSummary.tier === "mid_pair" && employee.executionProfileSummary.reviewerToolProfile && (
                <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                  · {employee.executionProfileSummary.reviewerToolProfile.replace(/_/g, " ")}
                </span>
              )}
              {employee.executionProfileSummary.tier === "mid_pair" && employee.execution?.roles && (
                <div className="w-full flex flex-col gap-[2px] mt-[var(--space-1)]">
                  {(["implementer", "reviewer"] as const).map((role) => {
                    const policy = employee.execution?.roles?.[role]
                    if (!policy) return null
                    return (
                      <span key={role} className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                        {role}: {describeRolePolicy(policy, { engine: employee.engine, model: employee.model })}
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {persona && (
          <div className="mt-[var(--space-4)] pt-[var(--space-4)] border-t border-[var(--separator)]">
            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
              Persona
            </p>
            <p className="text-[length:var(--text-body)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)] whitespace-pre-wrap m-0">
              {truncatedPersona}
            </p>
            {persona.length > 200 && (
              <button
                onClick={() => setPersonaExpanded(!personaExpanded)}
                className="text-[length:var(--text-caption1)] text-[var(--accent)] bg-none border-none cursor-pointer p-0 mt-[var(--space-1)]"
              >
                {personaExpanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Recent Sessions */}
      <div>
        <h3 className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)] mb-[var(--space-3)]">
          Recent Sessions
        </h3>
        {sessions.length === 0 ? (
          <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] text-center py-[var(--space-6)] px-0">
            No sessions found for this employee.
          </p>
        ) : (
          <div className="rounded-[var(--radius-lg,16px)] border border-[var(--separator)] bg-[var(--material-regular)] overflow-hidden">
            {sessions.map((session, idx) => (
              <div
                key={session.id}
                className={`px-[var(--space-5)] py-[var(--space-3)] flex items-center justify-between${idx > 0 ? " border-t border-[var(--separator)]" : ""}`}
              >
                <div>
                  <p className="text-[length:var(--text-body)] font-[family-name:var(--font-mono)] text-[var(--text-primary)] m-0">
                    {session.id.slice(0, 8)}
                  </p>
                  <p className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mt-[2px]">
                    {session.source || "unknown"}{" "}
                    {session.createdAt
                      ? new Date(session.createdAt).toLocaleDateString()
                      : ""}
                  </p>
                </div>
                <span
                  className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] py-[2px] px-[8px] rounded-[10px]"
                  style={
                    session.status === "running"
                      ? {
                          background:
                            "color-mix(in srgb, var(--system-green) 15%, transparent)",
                          color: "var(--system-green)",
                        }
                      : session.status === "error"
                        ? {
                            background:
                              "color-mix(in srgb, var(--system-red) 15%, transparent)",
                            color: "var(--system-red)",
                          }
                        : {
                            background: "var(--fill-tertiary)",
                            color: "var(--text-tertiary)",
                          }
                  }
                >
                  {session.status || "idle"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
