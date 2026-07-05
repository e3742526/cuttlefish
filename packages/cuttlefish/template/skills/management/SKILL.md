---
name: management
description: Manage the AI organization - hire, fire, promote, delegate, and review boards
---

# Management Skill

## Trigger

This skill activates when the user wants to manage their organization: hiring or firing employees, creating departments, promoting or demoting staff, delegating tasks, reviewing task boards, or restructuring teams.

## Organization Structure

The organization lives under the `org/` directory in the {{portalName}} home folder (`~/.cuttlefish/org/`). Each department is a subdirectory containing employee persona YAML files and a task board.

```
org/
  engineering/
    department.yaml
    board.json
    lead-developer.yaml
    backend-dev.yaml
  marketing/
    department.yaml
    board.json
    seo-specialist.yaml
```

## Org changes flow through HR (mandatory)

Every org change — hiring, firing/retiring, promoting/demoting, reassigning, or
changing an employee's model/engine/budget — MUST be submitted as a **change
request** so the **HR / Org Steward** can critique it and (for anything beyond a
cosmetic edit) the operator can approve it. Do **not** hand-write or delete
employee YAML directly when acting as the COO or an employee.

Submit a change request:

```bash
curl -s -X POST <gateway>/api/org/change-requests \
  -H 'Content-Type: application/json' \
  -d '{
    "changeType": "create_agent",
    "employeeName": "ui-test-reviewer",
    "proposed": {
      "displayName": "UI Test Reviewer",
      "department": "engineering",
      "rank": "employee",
      "engine": "claude",
      "model": "sonnet",
      "reportsTo": "lead-developer",
      "persona": "You review UI test failures and file issue-ready findings."
    },
    "rationale": "User asked for flaky UI test triage.",
    "proposedBy": "coo"
  }'
```

`changeType` is one of: `create_agent`, `modify_instructions`, `change_model`,
`change_engine`, `change_budget`, `promote`, `demote`, `reassign_manager`,
`change_department`, `disable_agent`, `retire_agent`. `proposed` carries the
fields to apply (a full employee body for `create_agent`; the changed fields
otherwise). The gateway responds `202` with the change request: HR critiques it
in the background, then it lands in the **HR / Org Steward** panel's *Org changes*
tab (and the *Approvals* queue) for the operator to approve or reject. Low-risk
cosmetic edits apply automatically. Validate a draft first with
`POST /api/org/validate` (same body, no side effects). The steward may not modify
itself — those requests are rejected.

The step-by-step recipes below describe the YAML each change produces; build the
`proposed` body from them and submit it via the change-request API rather than
writing files.

## Rank Definitions

- **executive** - Full access. Can see all departments and boards. Can hire and fire anyone across the entire organization.
- **manager** - Can manage their own department. Can hire within their department. Can see and manage their department's board.
- **senior** - Can update their own tasks. Can mentor other employees in the department.
- **employee** - Can update their own tasks only.

## Operations

### Hiring an Employee

Create a persona YAML file at `org/<department>/<name>.yaml`.

Required fields:
- `name` - kebab-case identifier (must match filename without extension)
- `displayName` - human-readable name
- `department` - department this employee belongs to (must match parent directory name)
- `rank` - one of: executive, manager, senior, employee
- `engine` - AI engine to use: `claude` or `codex`
- `model` - model identifier (e.g., `sonnet`, `opus`, `o3`)
- `persona` - multiline description of who this employee is and how they behave
- `reportsTo` - (optional) who this employee reports to (employee name)

**Auto-determining `reportsTo`** when the user does not specify:
1. If the new employee's `rank` is `manager`, omit `reportsTo` unless the user explicitly names a supervisor. Smart defaults attach managers to {{portalName}} / COO root.
2. For non-managers, find the manager in the target department.
3. If a manager exists → set `reportsTo: <manager-name>`.
4. If no manager exists → omit `reportsTo` and tell the user there is no department manager yet; ask whether they want to assign a supervisor.
5. Confirm to the user: "Assigned X to report to Y. Change this?" or "No department manager exists yet, so X has no explicit manager. Assign one?"

When the user specifies a report-to explicitly, validate the target exists in the registry. If not, warn and ask for correction.

Example (`org/marketing/seo-specialist.yaml`):

```yaml
name: seo-specialist
displayName: Sarah SEO
department: marketing
rank: employee
engine: claude
model: sonnet
reportsTo: marketing-lead
persona: |
  You are Sarah, an SEO specialist in the marketing department.
  You focus on keyword research, content optimization, and
  technical SEO. You report to the marketing manager.
  Your expertise includes Google Search Console, Ahrefs,
  and content strategy.
```

Steps:
1. Confirm the target department exists under `org/`. If not, ask the user whether to create it first.
2. Choose a kebab-case name for the employee (e.g., `lead-developer`, `seo-specialist`).
3. Ask the user for displayName, rank, engine, model, and persona if not provided.
4. Submit a `create_agent` change request (see "Org changes flow through HR" above)
   with the fields as the `proposed` body — do NOT write the YAML yourself. HR
   critiques it and the operator approves it before it is created.
5. Tell the user you've proposed the hire and that HR is reviewing it; surface
   HR's critique when it lands.

### Firing / Retiring an Employee

Retirement is a soft delete: the steward moves the persona to `org/_retired/`
instead of destroying it, so it can be restored.

1. Locate the employee under `org/<department>/<name>.yaml`.
2. Check if the employee has any active tasks on the department board (`board.json` with status other than `done`). Warn the user if so.
3. **Check for direct reports**: Call `GET /api/org` and check the employee's `directReports` field.
   - If they have direct reports, reassign them FIRST via `reassign_manager`
     change requests (set each report's `reportsTo` to the retiring employee's own
     `parentName`), since the gateway refuses to orphan reports.
4. Submit a `retire_agent` change request for the employee (no `proposed` fields
   needed). After approval the persona moves to `org/_retired/`.
5. Remove the employee as assignee from any tasks in `board.json` (set assignee to `unassigned`).
6. Confirm the removal to the user.

### Creating a Department

1. Create the directory `org/<dept-name>/`.
2. Create `org/<dept-name>/department.yaml` with:
   ```yaml
   name: dept-name
   displayName: Department Display Name
   description: What this department does.
   ```
3. Create `org/<dept-name>/board.json` with an empty array: `[]`
4. Confirm the department creation to the user.

### Promoting or Demoting an Employee

1. Read the employee's YAML file at `org/<department>/<name>.yaml`.
2. Build the `proposed` body: the new `rank`, plus (if promoting to **manager**)
   the extended persona with delegation capabilities (see "Promoting to Manager"
   below).
3. Submit a `promote` (or `demote`) change request with that `proposed` body.
4. Confirm the change to the user once approved, stating the old and new rank.

### Promoting to Manager - Report Reassignment

When promoting an employee to manager rank:

1. Check if other department members currently report elsewhere (or have no explicit `reportsTo`).
2. Offer to reassign: "Promoting X to manager. Currently N employees have no explicit reporting chain in this department. Should they report to X?"
3. On confirmation, update each employee's YAML with `reportsTo: <new-manager-name>`.

Their persona must also be extended with delegation capabilities so they can manage their own reports. Append the following to their existing persona:

```yaml
persona: |
  [... existing persona content ...]

  ## Manager Responsibilities
  You are the manager of the [department] department. In addition to your
  technical expertise, you:

  - Manage and delegate tasks to employees in your department
  - You can spawn child sessions via the gateway API to delegate work
  - Apply oversight levels to your reports' work:
    - TRUST: simple lookups, status checks - relay directly
    - VERIFY: code changes, routine work - spot-check key outputs
    - THOROUGH: architecture, breaking changes - full review, multi-turn
  - Report summaries back to the COO ({{portalName}}), not raw employee output
  - Use the department board (board.json) to track task status
  - When given a task by the COO, decide whether to do it yourself or
    delegate to the right employee based on their skills and workload

  ## Delegation API
  - Create child session: POST /api/sessions with parentSessionId
  - Send follow-up: POST /api/sessions/:id/message
  - Poll status: GET /api/sessions/:id
  - List your reports: GET /api/org
```

**When to suggest promoting to manager:**
- A department has 3+ employees
- You're spending excessive time on per-employee delegation in that department
- A senior employee has consistently delivered high-quality work
- The user explicitly requests it

### Delegating Tasks

Add a task object to the department's `board.json` file.

Task object schema:

```json
{
  "id": "uuid-v4",
  "title": "Short description of the task",
  "assignee": "employee-name",
  "status": "todo",
  "priority": "high",
  "description": "Detailed description of what needs to be done.",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "updatedAt": "2025-01-15T10:30:00.000Z"
}
```

Field details:
- `id` - generate a UUID v4
- `title` - short, descriptive title
- `assignee` - the `name` field from the employee's YAML (must match an existing employee in the department)
- `status` - one of: `todo`, `in-progress`, `review`, `done`
- `priority` - one of: `high`, `medium`, `low`
- `description` - detailed task description
- `createdAt` - ISO 8601 timestamp when the task was created
- `updatedAt` - ISO 8601 timestamp, same as createdAt initially

Steps:
1. Read the current `board.json` for the department.
2. Verify the assignee exists as an employee in that department.
3. Generate a new task object with a UUID.
4. Append the task to the array.
5. Write the updated array back to `board.json`.
6. Confirm the delegation to the user.

### Reviewing Boards

1. Read the department's `board.json`.
2. Present tasks grouped by status: todo, in-progress, review, done.
3. Include priority and assignee for each task.
4. If the user wants to update a task status, modify the task's `status` and `updatedAt` fields in the JSON array and write it back.

### Restructuring (Moving Employees Between Departments)

1. Read the employee's YAML from the source department.
2. Update the `department` field to the new department name.
3. Offer to update `reportsTo`: "Should X report to <new-dept-manager>?"
4. If the moved employee had direct reports, offer to reassign them to the next highest-ranked person in the old department.
5. Write the YAML to the new department directory.
6. Delete the YAML from the old department directory.
7. Move any assigned tasks from the old board to the new board (or reassign them, based on user preference).
8. Confirm the move to the user.

## Communication Rules

- Messages from higher-ranked employees can reference and direct lower-ranked employees.
- @mentions in messages (e.g., `@seo-specialist`) route to the mentioned employee's engine and model as defined in their persona YAML.
- An executive can message anyone. A manager can message employees within their department. Seniors and employees can message peers and their manager.

## Error Handling

- If a department does not exist when hiring, offer to create it.
- If an employee name conflicts with an existing file, warn the user and ask for a different name.
- If `board.json` is malformed, attempt to parse and fix it. If unrecoverable, back it up and create a fresh empty board.
- Always validate YAML before writing to ensure it is well-formed.
