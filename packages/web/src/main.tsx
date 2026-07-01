import { Component, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ClientProviders } from './routes/client-providers'
import { lazyRoute } from './lib/lazy-route'
import './routes/globals.css'

const ChatPage = lazyRoute(() => import('./routes/chat/page'), 'chat')
const CommandPage = lazyRoute(() => import('./routes/command/page'), 'command')
const CronPage = lazyRoute(() => import('./routes/cron/page'), 'cron')
const KanbanPage = lazyRoute(() => import('./routes/kanban/page'), 'kanban')
const ApprovalsPage = lazyRoute(() => import('./routes/approvals/page'), 'approvals')
const ArchivePage = lazyRoute(() => import('./routes/archive/page'), 'archive')
const LogsPage = lazyRoute(() => import('./routes/logs/page'), 'logs')
const LimitsPage = lazyRoute(() => import('./routes/limits/page'), 'limits')
const OrchestrationPage = lazyRoute(() => import('./routes/orchestration/page'), 'orchestration')
const OrgPage = lazyRoute(() => import('./routes/org/page'), 'org')
const SettingsPage = lazyRoute(() => import('./routes/settings/page'), 'settings')
const SkillsPage = lazyRoute(() => import('./routes/skills/page'), 'skills')
const FilePage = lazyRoute(() => import('./routes/file/page'), 'file')
const RedesignPage = lazyRoute(() => import('./routes/redesign/page'), 'redesign')
const TalkPage = lazyRoute(() => import('./routes/talk/page'), 'talk')

function RouteLoading() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background" role="status" aria-label="Loading page">
      <div className="size-5 animate-spin rounded-full border-2 border-[var(--fill-tertiary)] border-t-[var(--accent)]" />
    </div>
  )
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[AppErrorBoundary]', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <div className="text-sm font-medium text-foreground">Web UI needs a refresh</div>
        <button
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] active:scale-[0.96] transition-transform"
          onClick={() => window.location.reload()}
        >
          Refresh
        </button>
      </div>
    )
  }
}

function App() {
  return (
    <AppErrorBoundary>
      <BrowserRouter>
        <ClientProviders>
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<ChatPage />} />
              <Route path="/chat" element={<Navigate to="/" replace />} />
              <Route path="/command" element={<CommandPage />} />
              <Route path="/cron" element={<CronPage />} />
              <Route path="/kanban" element={<KanbanPage />} />
              <Route path="/approvals" element={<ApprovalsPage />} />
              <Route path="/archive" element={<ArchivePage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/limits" element={<LimitsPage />} />
              <Route path="/orchestration" element={<OrchestrationPage />} />
              <Route path="/org" element={<OrgPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/file" element={<FilePage />} />
              <Route path="/talk" element={<TalkPage />} />
              {import.meta.env.DEV && <Route path="/redesign" element={<RedesignPage />} />}
            </Routes>
          </Suspense>
        </ClientProviders>
      </BrowserRouter>
    </AppErrorBoundary>
  )
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
createRoot(rootEl).render(<App />)
