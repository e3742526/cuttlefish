import React from 'react'
import { PageLayout } from '@/components/page-layout'

export class ChatErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ChatErrorBoundary]', error.message, '\nComponent stack:', info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <PageLayout>
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <p className="text-lg font-semibold text-[var(--system-red)]">Chat crashed</p>
            <pre className="max-w-lg overflow-auto rounded-lg bg-[var(--bg-tertiary)] p-4 text-left text-xs text-muted-foreground">
              {this.state.error.message}{'\n'}{this.state.error.stack?.split('\n').slice(0, 5).join('\n')}
            </pre>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload() }}
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)]"
            >
              Reload
            </button>
          </div>
        </PageLayout>
      )
    }
    return this.props.children
  }
}
