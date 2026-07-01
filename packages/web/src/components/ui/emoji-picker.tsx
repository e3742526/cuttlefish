import { useState, useMemo, useRef, useEffect } from "react"
import { EMOJI_POOL } from "@/lib/emoji-pool"
import { OCEAN_AVATARS } from "@/lib/ocean-avatar-pool"

interface EmojiPickerProps {
  current: string
  onSelect: (emoji: string) => void
  /** Called with a URL string when the user sets an external image. */
  onSelectImage?: (url: string) => void
  onClose: () => void
}

interface EmojiEntry {
  emoji: string
  keywords: string[]
}

export function EmojiPicker({ current, onSelect, onSelectImage, onClose }: EmojiPickerProps) {
  const [search, setSearch] = useState("")
  const [emojis, setEmojis] = useState<EmojiEntry[] | null>(null)
  const [urlInput, setUrlInput] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Lazy-load emojilib only when picker is open
  useEffect(() => {
    let cancelled = false
    import("emojilib").then((mod) => {
      if (cancelled) return
      const data = (mod.default ?? mod) as Record<string, string[]>
      const list = Object.entries(data).map(([emoji, keywords]) => ({ emoji, keywords }))
      setEmojis(list)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [onClose])

  const q = search.toLowerCase().trim()

  // Ocean icon search results
  const oceanResults = useMemo(() => {
    if (!q) return null
    return OCEAN_AVATARS.filter((a) =>
      a.keywords.some((kw) => kw.includes(q)) || a.label.toLowerCase().includes(q) || a.id.includes(q)
    )
  }, [q])

  // Emoji search results
  const emojiResults = useMemo(() => {
    if (!q) return null
    const results: Array<{ emoji: string; label: string }> = []
    for (const entry of (emojis ?? [])) {
      if (entry.keywords.some((kw) => kw.includes(q))) {
        results.push({ emoji: entry.emoji, label: entry.keywords[0] })
        if (results.length >= 80) break
      }
    }
    return results
  }, [q, emojis])

  const isSearching = q.length > 0

  return (
    <div
      ref={containerRef}
      className="absolute top-full left-0 z-50 mt-2 rounded-[var(--radius-lg,16px)] border border-[var(--separator)] bg-[var(--material-thick)] p-3 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
      style={{ width: 320 }}
    >
      <input
        ref={inputRef}
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search icons (cuttlefish, anchor, shark...)"
        className="mb-2 w-full rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
      />

      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {!isSearching ? (
          /* ── Default view: ocean icons first, then emoji pool ── */
          <>
            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-1.5">
              Ocean Icons
            </p>
            <div className="grid grid-cols-8 gap-1 mb-3">
              {OCEAN_AVATARS.map((a) => {
                const value = `${a.kind}:${a.id}`
                const isSelected = current === value
                return (
                  <button
                    key={value}
                    title={a.label}
                    onClick={() => onSelect(value)}
                    className={`flex items-center justify-center rounded-[var(--radius-md,12px)] p-1 transition-colors ${isSelected ? "bg-[var(--accent-fill)] border border-[var(--accent)]" : "bg-transparent border border-transparent hover:bg-[var(--fill-secondary)]"}`}
                  >
                    <img src={a.path} alt={a.label} width={28} height={28} draggable={false} style={{ display: "block" }} />
                  </button>
                )
              })}
            </div>

            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-1.5">
              Emoji
            </p>
            <div className="grid grid-cols-8 gap-1">
              {EMOJI_POOL.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => onSelect(emoji)}
                  className={`flex items-center justify-center rounded-[var(--radius-md,12px)] p-1.5 text-xl transition-colors ${emoji === current ? "bg-[var(--accent-fill)] border border-[var(--accent)]" : "bg-transparent border border-transparent hover:bg-[var(--fill-secondary)]"}`}
                >
                  {emoji}
                </button>
              ))}
            </div>

            {onSelectImage && (
              <>
                <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mt-3 mb-1.5">
                  External Image URL
                </p>
                <div className="flex gap-1.5">
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="https://example.com/avatar.png"
                    className="flex-1 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-1.5 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && urlInput.trim()) {
                        onSelectImage(urlInput.trim())
                        onClose()
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={!urlInput.trim()}
                    onClick={() => { if (urlInput.trim()) { onSelectImage(urlInput.trim()); onClose() } }}
                    className="rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] px-3 py-1.5 text-xs font-[var(--weight-semibold)] disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                  >
                    Set
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          /* ── Search view: ocean icons + emojis ── */
          <>
            {/* Ocean icon results */}
            {oceanResults && oceanResults.length > 0 && (
              <>
                <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-1.5">
                  Ocean Icons ({oceanResults.length})
                </p>
                <div className="grid grid-cols-8 gap-1 mb-3">
                  {oceanResults.map((a) => {
                    const value = `${a.kind}:${a.id}`
                    const isSelected = current === value
                    return (
                      <button
                        key={value}
                        title={a.label}
                        onClick={() => onSelect(value)}
                        className={`flex items-center justify-center rounded-[var(--radius-md,12px)] p-1 transition-colors ${isSelected ? "bg-[var(--accent-fill)] border border-[var(--accent)]" : "bg-transparent border border-transparent hover:bg-[var(--fill-secondary)]"}`}
                      >
                        <img src={a.path} alt={a.label} width={28} height={28} draggable={false} style={{ display: "block" }} />
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            {/* Emoji results */}
            {emojis === null ? (
              <div className="grid grid-cols-8 gap-1 opacity-30">
                {Array.from({ length: 16 }).map((_, i) => (
                  <div key={i} className="h-9 rounded-[var(--radius-md,12px)] bg-[var(--fill-secondary)]" />
                ))}
              </div>
            ) : emojiResults && emojiResults.length > 0 ? (
              <>
                <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-1.5">
                  Emoji ({emojiResults.length >= 80 ? "80+" : emojiResults.length})
                </p>
                <div className="grid grid-cols-8 gap-1">
                  {emojiResults.map((e) => (
                    <button
                      key={e.emoji}
                      onClick={() => onSelect(e.emoji)}
                      title={e.label}
                      className={`flex items-center justify-center rounded-[var(--radius-md,12px)] p-1.5 text-xl transition-colors ${e.emoji === current ? "bg-[var(--accent-fill)] border border-[var(--accent)]" : "bg-transparent border border-transparent hover:bg-[var(--fill-secondary)]"}`}
                    >
                      {e.emoji}
                    </button>
                  ))}
                </div>
              </>
            ) : oceanResults && oceanResults.length === 0 ? (
              <p className="py-4 text-center text-xs text-[var(--text-tertiary)]">
                No icons found for &ldquo;{search}&rdquo;
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
