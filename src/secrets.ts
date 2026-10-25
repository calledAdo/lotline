// Public artifacts must be refused, not silently altered, if they contain credentials.
// Counts such as input_tokens and opaque receipt IDs are evidence, not authentication.
import { redact } from "./env.ts";

export function assertNoSecrets(text: string): void {
  const patterns = [
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i,
    /\b(?:sk-[A-Za-z0-9_-]{12,}|nvapi-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
    /["'](?:authorization|api[_-]?key|access[_-]?key(?:[_-]?id)?|secret(?:[_-]?access[_-]?key)?|password|runtime[_-]?token|refresh[_-]?token|access[_-]?token)["']\s*:\s*["'][^"']+/i,
    /https?:\/\/[^\s/"']+:[^\s/"']+@/i,
    /\*\*\*/, // an earlier redaction means this recording is not fit to publish
  ];
  if (redact(text) !== text || patterns.some(p => p.test(text))) throw new Error("Refusing artifact: suspected credential or prior secret redaction (value withheld)");
}
