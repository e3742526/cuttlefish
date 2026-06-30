export const meta = {
  name: 'cuttlefish-audit-sweep',
  description: 'Triage-depth sweep of 35 audit lenses + 2 operator bug investigations over the cuttlefish repo',
  phases: [
    { title: 'Audit', detail: '35 audit lenses at triage depth, parallel' },
    { title: 'Investigate', detail: '2 operator-reported bugs (employee editor, opus CLI)' },
  ],
}

const REPO = '/home/ericl/Work/vscode/public_share/cuttlefish'
const SKILLS = '/home/ericl/Work/vscode/dev_tools/agent-skills/10_audit'

const LENSES = [
  'audit-architecture-nodejs', 'audit-architecture-seam', 'audit-compliance-posture',
  'audit-contract-crossrepo', 'audit-contract-internalapi', 'audit-dataflow-cascade',
  'audit-dataflow-concurrency', 'audit-dataflow-input-output', 'audit-dataflow-integrity',
  'audit-dataflow-pipeline-graph', 'audit-dataflow-state-transition', 'audit-dataflow-temporal',
  'audit-deadcode-cleanup', 'audit-dependency-criticality', 'audit-design-webapp',
  'audit-equation-sourcebase', 'audit-failsafe-readiness', 'audit-invariant-sync',
  'audit-memory-lifecycle', 'audit-multiagent-consensus', 'audit-negative-space',
  'audit-operator-signal', 'audit-performance-profile', 'audit-pipeline-externalapi',
  'audit-recovery-idempotency', 'audit-reliability', 'audit-security-code',
  'audit-security-llm', 'audit-security-nodejs', 'audit-security-repo-posture',
  'audit-security-repo-triage', 'audit-security-supabase', 'audit-security-vuln-harness',
  'audit-security', 'audit-workflow-gui',
]

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    applicable: { type: 'boolean', description: 'false if this lens does not apply to the repo' },
    notApplicableReason: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          domain: { type: 'string', description: 'security | data integrity | reliability | performance | backend | correctness | frontend/UX-bug | build/CI | docs-defect' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
          file: { type: 'string', description: 'primary repo-relative file:line' },
          touchSet: { type: 'array', items: { type: 'string' }, description: 'files/functions/data-paths a fix would touch' },
          evidence: { type: 'string', description: 'concrete proof this is real: code excerpt, failure scenario, repro' },
          isDefect: { type: 'boolean', description: 'true = wrong/unsafe/broken behavior; false = feature gap or style' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['title', 'domain', 'priority', 'complexity', 'file', 'touchSet', 'evidence', 'isDefect', 'confidence'],
      },
    },
  },
  required: ['lens', 'applicable', 'findings'],
}

const lensPrompt = (lens) => `You are running a single audit lens in TRIAGE DEPTH over a TypeScript/Node monorepo.

Repo: ${REPO}
Your lens skill: ${SKILLS}/${lens}/SKILL.md  (read this first to learn exactly what to look for; also skim its CHECKLIST.md if present)

Repo layout: packages/cuttlefish (Node/TS gateway daemon, CLI, engines, sessions, orchestration, connectors, email) and packages/web (React web UI). It is an AI-agent gateway that orchestrates LLM "employee" sessions (claude/codex/etc) over a local HTTP daemon.

TRIAGE DEPTH means: spend your effort finding REAL, evidence-backed defects fast — do not write a long essay. A defect is behavior that is wrong, unsafe, or broken, NOT a missing feature or style nit.

Rules:
- If this lens does not meaningfully apply to this repo (e.g. it targets Supabase/cross-repo/data-equation stacks not present here), set applicable=false with a one-line reason and return zero findings. Do NOT invent findings to look productive.
- Every finding MUST cite a concrete file:line and contain evidence (a code excerpt or a concrete failure scenario). No speculative "could in theory" findings without a code path.
- Set isDefect=true only for genuine defects. Mark feature gaps / style as isDefect=false (they will be filtered out).
- Prefer fewer high-confidence findings over many weak ones. Cap at ~8 findings.
- Do NOT propose fixes for these protected/deferred items: ARC-CF-001..004, ARC-CUT-001, ARC-CUT-002 (architecture refactors, intentionally deferred). You may still note them but mark priority accordingly and isDefect=false.
- Read code with the available tools. Use grep/glob to locate, read excerpts to confirm. Do not edit anything.

Return the structured findings object for lens "${lens}".`

phase('Audit')
const auditResults = await parallel(
  LENSES.map((lens) => () =>
    agent(lensPrompt(lens), {
      label: lens,
      phase: 'Audit',
      schema: FINDINGS_SCHEMA,
      agentType: 'Explore',
    })
  )
)

phase('Investigate')
const BUG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bug: { type: 'string' },
    rootCauseFound: { type: 'boolean' },
    summary: { type: 'string', description: 'what is actually broken and why' },
    findings: FINDINGS_SCHEMA.properties.findings,
  },
  required: ['bug', 'rootCauseFound', 'summary', 'findings'],
}

const bugs = await parallel([
  () => agent(`Investigate a reported bug: "something is wrong with the employee editing tool in the GUI" for the cuttlefish repo at ${REPO}.

The employee editor lives in packages/web/src/components/org/ (employee-editor.tsx, employee-create-form.tsx, employee-detail.tsx, employee-fallback-model-select.tsx, employee-node.tsx) and the backend save path is in packages/cuttlefish/src/gateway/api/routes/org.ts (updateEmployee) plus packages/web/src/lib/api-org.ts. Recent work added an "execution" config block (tier/maxInternalPasses/roles) to the employee editor behind a feature flag.

Trace the full edit→save→persist flow. Find what is actually broken: validation that rejects valid input, a field that doesn't persist, a save that silently fails, a flag-gated field that breaks, a contract mismatch between web payload and the org.ts handler, employee YAML missing required fields (e.g. persona) after edit, etc. Read the actual code and the org.ts updateEmployee handler carefully. Cite file:line and give a concrete repro/failure scenario. Return structured findings (each a real defect with evidence).`, { label: 'bug:employee-editor', phase: 'Investigate', schema: BUG_SCHEMA }),

  () => agent(`Investigate a reported bug: "agents running with opus aren't working via the CLI" for the cuttlefish repo at ${REPO}.

Investigate the CLI interface and the model/engine resolution path. Relevant areas: packages/cuttlefish/src/cli/ (create.ts, start.ts, etc), packages/cuttlefish/src/engines/ (claude engine, model resolution), packages/cuttlefish/src/sessions/session-patch.ts (validateNewSessionSelection / validateSessionPatch — recent work added model alias expansion sonnet/opus/haiku -> canonical IDs), and how the claude engine is spawned with a model. The current model IDs are: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001. Note from the running daemon's spawn args, the claude CLI is invoked with flags like --model and --append-system-prompt.

Find why an employee/session configured with "opus" fails when run through the CLI/engine: is the alias 'opus' expanded to a wrong/nonexistent model id? Is the spawned claude --model flag passed a value the claude CLI rejects? Is there a hardcoded model list missing opus-4-8? Is the alias map stale? Read the actual model-resolution and engine-spawn code. Cite file:line, give the exact broken value/flag, and a concrete failure scenario. Return structured findings (real defects with evidence).`, { label: 'bug:opus-cli', phase: 'Investigate', schema: BUG_SCHEMA }),
])

return {
  audits: auditResults.filter(Boolean),
  bugs: bugs.filter(Boolean),
}
