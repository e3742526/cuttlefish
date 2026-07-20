# Structure & Convention Compliance

- Governing authority: Giles conventions as constrained by the repository contract.
- Authority sources: `AGENTS.md` retention blocks, `.gitignore`,
  `docs/INDEX.md`, `.giles/audit_report.yaml` and
  `.giles/compliance_status.yaml` (both generated 2026-07-10).
- Summary: 1 compliant / 3 drift / 0 violations — Tier A: 0, Tier B: 2, Tier C: 1.

The latest available Giles sidecar reports 75 open findings and five blocking
actions. It is advisory and has not been refreshed in this documentation-only
pass; none of its findings is claimed resolved here.

| ID | Rule / giles code | Location | Status | Severity | Tier | Recommended action | Authority needed |
|---|---|---|---|---|---|---|---|
| STRUCT-20260720-001 | Raw-detail retention | `docs/audits/`, `docs/logs/` | compliant | low | A | Keep raw session and audit records local-only, as required by the repository contract. | none |
| STRUCT-20260720-002 | `GAUD-002`, `GAUD-003` | `docs/audits/072026`, `.gitignore` | drift | info | B | Decide whether to adopt Giles tracked audit summaries and refresh its managed ignore block as one governed change. | maintainer approval for `AGENTS.md` / `.gitignore` / Giles policy |
| STRUCT-20260720-003 | `GSESS-005`, `GSESS-008` | `docs/logs/session/` | drift | info | B | Decide whether monthly session summaries should be tracked; the current contract intentionally ignores the entire tree. | maintainer approval for `AGENTS.md` / `.gitignore` / Giles policy |
| STRUCT-20260720-004 | Historical document volume | `docs/plans/`, `docs/superpowers/` | drift | low | C | Scope an archive/indexing review; do not consolidate or delete historical records in this pass. | dedicated documentation follow-up |

## Tier B — routed (recommended diff + approval path)

- Finding: Giles' audit/session-summary convention conflicts with the repository's
  explicit local-only retention rule.
  - Recommended change: If the team elects Giles summaries, narrow the ignore
    rules to raw detail buckets and add tracked `MMYYYY-*-summary.md` records;
    otherwise record an explicit governed exception in the Giles path.
  - Approval path: maintainer approval followed by a single governed change to
    `AGENTS.md`, `.gitignore`, `docs/INDEX.md`, and the applicable Giles
    convention.

## Tier C — significant re-work (scoped follow-up)

- Finding: historical plan/spec archives are numerous and intentionally preserved.
  - Recommended follow-up: audit the archives for a curated public narrative and
    an explicit retention/indexing policy.
  - Impact estimate (files / risk / owning skill): many historical documents;
    provenance and link-breakage risk; `governance-doc-stewardship` with a
    dedicated archival scope.

## Notes

- Routed to `governance-repo-cleaning` (whole-tree hygiene): none in this
  documentation-only pass.
- Giles findings reconciled: `GAUD-002`, `GAUD-003`, and the tracked-summary
  convention were recorded as routed drift. `GDOC-023`, `GDIA-003..005`, and
  `GFL-002..004` remain in the generated sidecar and are not suppressed or
  declared resolved.
