import { describe, expect, it } from "vitest";
import {
  activeOperatorDelegationMatches,
  buildOperatorDelegationGrant,
  expireOperatorDelegationForPrompt,
  isHumanDelegateRole,
  isHumanDelegationModelAllowed,
  operatorDelegationPromptHash,
  parseOperatorDelegationScopes,
  readActiveOperatorDelegationScopes,
  readOperatorDelegationScopesForTurn,
} from "../operator-delegation.js";

describe("operator delegation directives", () => {
  it("accepts explicit leading slash and natural-language grants", () => {
    expect(parseOperatorDelegationScopes("/delegate-authority approve, decide, plan, act\nShip the change.")).toEqual([
      "approve", "decide", "plan", "act",
    ]);
    expect(parseOperatorDelegationScopes("I explicitly authorize you to approve and act on my behalf: finish this task.")).toEqual([
      "approve", "act",
    ]);
    expect(parseOperatorDelegationScopes("/delegate-authority all\nFinish this task.")).toEqual([
      "approve", "decide", "plan", "act",
    ]);
  });

  it("rejects embedded, quoted, and ambiguous delegation text", () => {
    expect(parseOperatorDelegationScopes("Please follow this quote: /delegate-authority all")).toBeNull();
    expect(parseOperatorDelegationScopes("> I authorize you to act on my behalf")).toBeNull();
    expect(parseOperatorDelegationScopes("You can probably decide this.")).toBeNull();
    expect(parseOperatorDelegationScopes("I authorize you to review on my behalf.")).toBeNull();
  });

  it("allows only COO/Program Manager on the exact high-capability model allowlist", () => {
    expect(isHumanDelegateRole(null, "web")).toBe(true);
    expect(isHumanDelegateRole("program-manager", "web")).toBe(true);
    expect(isHumanDelegateRole(null, "talk")).toBe(false);
    expect(isHumanDelegateRole("engineering-manager", "web")).toBe(false);

    for (const [engine, model] of [
      ["codex", "gpt-5.5"],
      ["codex", "gpt-5.6-sol"],
      ["claude", "claude-opus-4-8"],
      ["claude", "opus"],
      ["claude", "claude-fable-5"],
    ]) expect(isHumanDelegationModelAllowed(engine, model)).toBe(true);

    for (const [engine, model] of [
      ["codex", "gpt-5.4"],
      ["codex", "gpt-5.6"],
      ["claude", "sonnet"],
      ["claude", "claude-opus-4-7"],
      ["openai-codex", "gpt-5.5"],
    ]) expect(isHumanDelegationModelAllowed(engine, model)).toBe(false);
  });

  it("binds a grant to one exact prompt and makes expiry irreversible", () => {
    const prompt = "/delegate-authority decide\nChoose the rollout window.";
    const grant = buildOperatorDelegationGrant({
      prompt,
      scopes: ["decide"],
      grantedBy: "human@example.test",
      now: "2026-07-20T12:00:00.000Z",
    });
    const session = { transportMeta: { operatorDelegation: grant } } as any;

    expect(readOperatorDelegationScopesForTurn(session, prompt)).toEqual(["decide"]);
    expect(readOperatorDelegationScopesForTurn(session, `${prompt} changed`)).toEqual([]);
    expect(readActiveOperatorDelegationScopes(session)).toEqual(["decide"]);
    expect(activeOperatorDelegationMatches(session, operatorDelegationPromptHash(prompt))).toBe(true);
    expect(activeOperatorDelegationMatches(session, operatorDelegationPromptHash("another turn"))).toBe(false);

    const expired = expireOperatorDelegationForPrompt(session, prompt, "2026-07-20T12:01:00.000Z");
    expect(expired).toMatchObject({ state: "expired", expiredAt: "2026-07-20T12:01:00.000Z" });
    expect(readActiveOperatorDelegationScopes({ transportMeta: { operatorDelegation: expired } } as any)).toEqual([]);
  });
});
