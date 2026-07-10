import "@xyflow/react/dist/style.css"
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type OnNodeDrag,
  ConnectionLineType,
} from "@xyflow/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { Employee, OrgHierarchy } from "@/lib/api"
import { nodeTypes } from "@/components/org/employee-node"
import { computeOrgLayout } from "@/components/org/layout/use-layouted-elements"
import { filterCollapsedEmployees, isDescendantOf } from "@/components/org/layout/org-map-helpers"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"

// A dense org gets hard to read at a glance; below this count the canvas
// (plus fit-to-view) is enough on its own.
const MINIMAP_NODE_THRESHOLD = 25

interface OrgMapProps {
  employees: Employee[]
  hierarchy?: OrgHierarchy
  selectedName: string | null
  onNodeClick: (employee: Employee) => void
  /** Enables drag-to-reassign when provided: dropping an employee onto
   *  another confirms, then calls this with the new manager's name. */
  onReassign?: (employee: Employee, newManagerName: string) => Promise<void>
}

// useReactFlow() (needed for drop-target detection) requires a
// ReactFlowProvider ancestor, which <ReactFlow> does not supply to its own
// parent — so this component only sets one up; all the real logic lives in
// OrgMapInner, a child of it.
export function OrgMap(props: OrgMapProps) {
  return (
    <ReactFlowProvider>
      <OrgMapInner {...props} />
    </ReactFlowProvider>
  )
}

function OrgMapInner({ employees, hierarchy, selectedName, onNodeClick, onReassign }: OrgMapProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [pendingReassign, setPendingReassign] = useState<{ employee: Employee; manager: Employee } | null>(null)
  const [reassigning, setReassigning] = useState(false)
  const [reassignError, setReassignError] = useState<string | null>(null)
  const { getIntersectingNodes } = useReactFlow()

  const toggleCollapse = useCallback((name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const visibleEmployees = useMemo(() => filterCollapsedEmployees(employees, collapsed), [employees, collapsed])

  const buildLayout = useCallback(() => {
    const { nodes, edges } = computeOrgLayout(visibleEmployees, hierarchy, selectedName)
    const decoratedNodes = nodes.map((node) => {
      if (node.type !== "employeeNode") return node
      const employee = employees.find((e) => e.name === node.id)
      if (!employee?.directReports?.length) return node
      return {
        ...node,
        data: {
          ...node.data,
          collapsed: collapsed.has(node.id),
          onToggleCollapse: () => toggleCollapse(node.id),
        },
      }
    })
    return { nodes: decoratedNodes, edges }
  }, [visibleEmployees, hierarchy, selectedName, employees, collapsed, toggleCollapse])

  const { nodes: initialNodes, edges: initialEdges } = buildLayout()
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  useEffect(() => {
    const { nodes: n, edges: e } = buildLayout()
    setNodes(n)
    setEdges(e)
  }, [buildLayout, setNodes, setEdges])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const employee = employees.find((e) => e.name === node.id)
      if (employee) onNodeClick(employee)
    },
    [employees, onNodeClick],
  )

  const snapBack = useCallback(() => {
    setNodes(buildLayout().nodes)
  }, [buildLayout, setNodes])

  const handleNodeDragStop: OnNodeDrag = useCallback(
    (_, node) => {
      if (!onReassign || node.type !== "employeeNode") return
      const draggedEmployee = employees.find((e) => e.name === node.id)
      if (!draggedEmployee || draggedEmployee.rank === "executive") {
        snapBack() // the COO/executive row has no manager slot to reassign
        return
      }
      const targetNode = getIntersectingNodes(node).find((n) => n.type === "employeeNode" && n.id !== node.id)
      const targetEmployee = targetNode ? employees.find((e) => e.name === targetNode.id) : undefined
      const currentManager = Array.isArray(draggedEmployee.reportsTo)
        ? draggedEmployee.reportsTo[0]
        : draggedEmployee.reportsTo
      if (
        !targetEmployee ||
        targetEmployee.name === currentManager ||
        isDescendantOf(employees, draggedEmployee.name, targetEmployee.name)
      ) {
        snapBack() // no drop target, dropped on the current manager, or would create a cycle
        return
      }
      setPendingReassign({ employee: draggedEmployee, manager: targetEmployee })
    },
    [employees, getIntersectingNodes, onReassign, snapBack],
  )

  async function confirmReassign() {
    if (!pendingReassign || !onReassign) return
    setReassigning(true)
    setReassignError(null)
    try {
      await onReassign(pendingReassign.employee, pendingReassign.manager.name)
      setPendingReassign(null)
    } catch (err) {
      setReassignError(err instanceof Error ? err.message : "Failed to reassign.")
    } finally {
      setReassigning(false)
    }
  }

  function cancelReassign() {
    setPendingReassign(null)
    setReassignError(null)
    snapBack()
  }

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDragStop={handleNodeDragStop}
        nodesDraggable={Boolean(onReassign)}
        nodeTypes={nodeTypes}
        connectionLineType={ConnectionLineType.SmoothStep}
        fitView
        fitViewOptions={{ padding: 0.22, duration: 400 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        {/* Low-noise chrome: fit + zoom only, no lock/interactive toggle. */}
        <Controls position="bottom-left" showInteractive={false} style={{ left: 16, bottom: 16 }} />
        {nodes.length > MINIMAP_NODE_THRESHOLD && (
          <MiniMap position="bottom-right" pannable zoomable className="!bg-[var(--material-regular)]" />
        )}
      </ReactFlow>

      {onReassign && (
        <ConfirmDialog
          open={pendingReassign !== null}
          title="Reassign reporting line?"
          description={
            pendingReassign
              ? `Move ${pendingReassign.employee.displayName || pendingReassign.employee.name} under ${pendingReassign.manager.displayName || pendingReassign.manager.name}?`
              : ""
          }
          confirmLabel={reassigning ? "Moving…" : "Move"}
          busy={reassigning}
          onOpenChange={(open) => {
            if (!open) cancelReassign()
          }}
          onConfirm={() => {
            void confirmReassign()
          }}
        />
      )}

      {reassignError && (
        <div
          role="alert"
          className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-[var(--radius-md)] border px-3 py-2 text-[length:var(--text-caption1)]"
          style={{
            borderColor: "color-mix(in srgb, var(--system-red) 30%, transparent)",
            background: "color-mix(in srgb, var(--system-red) 10%, var(--material-thick))",
            color: "var(--system-red)",
          }}
        >
          {reassignError}
        </div>
      )}
    </>
  )
}
