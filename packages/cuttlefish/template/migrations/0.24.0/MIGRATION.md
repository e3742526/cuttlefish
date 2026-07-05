# Migration: 0.24.0 (HR / Org Steward)

## Summary

Adds the **HR Manager / Org Steward** — a governed config steward that critiques
every proposed org change before it takes effect and offers a deeper interactive
review when chatted with directly. Hiring and other org mutations can now flow
through reviewable **change requests** with before/after YAML diffs, an HR
critique, a risk tier, and a human-approval gate, instead of silent YAML edits.

## Template files changed

- `org/personnel/hr-manager.yaml` — **new** seed employee (the HR / Org Steward).
  Rank `manager`, reports to the COO/root by default, persona encodes the steward
  invariants (bus-not-brain, never self-modify, minimal tool grants, no invented
  engines/models, prefer narrow agents, keep the org acyclic, check for
  redundancy).
- `skills/management/SKILL.md` — hiring / firing / promotion now route through HR
  review via `POST /api/org/change-requests` rather than writing YAML directly.
- `CLAUDE.md` — new "Org changes flow through HR" notes + the
  `/api/org/change-requests` API rows.

## Version bump

Update `cuttlefish.version` in `config.yaml` to `"0.24.0"`.

## New files in `~/.cuttlefish/`

Created lazily by the gateway; no manual action required:

- `org/_changes/` — OrgChangeRequest JSON files (the change-request store).
- `org/_drafts/` — draft personas proposed but not yet activated.
- `org/_retired/` — soft-retired personas (moved here instead of hard-deleted).
- `org/_policy.json` — optional operator override of the change permission tiers.

These directories are excluded from the active employee scan, so nothing in them
is ever loaded as an employee.

## New API routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/org/validate` | POST | Dry-run validate a proposed change `{changeType, employeeName, proposed}` |
| `/api/org/change-requests` | GET / POST | List / create org change requests |
| `/api/org/change-requests/:id` | GET | Fetch a single change request |

## Employee YAML changes

New optional field (added in this release; defaults to `active`):

| Field | Type | Description |
|-------|------|-------------|
| `lifecycle` | `draft \| active \| probation \| disabled \| retired` | Lifecycle state. `disabled`/`retired` employees are non-assignable; `retired` personas live under `org/_retired/`. |

## Manual steps for existing installs

1. Copy `org/personnel/hr-manager.yaml` into `~/.cuttlefish/org/personnel/` (the
   gateway hot-reloads it; no restart needed).
2. Re-copy the updated `skills/management/SKILL.md` and `CLAUDE.md` if you have
   not customized them.
3. The HR / Org Steward panel appears in the web UI nav automatically.
