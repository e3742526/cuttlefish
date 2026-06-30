import { POLICY_DIR } from "../shared/paths.js";
import { evaluatePolicy } from "./evaluator.js";
import { getPolicyProfile } from "./loader.js";
import type { PolicyArtifactDescriptor, PolicyRule, PolicyVerdict } from "./types.js";

// Built-in rules evaluated after user rules but before the final default.
// Defaults: allow for knowledge:*, deny for cuttlefish.run_bundle*, allow all else.
const BUILTIN_EXPORT_RULES: PolicyRule[] = [
  { id: "builtin-allow-knowledge", action: "export", kindPattern: "knowledge:*", allow: true },
  { id: "builtin-allow-run-bundle", action: "export", kindPattern: "cuttlefish.run_bundle*", allow: true },
  { id: "builtin-default-allow-export", action: "export", allow: true },
];

export function gateExternalEmit(
  descriptor: PolicyArtifactDescriptor,
  policyDir: string = POLICY_DIR,
): PolicyVerdict {
  const profile = getPolicyProfile(policyDir);
  return evaluatePolicy(descriptor, "export", [...profile.rules, ...BUILTIN_EXPORT_RULES]);
}

export function gateArtifactRegister(
  descriptor: PolicyArtifactDescriptor,
  policyDir: string = POLICY_DIR,
): PolicyVerdict {
  const profile = getPolicyProfile(policyDir);
  return evaluatePolicy(descriptor, "register", profile.rules);
}
