export const queryKeys = {
  sessions: {
    all: ['sessions'] as const,
    search: (q: string) => ['sessions', 'search', q] as const,
    detail: (id: string) => ['sessions', id] as const,
    children: (id: string) => ['sessions', id, 'children'] as const,
    transcript: (id: string) => ['sessions', id, 'transcript'] as const,
    queue: (id: string) => ['sessions', id, 'queue'] as const,
  },
  org: {
    all: ['org'] as const,
    employee: (name: string) => ['org', 'employees', name] as const,
    board: (dept: string) => ['org', 'departments', dept, 'board'] as const,
  },
  orgChanges: {
    all: ['org-changes'] as const,
    list: (status?: string) => (status ? (['org-changes', status] as const) : (['org-changes'] as const)),
    detail: (id: string) => ['org-changes', id] as const,
  },
  cron: {
    all: ['cron'] as const,
    runs: (id: string) => ['cron', id, 'runs'] as const,
  },
  skills: {
    all: ['skills'] as const,
    detail: (name: string) => ['skills', name] as const,
  },
  engines: {
    all: ['engines'] as const,
  },
  approvals: {
    all: ['approvals'] as const,
    list: (state?: string, sessionId?: string | null) => ['approvals', state ?? 'pending', sessionId ?? 'all'] as const,
  },
  checkpoints: {
    all: ['checkpoints'] as const,
    list: (state?: string, sessionId?: string | null) => ['checkpoints', state ?? 'pending', sessionId ?? 'all'] as const,
  },
  archives: {
    all: ['archives'] as const,
    detail: (id: string) => ['archives', id] as const,
  },
  work: {
    all: ['work'] as const,
  },
  config: ['config'] as const,
  status: ['status'] as const,
} as const
