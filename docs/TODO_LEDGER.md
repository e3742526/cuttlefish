# TODO Ledger

This is the authoritative active Cuttlefish backlog for this checkout. Closed
defects and completed TODOs are retained, with their evidence, in
[TODO_HISTORY.md](TODO_HISTORY.md); they do not remain in this active table.

| ID | Status | Priority | Area | Item | Source | Opened | Last Evidence | Exit Criteria |
|---|---|---|---|---|---|---|---|---|
| FLEETVIEW-2607-001 | open | P3 | product-backlog | Workers DataView has saved local views; URL-serialized views, broad browser/WCAG coverage, and richer inspector/presence/delegation UX remain product work. | `packages/web/src/routes/orchestration/page.tsx`; `packages/web/src/components/data-view/` | 2026-07-10 | 2026-07-20 source review | Deliver and validate each separately scoped product capability, or explicitly defer it in product planning. |
| SB-CUT-001 | needs-decision | P3 | frontend-ux | The chat sidebar's three view modes (Rooms/Focused/All) each use a distinct grouping/hierarchy path for the same session data. Two prior ledger entries (0028, 0075) already changed that grouping structure in different directions, and the operator's 2026-07-20 "still confusing" feedback suggests the mode split itself may be part of the confusion, not just the status-legibility bugs repaired in ledger 0077. | `packages/web/src/components/chat/chat-sidebar.tsx`; `packages/web/src/components/chat/sidebar-view-model.ts`; `.giles/feature-ledger/giles-ledger-0028-chat-rooms-sidebar-restore.md`; `.giles/feature-ledger/giles-ledger-0075-agent-grouped-chat-sidebar-20260720.md`; `.giles/feature-ledger/giles-ledger-0077-sidebar-attention-legibility-20260720.md` | 2026-07-20 | 2026-07-20: deliberately deferred rather than guessed at a third time without direction. | Get explicit operator direction on whether to keep three modes, consolidate to fewer (e.g. one default view plus filter chips), or leave as-is; implement only the chosen direction and validate with sidebar view-model/UI tests. |
