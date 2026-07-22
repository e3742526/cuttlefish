import type { LucideIcon } from "lucide-react"
import {
  Archive,
  MessageSquare,
  Users,
  Clock,
  LayoutGrid,
  Activity,
  Gauge,
  Zap,
  Settings,
  ShieldCheck,
  Network,
  LayoutDashboard,
} from "lucide-react"

/**
 * Canonical vocabulary for FleetView. One entry per domain noun — the single
 * source of truth for what a concept is called and drawn with. Nav labels,
 * page titles, and empty-state copy should read from here rather than
 * re-typing a string, so a noun can never drift into two names across the UI
 * (see docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 4).
 */
export interface VocabularyEntry {
  /** Canonical singular label, sentence case. */
  label: string
  /** Canonical plural (or collective, for uncountable concepts) label. */
  plural: string
  /** One-line, plain-language definition for surfaces whose noun is internal jargon. */
  definition: string
  icon: LucideIcon
}

export const VOCABULARY = {
  chat: {
    label: "Chat",
    plural: "Chats",
    definition: "A conversation thread with an employee, streamed live as work happens.",
    icon: MessageSquare,
  },
  organization: {
    label: "Organization",
    plural: "Organization",
    definition: "The org chart: employees, departments, and the reporting hierarchy between them.",
    icon: Users,
  },
  kanban: {
    label: "Kanban",
    plural: "Kanban",
    definition: "The ticket board tracking work items from backlog through done.",
    icon: LayoutGrid,
  },
  approval: {
    label: "Approval",
    plural: "Approvals",
    definition: "A gated action or checkpoint waiting on human sign-off before an employee continues.",
    icon: ShieldCheck,
  },
  archive: {
    label: "Archive",
    plural: "Archive",
    definition: "Completed and closed sessions kept for reference.",
    icon: Archive,
  },
  cron: {
    label: "Cron",
    plural: "Cron jobs",
    definition: "A scheduled job that runs an employee's prompt on a recurring timer.",
    icon: Clock,
  },
  limits: {
    label: "Limits",
    plural: "Limits",
    definition: "Usage and rate-limit standing per engine and employee.",
    icon: Gauge,
  },
  activity: {
    label: "Activity",
    plural: "Activity",
    definition: "The raw event and log stream across the gateway.",
    icon: Activity,
  },
  skill: {
    label: "Skill",
    plural: "Skills",
    definition: "A reusable markdown playbook employees can follow.",
    icon: Zap,
  },
  settings: {
    label: "Settings",
    plural: "Settings",
    definition: "Gateway configuration, connectors, and engine setup.",
    icon: Settings,
  },
  commandCenter: {
    label: "Command Center",
    plural: "Command Center",
    definition: "The operator overview: what needs attention across the whole organization right now.",
    icon: LayoutDashboard,
  },
  orchestration: {
    label: "Orchestration",
    plural: "Orchestration",
    definition: "Low-level scheduler internals — worker queues, holds, continuations, and worktrees.",
    icon: Network,
  },
} as const satisfies Record<string, VocabularyEntry>

export type VocabularyKey = keyof typeof VOCABULARY

export function vocab(key: VocabularyKey): VocabularyEntry {
  return VOCABULARY[key]
}
