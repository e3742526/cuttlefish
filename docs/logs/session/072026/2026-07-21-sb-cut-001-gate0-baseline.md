# 2026-07-21 — SB-CUT-001 Gate 0 Baseline Session Log

## Scope
Gate 0 only for SB-CUT-001, the Project/Session Collaboration Prototype. No product implementation was started because the first gate requires baseline capture and protected behavior validation before feature work.

## Baseline worktree state
`git status --short` was clean for tracked files before this record was written. The repository ignores `.giles/`, `docs/audits/`, and `docs/logs/`, so local sidecar/log artifacts may exist without appearing in ordinary status output.

## Protected behavior areas to characterize
- Existing `POST /api/sessions/:id/message` continuation, queueing, interruption, attachments, waiting-session behavior, authority parsing, and engine selection.
- Manager delegation, manager synthesis barriers, child callbacks, background-drain delayed callbacks, and leader acknowledgement.
- Cross-request requester/provider/parent attribution.
- Scoped authorization, scoped-token boundaries, and operator delegation.
- Backend Talk graph/delegate/attachment/callback/auth routing, while the frontend `/talk` retirement remains deferred to Gate 6.
- Existing chat/sidebar/nav behavior before replacing Rooms/Focused/All.

## Validation evidence
- `pnpm typecheck` passed.
- Focused backend communication test invocation was attempted, but it expanded into many suites and surfaced baseline failures before interruption. This is failed/inconclusive evidence, not a passing gate result.
- Focused web chat/sidebar/nav test invocation was attempted, produced no completed result in the observation window, and was interrupted. This is inconclusive evidence, not a passing gate result.

## Risk and defect ledger
- Gate 0 is not fully passed: backend and web baseline suites require completed, reliable results before implementation gates advance.
- Several candidate files are already above 800 lines and must be split rather than extended if touched for this feature.
- No implementation, migration, route, or UI changes were made in this Gate 0 record.

## Next safe step
Establish precise targeted test commands for the protected backend and web baselines, capture either clean pass evidence or exact pre-existing failures, then begin Gate 1 characterization tests without changing router or UI behavior.
