import axe from "axe-core"

/**
 * Runs axe-core against a rendered container and returns any violations.
 * jsdom lacks real layout/paint, so color-contrast and a few other visual
 * rules are disabled — this checks structural/semantic a11y only (labels,
 * roles, landmarks, form associations), not visual contrast.
 */
export async function runAxe(container: Element): Promise<axe.Result[]> {
  const results = await axe.run(container, {
    rules: {
      "color-contrast": { enabled: false },
    },
  })
  return results.violations
}

export function formatViolations(violations: axe.Result[]): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`)
    .join("\n\n")
}
