import { AlertTriangle, ChevronDown, FolderTree } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SessionProject } from "./project-session-tree"
import { formatTime, getMostUrgentDot } from "./sidebar-session-helpers"
import { SessionRow, StatusDot, type SidebarSharedRowProps } from "./sidebar-row-components"

export function ProjectHeaderRow({
  project,
  expanded,
  selectedId,
  readSessions,
  onOpen,
  onToggle,
}: {
  project: SessionProject
  expanded: boolean
  selectedId: string | null
  readSessions: Set<string>
  onOpen: (project: SessionProject) => void
  onToggle: (rootSessionId: string) => void
}) {
  const selected = project.sessions.some((session) => session.id === selectedId)
  const dot = getMostUrgentDot(project.sessions, readSessions)
  const time = formatTime(project.lastActivity)
  const integrityLabel = project.integrity === "cycle" ? "Session cycle detected" : "Parent session is not loaded"

  return (
    <div
      role="treeitem"
      aria-expanded={expanded}
      aria-level={1}
      className={cn(
        "group/project relative flex w-full items-center gap-2 border-l-2 px-4 py-3 text-left transition-colors",
        selected
          ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
          : "border-l-transparent hover:bg-[var(--fill-tertiary)]",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(project)}
        aria-current={selected ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--fill-tertiary)] text-[var(--text-secondary)]">
          <FolderTree className="size-4" />
          {dot ? (
            <StatusDot
              color={dot.color}
              pulse={dot.pulse}
              title={dot.label}
              className="absolute -bottom-0.5 -right-0 size-2.5 border-2 border-[var(--sidebar-bg)]"
            />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="mb-0.5 flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-[13px] text-foreground", selected ? "font-semibold" : "font-medium")}>
              {project.title}
            </span>
            {time ? <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">{time}</span> : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-[var(--text-tertiary)]">
            <span className="shrink-0 rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px]">
              {project.sessions.length} {project.sessions.length === 1 ? "session" : "sessions"}
            </span>
            {project.participantIds.length > 0 ? (
              <span className="shrink-0 rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px]">
                {project.participantIds.length} {project.participantIds.length === 1 ? "agent" : "agents"}
              </span>
            ) : null}
            {project.needsAttentionCount > 0 ? (
              <span className="shrink-0 font-medium text-[var(--system-orange)]">{project.needsAttentionCount} need you</span>
            ) : null}
            {project.integrity !== "valid" ? (
              <span title={integrityLabel} aria-label={integrityLabel} className="shrink-0 text-[var(--system-orange)]">
                <AlertTriangle className="size-3" />
              </span>
            ) : null}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onToggle(project.rootSessionId)
        }}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${project.title}`}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")} />
      </button>
    </div>
  )
}

export function ProjectSessionRow({
  project,
  session,
  depth,
  sharedRowProps,
  onSelect,
}: {
  project: SessionProject
  session: SessionProject["rootSession"]
  depth: number
  sharedRowProps: SidebarSharedRowProps
  onSelect: () => void
}) {
  return (
    <div role="treeitem" aria-level={depth + 2}>
      <SessionRow
        session={session}
        depth={depth}
        parentSessions={project.sessions}
        {...sharedRowProps}
        onSelect={onSelect}
      />
    </div>
  )
}
