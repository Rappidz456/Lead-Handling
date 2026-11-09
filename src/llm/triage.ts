import { z } from "zod";
import { LEAD_TAGS, LIMITS, LLM, LLM_ERRORS, TEXT } from "../constants.js";

/**
 * Provider-agnostic triage contract. The service only knows about this interface,
 * so swapping Groq for another provider means adding one class (see groq.ts).
 */
export interface TriageInput {
  name: string;
  message: string;
}

export interface EnquiryTriager {
  /** Model identifier stored alongside each enquiry for traceability. */
  readonly model: string;
  triage(input: TriageInput): Promise<TriageResult>;
}

export const TriageResultSchema = z.object({
  reply: z.string().trim().min(1).max(LIMITS.REPLY_MAX_LENGTH),
  tag: z.enum(LEAD_TAGS),
  reason: z.string().trim().max(LIMITS.TAG_REASON_MAX_LENGTH).default(TEXT.EMPTY),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

/** Parses and validates a model's raw text output. Provider-independent. */
export function parseTriageOutput(raw: string): TriageResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const match = raw.match(LLM.JSON_BLOCK_PATTERN);
    if (!match) throw new Error(LLM_ERRORS.NOT_JSON);
    json = JSON.parse(match[0]);
  }
  if (json && typeof json === "object" && "tag" in json && typeof json.tag === "string") {
    (json as { tag: string }).tag = json.tag.trim().toLowerCase();
  }
  const result = TriageResultSchema.safeParse(json);
  if (!result.success) {
    throw new Error(LLM_ERRORS.VALIDATION_FAILED(result.error.issues.map((i) => i.message).join(TEXT.ISSUE_SEPARATOR)));
  }
  return result.data;
}
