# Log Archive Index

## Policy

Raw audit and session logs are local-only artifacts in this repository. They live
under `docs/audits/` and `docs/logs/`, but those trees are git-ignored by policy
to avoid publishing machine-local agent run details.

Inherited upstream-era tracked summaries have been removed from this fork. New
Cuttlefish audit and session artifacts should be written under the ignored local
trees unless a maintainer explicitly promotes a curated summary.

## Local Raw Sources

Current local-only source paths:

- Session details: `docs/logs/session/062026/`
- Session details: `docs/logs/session/072026/`
- Audit details: `docs/audits/` and `docs/audits/062026/`
- Audit details: `docs/audits/072026/`
- Giles generated compliance logs: `governance/logs/`
- Runtime logs: `logs/`

## Traceability Notes

- Summaries reference source paths, not copied raw content.
- A fresh checkout may not contain raw local detail files.
- If a raw log becomes important for public context, publish a curated summary or
  explicitly move that one log into a tracked docs location with maintainer
  approval.
- The 2026-07-20 live-playtest repair and documentation-stewardship records are
  indexed from `docs/INDEX.md`; their local detail remains intentionally
  untracked.
