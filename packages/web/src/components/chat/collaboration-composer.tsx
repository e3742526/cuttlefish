import { useMemo, useRef, useState } from "react"
import { Check, Send, ShieldCheck, Users, X } from "lucide-react"
import type { CollaborationSendRequest, ManagementRecipient, OperatorDelegationScope } from "@cuttlefish/contracts"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface RecipientOption {
  id: string
  displayName: string
  active?: boolean
}

const AUTHORITY_SCOPES: OperatorDelegationScope[] = ["approve", "decide", "plan", "act"]

export function CollaborationComposer({
  lane,
  recipients,
  defaultRecipientId,
  projectRootSessionId,
  disabled,
  onSend,
}: {
  lane: "team" | "management"
  recipients: RecipientOption[] | ManagementRecipient[]
  defaultRecipientId?: string
  projectRootSessionId?: string | null
  disabled?: boolean
  onSend: (request: CollaborationSendRequest) => Promise<void>
}) {
  const [message, setMessage] = useState("")
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [recipientMode, setRecipientMode] = useState<"all" | null>(null)
  const [confirmedAll, setConfirmedAll] = useState<string[]>([])
  const [scopes, setScopes] = useState<OperatorDelegationScope[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [allDialogOpen, setAllDialogOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const activeRecipients = useMemo(() => recipients.filter((recipient) => recipient.active !== false), [recipients])
  const mentionMatch = /@([\w-]*)$/.exec(message)
  const mentionQuery = mentionMatch?.[1]?.toLowerCase() ?? null
  const suggestions = mentionQuery === null ? [] : [
    { id: "@all", displayName: "All active recipients" },
    ...activeRecipients,
  ].filter((recipient) => recipient.id.toLowerCase().includes(mentionQuery) || recipient.displayName.toLowerCase().includes(mentionQuery))
  const authorityEligible = lane === "management"
    && recipientMode !== "all"
    && selectedIds.length === 1
    && (selectedIds[0] === "cuttlefish" || selectedIds[0] === "program-manager")

  function replaceMention(label: string) {
    if (!mentionMatch) return
    setMessage(`${message.slice(0, mentionMatch.index)}@${label} `)
  }

  function selectRecipient(recipient: RecipientOption) {
    if (recipient.id === "@all") {
      setAllDialogOpen(true)
      return
    }
    setRecipientMode(null)
    setConfirmedAll([])
    setSelectedIds((current) => current.includes(recipient.id) ? current : [...current, recipient.id])
    replaceMention(recipient.id)
    setActiveSuggestion(0)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  async function submit() {
    const trimmed = message.trim()
    if (!trimmed) return
    if (lane === "team" && recipientMode !== "all" && selectedIds.length === 0) {
      setError("Choose at least one project participant or @all.")
      return
    }
    setSending(true)
    setError(null)
    try {
      await onSend({
        message: trimmed,
        ...(recipientMode === "all" ? { recipientMode: "all" as const, confirmAllRecipients: confirmedAll } : {}),
        ...(recipientMode !== "all" && selectedIds.length > 0 ? { recipientIds: selectedIds } : {}),
        ...(projectRootSessionId ? { projectRootSessionId } : {}),
        ...(authorityEligible && scopes.length > 0 ? { operatorDelegationScopes: scopes } : {}),
      })
      setMessage("")
      setSelectedIds([])
      setRecipientMode(null)
      setConfirmedAll([])
      setScopes([])
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Message could not be queued")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-t border-[var(--separator)] bg-[var(--material-thick)] px-3 py-3 sm:px-5">
      <div className="mx-auto max-w-4xl rounded-[20px] border border-[var(--separator)] bg-[var(--bg-secondary)] p-3 shadow-[var(--shadow-card)]">
        <div className="mb-2 flex min-h-7 flex-wrap items-center gap-1.5" aria-label="Selected recipients">
          {recipientMode === "all" ? (
            <RecipientChip label={`All (${confirmedAll.length})`} onRemove={() => { setRecipientMode(null); setConfirmedAll([]) }} />
          ) : selectedIds.map((id) => (
            <RecipientChip
              key={id}
              label={activeRecipients.find((recipient) => recipient.id === id)?.displayName ?? id}
              onRemove={() => setSelectedIds((current) => current.filter((value) => value !== id))}
            />
          ))}
          {lane === "management" && recipientMode !== "all" && selectedIds.length === 0 ? (
            <span className="text-xs text-[var(--text-tertiary)]">
              Default: {activeRecipients.find((recipient) => recipient.id === defaultRecipientId)?.displayName ?? "Program Manager → Cuttlefish"}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => { setMessage((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@`); textareaRef.current?.focus() }}
            className="rounded-full px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--fill-secondary)]"
          >
            Add recipient
          </button>
        </div>

        <div className="relative">
          <textarea
            id="collaboration-textarea"
            ref={textareaRef}
            value={message}
            onChange={(event) => { setMessage(event.target.value); setActiveSuggestion(0); setError(null) }}
            onKeyDown={(event) => {
              if (suggestions.length > 0 && event.key === "ArrowDown") {
                event.preventDefault()
                setActiveSuggestion((current) => (current + 1) % suggestions.length)
              } else if (suggestions.length > 0 && event.key === "ArrowUp") {
                event.preventDefault()
                setActiveSuggestion((current) => (current - 1 + suggestions.length) % suggestions.length)
              } else if (suggestions.length > 0 && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                event.preventDefault()
                selectRecipient(suggestions[activeSuggestion])
              } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
            rows={2}
            disabled={disabled || sending}
            placeholder={lane === "team" ? "Message project participants… Use @ to choose recipients" : "Message management… Leave unaddressed for default routing"}
            aria-label={lane === "team" ? "Team message" : "Management message"}
            aria-controls={suggestions.length > 0 ? "collaboration-recipient-options" : undefined}
            aria-activedescendant={suggestions.length > 0 ? `collaboration-recipient-${activeSuggestion}` : undefined}
            className="min-h-[54px] w-full resize-none bg-transparent pr-12 text-sm leading-6 text-foreground outline-none placeholder:text-[var(--text-tertiary)]"
          />
          {suggestions.length > 0 ? (
            <div id="collaboration-recipient-options" role="listbox" className="absolute bottom-full left-0 z-30 mb-2 max-h-64 w-full max-w-sm overflow-auto rounded-xl border border-[var(--separator)] bg-[var(--material-thick)] p-1 shadow-[var(--shadow-overlay)]">
              {suggestions.map((recipient, index) => (
                <button
                  key={recipient.id}
                  id={`collaboration-recipient-${index}`}
                  role="option"
                  aria-selected={index === activeSuggestion}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectRecipient(recipient)}
                  className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", index === activeSuggestion ? "bg-[var(--fill-secondary)]" : "hover:bg-[var(--fill-tertiary)]")}
                >
                  {recipient.id === "@all" ? <Users className="size-4" /> : <span className="size-2 rounded-full bg-[var(--accent)]" />}
                  <span className="min-w-0 flex-1 truncate">{recipient.displayName}</span>
                  <span className="text-xs text-[var(--text-tertiary)]">{recipient.id}</span>
                </button>
              ))}
            </div>
          ) : null}
          <Button
            type="button"
            size="icon"
            onClick={() => void submit()}
            disabled={disabled || sending || !message.trim()}
            aria-label="Send collaboration message"
            className="absolute bottom-1 right-1 rounded-full"
          >
            <Send className="size-4" />
          </Button>
        </div>

        {lane === "management" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--separator)] pt-2">
            <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)]"><ShieldCheck className="size-3.5" /> One-turn authority</span>
            {AUTHORITY_SCOPES.map((scope) => (
              <label key={scope} className={cn("flex items-center gap-1 text-[11px]", !authorityEligible && "opacity-45")}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  disabled={!authorityEligible}
                  onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope] : current.filter((value) => value !== scope))}
                />
                {scope}
              </label>
            ))}
            {!authorityEligible ? <span className="text-[10px] text-[var(--text-tertiary)]">Select exactly COO or Program Manager</span> : null}
          </div>
        ) : null}
        {error ? <p role="alert" className="mt-2 text-xs text-[var(--system-red)]">{error}</p> : null}
      </div>

      <Dialog open={allDialogOpen} onOpenChange={setAllDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Message all active recipients?</DialogTitle>
            <DialogDescription>This queues one turn for each person shown below. Authority scopes cannot be combined with @all.</DialogDescription>
          </DialogHeader>
          <div className="max-h-56 overflow-auto rounded-lg border border-[var(--separator)] p-2">
            {activeRecipients.map((recipient) => (
              <div key={recipient.id} className="flex items-center gap-2 px-2 py-1.5 text-sm"><Check className="size-3.5 text-[var(--accent)]" />{recipient.displayName}<span className="ml-auto text-xs text-[var(--text-tertiary)]">{recipient.id}</span></div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAllDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => {
              const snapshot = activeRecipients.map((recipient) => recipient.id)
              setRecipientMode("all")
              setConfirmedAll(snapshot)
              setSelectedIds([])
              setScopes([])
              replaceMention("all")
              setAllDialogOpen(false)
            }}>Confirm {activeRecipients.length} recipients</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function RecipientChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--fill-secondary)] px-2 py-1 text-xs text-[var(--text-secondary)]">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="rounded-full p-0.5 hover:bg-[var(--fill-primary)]"><X className="size-3" /></button>
    </span>
  )
}
