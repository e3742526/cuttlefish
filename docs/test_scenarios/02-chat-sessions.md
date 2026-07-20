# 02 — Chat Workspace and Sessions

The `/` chat workspace is the core value proposition: send a message, watch
an engine work, get a result, keep the conversation. These scenarios cover
the primary happy path and the seams around it — invalid input, engine
switching, persistence, interruption, archive, and failure states. (Scroll
mechanics are already covered by `e2e/scroll.spec.ts` and are out of scope
here.)

---

### CH-01 — First message to first response (primary happy path)
- Goal: reach the core value proposition: one message in, one useful engine response out.
- Category: happy path
- Preconditions: gateway running; a signed-in engine selected.
- Steps:
  1. Open `/`, type a small concrete prompt ("list the files in your working directory"), send.
  2. Watch the live stream; wait for completion.
- Expected: the message appears immediately; streaming output renders progressively; the session reaches a completed state; the response is from the selected engine/model.
- Observe: is it clear *which* employee/engine/model answered? Does the session get a sensible title/identity in the session list?
- Variations: send a follow-up in the same session and confirm the engine has the prior context; open a second, parallel session and confirm the two don't bleed into each other.

### CH-02 — Composer input seams
- Goal: the composer tolerates realistic messy input.
- Category: invalid input / boundary
- Preconditions: an open session.
- Steps / Variations (each is a send attempt):
  1. Empty message; whitespace-only message.
  2. Very long message (thousands of characters, e.g. a pasted log file).
  3. Emoji, accented text, non-Latin scripts (`日本語`, `العربية`), RTL text.
  4. Markdown-ish and HTML-ish text (`<script>alert(1)</script>`, backticks, `# heading`) — rendering check, not an exploit attempt.
  5. Multi-line input with newlines; paste with trailing whitespace.
  6. Rapid double-press of send on the same text.
- Expected: empty/whitespace sends are prevented or harmless; long input neither freezes the composer nor truncates silently; unicode round-trips into history intact; markup renders inert as text; double-send does not duplicate the message or fork the run.

### CH-03 — Engine/model/effort switching mid-stream of life
- Goal: the picker's promises hold: per-session engine + model + effort selection.
- Category: settings / navigation
- Preconditions: two or more signed-in engines (or one engine with multiple models).
- Steps:
  1. Start a session on engine A; get a response.
  2. Switch the session (or start a new one) to engine B / another model / another effort tier; send again.
  3. Check the model alias display (session model alias expansion is a listed feature) against what the engine actually ran.
- Expected: the switch is honored on the next run; the UI never claims model X while running model Y; effort tiers only appear for engines that support them (per the README engine table).
- Variations: pick an engine whose binary was uninstalled after boot — it should be hidden or fail legibly, not sit selectable-but-broken.

### CH-04 — Interrupt a running session
- Goal: stop/cancel mid-run behaves like a user expects.
- Category: interruption
- Preconditions: a session running a deliberately long task ("count to 500 slowly, narrating each step").
- Steps:
  1. Trigger the stop/cancel control mid-stream.
  2. Observe the session state; then send a new message in the same session.
- Expected: streaming halts promptly; the session lands in a clear stopped state (not "running" forever, not an error blaming the user); the session remains usable afterward.
- Variations: navigate to another route mid-stream and come back (stream should survive or visibly resume); close the browser tab mid-stream, reopen, and check the session's state honesty; stop the same run twice quickly.

### CH-05 — Session persistence across daemon restart
- Goal: sessions are truly persisted, not just in memory.
- Category: persistence / relaunch
- Preconditions: several sessions with history, at least one with an uploaded file/attachment.
- Steps:
  1. `pnpm cuttlefish restart`.
  2. Reload the dashboard; open each prior session.
- Expected: session list, ordering, titles, full message history, and attachments all survive; no duplicate or ghost sessions appear.
- Observe: timestamps still correct (no re-stamping to "now"); a session that was mid-run at restart shows an honest terminal state.

### CH-06 — Archive, delete, and the road back
- Goal: destructive session actions are reversible where promised and honest where not.
- Category: delete-undo / persistence
- Preconditions: at least three sessions, one disposable.
- Steps:
  1. Archive a session; confirm it leaves the active list and appears under `/archive`.
  2. From `/archive`, restore it (if supported) or open it read-only; verify content integrity.
  3. Delete a disposable session; search/scan lists for it afterward.
  4. Restart the daemon; re-check both.
- Expected: archived sessions are browsable per the `/archive` route's purpose; deleted sessions stay deleted after restart; no orphaned references (e.g. a kanban ticket or approval pointing at the deleted session should degrade gracefully).
- Variations: archive the *currently open* session — where does the UI take you? Delete then immediately hit browser Back to the dead session's URL.

### CH-07 — Engine process dies mid-run
- Goal: verify the agent-process-crash status surface (a listed feature) from the user's seat.
- Category: recovery / error clarity
- Preconditions: a session actively running; shell access to find the engine child process.
- Steps:
  1. Start a long-running task; `kill -9` the engine CLI child process (not the gateway).
  2. Watch the session in the dashboard.
- Expected: the session transitions to a crashed/failed status visible in the UI with enough information to retry; the gateway itself stays healthy; other concurrent sessions are unaffected.
- Variations: retry/continue the crashed session — does it resume or start clean, and does the UI say which?

### CH-08 — Rate limit and engine-unavailable fallback
- Goal: the documented rate-limit/fallback handling is legible in practice.
- Category: recovery / error clarity
- Preconditions: hard to trigger deterministically — run opportunistically when a real limit occurs, or use the smallest-quota engine available. Otherwise record as Not executed with reason.
- Steps: drive sessions until the engine reports a rate limit; watch `/limits` and the session.
- Expected: the session surfaces the limit (not a generic failure); `/limits` reflects reality; if a fallback behavior is configured, the handoff is visible to the user rather than a silent engine swap.

### CH-09 — File attached to a conversation round-trips
- Goal: run-resource attachments work from the user's perspective.
- Category: files
- Preconditions: an open session; small test files (a `.txt`, a `.png`, a `.zip`; plus an empty file and a wrongly-extensioned file — a text file renamed `.png`).
- Steps:
  1. Attach the `.txt` and ask the engine to summarize it; confirm the engine actually saw the content.
  2. View the uploaded file via `/file`.
  3. Repeat with the edge files.
- Expected: valid files upload, are readable by the engine, and are viewable/downloadable afterward; empty and mismatched files fail politely or are handled, never crashing the composer; files remain attached after daemon restart (overlaps CH-05).
