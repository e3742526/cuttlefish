import React from 'react'
import { MicWaveform } from './mic-waveform'
import type { useStt } from '@/hooks/use-stt'

type SttState = ReturnType<typeof useStt>

interface ChatInputComposerProps {
  disabled: boolean
  loading: boolean
  value: string
  hasContent: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  stt: SttState
  selectorSlot?: React.ReactNode
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onInput: (e: React.FormEvent<HTMLTextAreaElement>) => void
  onFileAttach: (e: React.ChangeEvent<HTMLInputElement>) => void
  onMicPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void
  onMicPointerUp: () => void
  onSubmit: () => void
  onInterrupt?: () => void
}

export function ChatInputComposer({
  disabled,
  loading,
  value,
  hasContent,
  textareaRef,
  fileInputRef,
  stt,
  selectorSlot,
  onChange,
  onKeyDown,
  onPaste,
  onInput,
  onFileAttach,
  onMicPointerDown,
  onMicPointerUp,
  onSubmit,
  onInterrupt,
}: ChatInputComposerProps) {
  const showStop = loading && !!onInterrupt

  return (
    <div
      className="composer-card rounded-[22px] bg-[var(--bg-secondary)] px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-2)] transition-shadow duration-200 ease-in-out"
      style={loading ? { boxShadow: 'var(--shadow-card), 0 0 0 1.5px color-mix(in srgb, var(--accent) 38%, transparent)' } : undefined}
      onPointerDown={(e) => {
        if (disabled) return
        e.preventDefault()
        textareaRef.current?.focus()
      }}
    >
      <textarea
        id="chat-textarea"
        aria-label="Message"
        ref={textareaRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder={disabled ? 'Waiting for response...' : 'Type a message...'}
        rows={1}
        disabled={disabled}
        className={`block w-full bg-transparent border-none outline-none resize-none overflow-y-auto text-[var(--text-primary)] text-[length:var(--text-subheadline)] leading-6 min-h-6 px-1 pt-1 pb-2 m-0 focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)] ${disabled ? 'opacity-50' : 'opacity-100'}`}
        onInput={onInput}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,audio/*,.pdf,.doc,.docx,.txt,.csv,.json,.zip"
        multiple
        className="hidden"
        onChange={onFileAttach}
      />

      <div className="flex items-center gap-[var(--space-2)]">
        <button
          aria-label="Attach file"
          title="Attach file"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => fileInputRef.current?.click()}
          className="w-[36px] h-[36px] shrink-0 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>

        {selectorSlot && (
          <div className="min-w-0 flex items-center overflow-hidden" onPointerDown={(e) => e.stopPropagation()}>
            {selectorSlot}
          </div>
        )}

        <div className="flex-1" />

        {stt.languages.length > 1 && (
          <button
            aria-label={`STT language: ${stt.selectedLanguage.toUpperCase()}. Click to switch.`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={stt.cycleLanguage}
            className="h-7 px-2 shrink-0 rounded-full flex items-center justify-center bg-[var(--fill-tertiary)] border-none cursor-pointer text-[var(--text-secondary)] text-[11px] font-semibold font-[family-name:var(--font-mono)] tracking-[0.5px] uppercase hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] transition-all duration-150 ease-in-out"
            title={`Transcription language: ${stt.selectedLanguage.toUpperCase()}. Click to cycle.`}
          >
            {stt.selectedLanguage}
          </button>
        )}

        <button
          aria-label={stt.state === 'recording' ? 'Stop recording' : stt.state === 'transcribing' ? 'Transcribing…' : 'Voice input'}
          onPointerDown={onMicPointerDown}
          onPointerUp={onMicPointerUp}
          onPointerCancel={onMicPointerUp}
          disabled={stt.state === 'transcribing'}
          className={`w-[36px] h-[36px] shrink-0 flex items-center justify-center border-none transition-all duration-150 ease-in-out touch-none select-none ${stt.state === 'recording' ? 'rounded-full bg-[var(--system-red)] text-white cursor-pointer' : `rounded-full bg-transparent text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] ${stt.state === 'transcribing' ? 'cursor-wait' : 'cursor-pointer'}`}`}
          title={stt.state === 'recording' ? 'Stop recording' : stt.state === 'transcribing' ? 'Transcribing…' : 'Hold to talk · tap to toggle'}
        >
          {stt.state === 'recording' && stt.analyser ? (
            <MicWaveform analyser={stt.analyser} />
          ) : stt.state === 'transcribing' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-[stt-spin_1s_linear_infinite]">
              <path d="M12 2a10 10 0 0 1 10 10" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          )}
        </button>

        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={showStop ? onInterrupt : onSubmit}
          disabled={showStop ? false : (!hasContent || disabled)}
          aria-label={showStop ? 'Stop' : 'Send message'}
          title={showStop ? 'Stop' : 'Send message'}
          className={`relative w-[38px] h-[38px] rounded-full border-none flex items-center justify-center shrink-0 transition-all duration-200 ease-in-out ${
            showStop
              ? 'bg-[var(--system-red)] text-white cursor-pointer'
              : hasContent
                ? 'text-[var(--accent-contrast)] cursor-pointer'
                : 'bg-[var(--fill-tertiary)] text-[var(--text-quaternary)] cursor-default'
          }`}
          // Reef's --accent-bg is a gradient, so the active-send fill + glow are set
          // inline (a Tailwind bg-[var()] arbitrary class can't render a gradient value).
          style={!showStop && hasContent ? { background: 'var(--accent-bg)', boxShadow: 'var(--accent-glow)' } : undefined}
        >
          <span className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ease-in-out ${showStop ? 'opacity-0 scale-50' : 'opacity-100 scale-100'}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </span>
          <span className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ease-in-out ${showStop ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </span>
        </button>
      </div>
    </div>
  )
}
