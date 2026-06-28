import dagre from "@dagrejs/dagre"
import type { Node, Edge } from "@xyflow/react"
import type { Employee, OrgHierarchy } from "@/lib/api"
import { NODE_W, NODE_H } from "./constants"
import type { LayoutResult } from "./d3-tree-layout"

// Dagre layout — the fallback used only if d3-stratify rejects the employee set
// (multi-root / multi-parent / cycle). Edges carry { highlighted } in data; the
// seam (use-layouted-elements) applies the visual style, same as the d3 path.

const COL_GAP = 24
const GROUP_PAD_X = 16
const GROUP_PAD_TOP = 34
const GROUP_PAD_BOTTOM = 18
const UNASSIGNED_DEPARTMENT_LABEL = "Unassigned"

function dagreLayout(
  nodeIds: string[],
  edges: [string, string][],
  opts: { rankdir?: string; nodesep?: number; ranksep?: number } = {},
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: opts.rankdir ?? "TB",
    nodesep: opts.nodesep ?? 40,
    ranksep: opts.ranksep ?? 60,
    marginx: 20,
    marginy: 20,
  })
  for (const id of nodeIds) g.setNode(id, { width: NODE_W, height: NODE_H })
  for (const [src, tgt] of edges) g.setEdge(src, tgt)
  dagre.layout(g)
  const positions = new Map<string, { x: number; y: number }>()
  for (const id of nodeIds) {
    const n = g.node(id)
    positions.set(id, { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 })
  }
  return positions
}

export function buildHierarchyLayout(
  employees: Employee[],
  hierarchy: OrgHierarchy,
  selectedName: string | null,
): LayoutResult {
  if (employees.length === 0) return { nodes: [], edges: [] }

  const executive = employees.find((e) => e.rank === "executive")

  const highlightedNames = new Set<string>()
  if (selectedName) {
    const selectedEmp = employees.find((e) => e.name === selectedName)
    if (selectedEmp?.chain) for (const name of selectedEmp.chain) highlightedNames.add(name)
    const addDescendants = (name: string) => {
      highlightedNames.add(name)
      const emp = employees.find((e) => e.name === name)
      if (emp?.directReports) for (const child of emp.directReports) addDescendants(child)
    }
    addDescendants(selectedName)
  }

  const nodeIds = [...hierarchy.sorted]
  if (executive && !nodeIds.includes(executive.name)) nodeIds.unshift(executive.name)

  const edgePairs: [string, string][] = []
  const hasParent = new Set<string>()
  for (const name of hierarchy.sorted) {
    const emp = employees.find((e) => e.name === name)
    if (emp?.parentName && nodeIds.includes(emp.parentName)) {
      edgePairs.push([emp.parentName, name])
      hasParent.add(name)
    }
  }
  if (executive) {
    for (const name of hierarchy.sorted) {
      const emp = employees.find((employee) => employee.name === name)
      if (
        !hasParent.has(name) &&
        name !== executive.name &&
        emp?.parentName === executive.name
      ) {
        edgePairs.push([executive.name, name])
      }
    }
  }

  const positions = dagreLayout(nodeIds, edgePairs, { nodesep: 40, ranksep: 60 })

  const deptNodes = new Map<string, string[]>()
  for (const name of nodeIds) {
    const emp = employees.find((e) => e.name === name)
    if (!emp || emp.rank === "executive") continue
    const dept = emp.department || UNASSIGNED_DEPARTMENT_LABEL
    const list = deptNodes.get(dept) ?? []
    list.push(name)
    deptNodes.set(dept, list)
  }

  const computeDeptBounds = () => {
    const bounds = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>()
    for (const [dept, names] of deptNodes) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const name of names) {
        const pos = positions.get(name)
        if (!pos) continue
        minX = Math.min(minX, pos.x)
        maxX = Math.max(maxX, pos.x + NODE_W)
        minY = Math.min(minY, pos.y)
        maxY = Math.max(maxY, pos.y + NODE_H)
      }
      if (minX !== Infinity) bounds.set(dept, { minX, maxX, minY, maxY })
    }
    return bounds
  }

  const initialBounds = computeDeptBounds()
  const sortedDepts = [...initialBounds.entries()].sort((a, b) => a[1].minX - b[1].minX)
  for (let i = 1; i < sortedDepts.length; i++) {
    const prevBounds = sortedDepts[i - 1][1]
    const currBounds = sortedDepts[i][1]
    const prevRight = prevBounds.maxX + GROUP_PAD_X
    const currLeft = currBounds.minX - GROUP_PAD_X
    if (currLeft < prevRight + COL_GAP) {
      const shift = prevRight + COL_GAP - currLeft
      for (let j = i; j < sortedDepts.length; j++) {
        const dept = sortedDepts[j][0]
        for (const name of deptNodes.get(dept) ?? []) {
          const pos = positions.get(name)
          if (pos) pos.x += shift
        }
        sortedDepts[j][1].minX += shift
        sortedDepts[j][1].maxX += shift
      }
    }
  }

  if (executive) {
    const execPos = positions.get(executive.name)
    if (execPos) {
      let minX = Infinity, maxX = -Infinity
      for (const [name, pos] of positions) {
        if (name === executive.name) continue
        minX = Math.min(minX, pos.x)
        maxX = Math.max(maxX, pos.x + NODE_W)
      }
      if (minX !== Infinity) execPos.x = (minX + maxX) / 2 - NODE_W / 2
    }
  }

  const deptBounds = computeDeptBounds()
  const rfNodes: Node[] = []
  for (const [dept, bounds] of deptBounds) {
    rfNodes.push({
      id: `group-${dept}`,
      type: "departmentGroup",
      data: { label: dept },
      position: { x: bounds.minX - GROUP_PAD_X, y: bounds.minY - GROUP_PAD_TOP },
      style: {
        width: bounds.maxX - bounds.minX + GROUP_PAD_X * 2,
        height: bounds.maxY - bounds.minY + GROUP_PAD_TOP + GROUP_PAD_BOTTOM,
        padding: 0,
      },
      selectable: false,
      draggable: false,
    })
  }
  for (const name of nodeIds) {
    const pos = positions.get(name)
    const emp = employees.find((e) => e.name === name)
    if (!pos || !emp) continue
    rfNodes.push({
      id: name,
      type: "employeeNode",
      data: emp as unknown as Record<string, unknown>,
      position: { x: pos.x, y: pos.y },
      selected: name === selectedName,
    })
  }

  const rfEdges: Edge[] = []
  for (const [source, target] of edgePairs) {
    const isHi = highlightedNames.has(source) && highlightedNames.has(target)
    rfEdges.push({
      id: `${source}-${target}`,
      source,
      target,
      type: "smoothstep",
      data: { highlighted: isHi },
    })
  }

  return { nodes: rfNodes, edges: rfEdges }
}
