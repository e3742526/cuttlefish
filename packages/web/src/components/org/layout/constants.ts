// Shared org-map node geometry. The employee node component renders at exactly
// NODE_W x NODE_H; both the d3-tree layout and the dagre fallback use these so
// node-size never drifts from what dagre/d3 think a node is.
export const NODE_W = 240
export const NODE_H = 78
