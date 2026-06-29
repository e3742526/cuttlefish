# Organization

{{portalName}} supports an organizational structure with employee personas, departments, ranks, and inter-agent communication through boards.

## Employee Personas

Employee files live at `~/.cuttlefish/org/<department>/<name>.yaml`.

```yaml
name: alice
displayName: Alice
department: engineering
rank: senior
engine: claude
model: opus
persona: |
  You are Alice, a senior engineer focused on backend systems.
  You write clean, well-tested code and prefer simple solutions.
  You review PRs thoroughly and flag potential performance issues.
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Unique identifier (lowercase, no spaces) |
| `displayName` | string | yes | Human-readable name |
| `department` | string | yes | Department directory name |
| `rank` | string | yes | One of: executive, manager, senior, employee |
| `engine` | string | yes | Engine id for this employee. Known engines in this build are `claude`, `codex`, `antigravity`, `grok`, `pi`, and `kiro`; the model registry / `config.yaml` is the source of truth. |
| `model` | string | no | Model override (default from config) |
| `reportsTo` | string or string[] | no | Explicit manager/parent override. If omitted, hierarchy is inferred from rank within the department. |
| `persona` | string | yes | System prompt defining personality and behavior |
| `approvalPolicy` | string | no | `checkpoint` requires a human checkpoint before matching risky Bash actions can proceed; `notify` allows them but records a session notification; `none` disables the extra review layer. When omitted, runtime defaults to `notify`. |
| `reviewTriggers` | string[] | no | Risk categories that trigger the security gate: `destructive_shell`, `privileged_shell`, `secret_access`, `external_network`, `prompt_injection_risk` |
| `securityReviewer` | string | no | Employee name to receive the generated security-review context for gated actions |

## Departments

Each department is a directory under `~/.cuttlefish/org/` containing:

```
~/.cuttlefish/org/engineering/
  department.yaml     # Department metadata
  board.json          # Shared task board
  alice.yaml          # Employee persona
  bob.yaml            # Employee persona
```

### department.yaml

```yaml
name: engineering
displayName: Engineering
description: Builds and maintains the product codebase.
```

### board.json

`board.json` may be a JSON array of active task objects or an object payload
with `{ tickets, deletedTickets, retentionDays }` when the recycle bin is in
use. Active tickets use this schema:

```json
[
  {
    "id": "task_001",
    "title": "Refactor auth module",
    "assignee": "alice",
    "status": "review",
    "priority": "high",
    "complexity": "medium",
    "description": "Move auth logic into a dedicated service class.",
    "createdAt": "2026-01-10T14:00:00.000Z",
    "updatedAt": "2026-01-11T09:30:00.000Z"
  }
]
```

Canonical task fields: `id`, `title`, `assignee`, `status` (`backlog`, `todo`, `in_progress`, `review`, `done`, `blocked`), `priority` (`low`, `medium`, `high`), `complexity` (`low`, `medium`, `high`), `description`, `createdAt`, `updatedAt`.

Optional ticket-level execution controls:
- `resourcePath` — one local directory path to attach when the ticket runs
- `resourceUrl` — one http(s) URL to attach when the ticket runs
- `manualOnly` — when `true`, the board worker will never auto-dispatch the ticket

## Ranks

| Rank | Privileges |
|---|---|
| **executive** | Full access. Can message any employee, modify org structure, create departments. {{portalName}} holds this rank. |
| **manager** | Can message employees in their department. Can assign tasks on their department's board. |
| **senior** | Can message employees in their department. Can update tasks assigned to them. |
| **employee** | Can update tasks assigned to them. Can post to their department's board. |

## Communication

- **Downward**: Higher-ranked agents write tasks to lower-ranked agents' department boards
- **@mentions**: Messages containing `@name` route to that specific employee
- **Board-based**: Agents check their department's `board.json` for assigned tasks
- **Cross-department**: Executives and managers can write to any department's board

## Default Organization

`cuttlefish setup` seeds a small default org under `~/.cuttlefish/org/general/`:

- `parliamentarian.yaml` — a `manager` for governance, policy, and routing work
- `assistant.yaml` — a `senior` generalist with `reportsTo: parliamentarian`
- `hr-manager.yaml` — a `manager` that critiques org changes and gates risky org mutations
- `senior-security-officer.yaml` — a `senior` reviewer seeded with the default hard security gate triggers

That gives fresh installs a manager-first lane for cross-cutting guidance work
without forcing delivery departments into existence up front. `{{portalName}}`
still acts as the executive/COO above the org even though that role is not
seeded as an employee YAML file under `org/`.
