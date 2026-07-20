# TODO Ledger

This is the authoritative active Cuttlefish backlog for this checkout. Closed
defects and completed TODOs are retained, with their evidence, in
[TODO_HISTORY.md](TODO_HISTORY.md); they do not remain in this active table.

| ID | Status | Priority | Area | Item | Source | Opened | Last Evidence | Exit Criteria |
|---|---|---|---|---|---|---|---|---|
| ARC-CUT-002 | needs-verification | P2 | architecture | The streaming/watchdog pipeline remains intentionally contiguous after preflight extraction. Its remaining size is an architecture follow-up, not a confirmed behavior defect. | `packages/cuttlefish/src/gateway/run-web-session.ts`; `packages/cuttlefish/src/gateway/web-session-preflight.ts` | 2026-06-29 | 2026-07-20 source review; focused stall-policy regression passed in the repair campaign | Complete a separately scoped extraction only if a stable domain boundary and focused regression coverage are identified; otherwise close as intentionally retained architecture. |
| FLEETVIEW-2607-001 | open | P3 | product-backlog | Workers DataView has saved local views; URL-serialized views, broad browser/WCAG coverage, and richer inspector/presence/delegation UX remain product work. | `packages/web/src/routes/orchestration/page.tsx`; `packages/web/src/components/data-view/` | 2026-07-10 | 2026-07-20 source review | Deliver and validate each separately scoped product capability, or explicitly defer it in product planning. |
| TST-CUT-003 | open | P2 | test-reliability | WeeklySchedule's configured-timezone assertion is currently failing in the observed local test runtime: it expects `4a` for a Monday 23:30 America/New_York job but the grid renders `11p` and reports `America/New_York` despite the test's UTC mock. | `packages/web/src/components/crons/__tests__/weekly-schedule.test.tsx:37`; local focused test run | 2026-07-20 | 2026-07-20: the combined route/WeeklySchedule run had 3 passed and 1 failed; the WeeklySchedule file had 2 passed and 1 failed. | Make the timezone fixture deterministic across supported Node 24 and local runtime, then pass the focused test and root `pnpm test`. |
