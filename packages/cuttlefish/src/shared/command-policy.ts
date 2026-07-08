import type { SecurityReviewTrigger } from "./types.js";

export type CommandPolicyAction = "allow" | "review" | "block";

export interface CommandPolicyDecision {
  action: CommandPolicyAction;
  reason?: string;
  triggers?: SecurityReviewTrigger[];
}

const DESTRUCTIVE: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[;&|]\s*)rm\s+-[A-Za-z]*r[A-Za-z]*f?\s+(?:\/|~(?:\s|$)|\$HOME(?:\s|$))/i, reason: "Refusing destructive recursive removal of a home/root path" },
  { re: /(^|[;&|]\s*)sudo\s+rm\s+-[A-Za-z]*r[A-Za-z]*f?\s+\//i, reason: "Refusing sudo destructive removal" },
  { re: /(^|[;&|]\s*)(?:mkfs|dd\s+if=.*\sof=\/dev\/|diskutil\s+erase)/i, reason: "Refusing disk-destructive command" },
  { re: /\b(?:python|python3|perl|ruby|node|sh|bash|zsh)\b[\s\S]{0,240}\brm\s+-[A-Za-z]*r[A-Za-z]*f?\s+(?:\/|~(?:\s|$)|\$HOME(?:\s|$))/i, reason: "Refusing interpreter-wrapped destructive removal of a home/root path" },
];

const HOME_SECRET_PATH = /(?:~\/\.ssh|\$HOME\/\.ssh|\.ssh\/id_[a-z0-9._-]+|~\/\.cuttlefish\/secrets|\$HOME\/\.cuttlefish\/secrets|~\/\.cuttlefish\/gateway\.json|\$HOME\/\.cuttlefish\/gateway\.json|~\/\.env(?:\.[\w.-]+)?|\$HOME\/\.env(?:\.[\w.-]+)?)/i;
const HOME_ENV_SEARCH = /\b(?:find|grep|rg|ripgrep)\b[\s\S]{0,160}(?:~|\$HOME)[\s\S]{0,160}\.env(?:\.[\w.-]+)?\b/i;
const NETWORK_EGRESS = /\b(?:nc|ncat|netcat|scp|rsync|ftp|sftp)\b/i;
const NETWORK_UPLOAD = /\b(?:curl|wget)\b[\s\S]{0,200}(?:--data(?:-binary|-raw|-urlencode)?\b|-d\b|--form\b|-F\b|--upload-file\b|-T\b)/i;
const HTTP_SERVER = /\bpython\s+-m\s+http\.server\b/i;
const LOOPBACK_SERVER = /\bpython\s+-m\s+http\.server\b[\s\S]{0,120}(?:^|\s)(?:--bind|-b)\s+(?:127\.0\.0\.1|::1|localhost)\b/i;
const PRIVILEGED = /\b(?:sudo|su|doas)\b/i;
const DESTRUCTIVE_REVIEW = /\b(?:rm\s+-[A-Za-z]*r|git\s+reset\s+--hard|git\s+clean\s+-[A-Za-z]*f(?:[A-Za-z]*d|d[A-Za-z]*)?[A-Za-z]*x?|chmod\s+-[A-Za-z]*R|chown\s+-[A-Za-z]*R)\b/i;
const SECRET_READ = /\b(?:cat|less|more|head|tail|grep|sed|awk|env|printenv)\b/i;
const REMOTE_EXEC = /\b(?:curl|wget)\b[\s\S]{0,120}\|\s*(?:bash|sh|zsh)\b|\bbash\s+<\(\s*(?:curl|wget)\b/i;

export function evaluateCommandPolicy(command: string): CommandPolicyDecision {
  const text = String(command ?? "").trim();
  if (!text) return { action: "allow" };
  for (const rule of DESTRUCTIVE) {
    if (rule.re.test(text)) return { action: "block", reason: rule.reason };
  }
  const remoteExec = REMOTE_EXEC.test(text);
  const networkEgress = NETWORK_EGRESS.test(text) || NETWORK_UPLOAD.test(text) || (HTTP_SERVER.test(text) && !LOOPBACK_SERVER.test(text));
  if (HOME_SECRET_PATH.test(text) && (networkEgress || remoteExec)) {
    return { action: "block", reason: "Refusing command that appears to exfiltrate secret files" };
  }
  const triggers = new Set<SecurityReviewTrigger>();
  if (DESTRUCTIVE_REVIEW.test(text)) triggers.add("destructive_shell");
  if (PRIVILEGED.test(text)) triggers.add("privileged_shell");
  if ((HOME_SECRET_PATH.test(text) && SECRET_READ.test(text)) || HOME_ENV_SEARCH.test(text)) triggers.add("secret_access");
  if (networkEgress || remoteExec) triggers.add("external_network");
  if (remoteExec) triggers.add("prompt_injection_risk");
  if (triggers.size > 0) {
    return {
      action: "review",
      reason: "Security review required before executing this Bash command",
      triggers: [...triggers],
    };
  }
  return { action: "allow" };
}
