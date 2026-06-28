import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Message } from '@/lib/conversations'
import { useStickToBottom } from '@/hooks/use-stick-to-bottom'
import { stopMessageTts } from './use-message-tts'
import { groupMessages, findActiveToolGroupStart } from './chat-message-groups'
import { ToolGroup } from './tool-group'
import { MessageRow } from './message-row'
import { formatTimestamp, shouldShowTimestamp } from './message-time'
import { StreamingBubble } from './streaming-bubble'
import { ChatMessagesStyles } from './chat-messages-styles'

export { isFilePath, parseFenceLang } from './message-markdown'
export { USER_COLLAPSE_PX, USER_COLLAPSE_SLACK, shouldCollapse } from './collapsible-user-text'

const VIRTUALIZE_MESSAGES_THRESHOLD = 40

/* ── Tool grouping ──────────────────────────────────────── */

/* ── Component ──────────────────────────────────────────── */

interface ChatMessagesProps {
  messages: Message[]
  loading: boolean
  streamingText?: string
  /** Resend a prior user message (assistant action-row "retry"). */
  onRetry?: (text: string) => void
}

export function ChatMessages({ messages, loading, streamingText, onRetry }: ChatMessagesProps) {
  // Stick-to-bottom: one hook owns follow-intent, growth-follow, resize/keyboard,
  // tab-return, mount-snap, and the jump affordance. See use-stick-to-bottom.ts.
  const { containerRef, showJump, unreadCount, scrollToBottom } = useStickToBottom({
    streamingText,
    messageCount: messages.length,
  })
  const scrollElementRef = useRef<HTMLDivElement | null>(null)
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    scrollElementRef.current = node
    containerRef(node)
  }, [containerRef])

  // Memoize grouped messages to avoid re-running on streaming-only re-renders
  const groupedMessages = useMemo(() => groupMessages(messages), [messages])
  const activeToolGroupStart = useMemo(
    () => findActiveToolGroupStart(groupedMessages, loading),
    [groupedMessages, loading],
  )
  const shouldVirtualize = groupedMessages.length >= VIRTUALIZE_MESSAGES_THRESHOLD
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? groupedMessages.length : 0,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 180,
    overscan: 6,
    enabled: shouldVirtualize,
  })

  // Stop any in-progress read-aloud when the chat view unmounts (navigation away).
  useEffect(() => () => stopMessageTts(), [])

  if (messages.length === 0 && !loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
            Start a conversation
          </div>
          <div className="text-[length:var(--text-footnote)] text-[var(--text-quaternary)] mt-[var(--space-2)]">
            Send a message or use /new to begin
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={setContainerRef} style={{ overflowAnchor: 'auto' }} className="chat-messages-scroll relative flex-1 overflow-y-auto overflow-x-hidden bg-[var(--bg)] min-h-0">
      <div
        className="mx-auto w-full max-w-[var(--chat-measure)] pt-[72px] pb-[var(--space-6)] lg:pt-[88px]"
        style={shouldVirtualize ? { height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' } : undefined}
      >
        {(shouldVirtualize
          ? rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const item = groupedMessages[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderGroupedMessage(item)}
                </div>
              )
            })
          : groupedMessages.map(renderGroupedMessage))}

        {/* Streaming message — shows text as it arrives, always re-renders */}
        {streamingText && <StreamingBubble streamingText={streamingText} />}

        {/* Running indicator — pre-first-token only; once streamingText arrives the
            caret carries the "live" signal, so suppress this to avoid a double cue. */}
        {loading && messages.length > 0 && !streamingText && (
          // Share the assistant text gutter (space-3 mobile / space-8 @lg) so the
          // indicator lines up flush with the messages and tool cards.
          <div className="assistant-msg-row flex items-center gap-1.5 mt-[var(--space-1)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-[cuttlefish-pulse_1.4s_infinite] shrink-0" />
            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)]">
              Thinking
            </span>
          </div>
        )}

      </div>

      {/* Jump-to-latest — borderless (soft material + shadow, no hairline), with an
          optional unread count. Shown only when the user has scrolled away. */}
      {showJump && (
        <button
          onClick={() => scrollToBottom('smooth')}
          aria-label="Jump to latest"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 py-1.5 pl-3 pr-3.5 rounded-full bg-[var(--material-thick)] text-[var(--text-secondary)] text-[length:var(--text-caption1)] font-[var(--weight-medium)] shadow-[var(--shadow-card)] backdrop-blur-md cursor-pointer transition-opacity duration-150 hover:bg-[var(--fill-secondary)]"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {unreadCount > 0 ? `${unreadCount} new message${unreadCount > 1 ? 's' : ''}` : 'Jump to latest'}
        </button>
      )}

      <ChatMessagesStyles />
    </div>
  )

  function renderGroupedMessage(item: ReturnType<typeof groupMessages>[number]) {
    if (item.kind === 'tool-group') {
      const firstMsg = item.msgs[0]
      const showTimestamp = shouldShowTimestamp(messages, item.startIndex)
      const prevMsg = item.startIndex > 0 ? messages[item.startIndex - 1] : null
      const isActive = item.startIndex === activeToolGroupStart
      return (
        <div key={`tg-${item.startIndex}`}>
          {showTimestamp && (
            <div className="text-center py-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
              {formatTimestamp(firstMsg.timestamp)}
            </div>
          )}
          {!showTimestamp && prevMsg && (
            <div className={prevMsg.role !== 'assistant' ? 'h-[var(--space-4)]' : 'h-[var(--space-1)]'} />
          )}
          <ToolGroup msgs={item.msgs} isActive={isActive} />
        </div>
      )
    }

    const { msg, index: i } = item
    return (
      <MessageRow
        key={msg.id || i}
        msg={msg}
        index={i}
        messages={messages}
        loading={loading}
        onRetry={onRetry}
      />
    )
  }
}
