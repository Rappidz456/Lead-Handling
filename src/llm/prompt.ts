import type { BusinessConfig } from "../config/types.js";
import { LEAD_TAGS, PROMPTS, TAG_CRITERIA, TEXT } from "../constants.js";
import type { TriageInput } from "./triage.js";

/**
 * Builds the system prompt from business config, so the same backend can serve
 * any business by changing BUSINESS_NAME / BUSINESS_DESCRIPTION in .env.
 * The prompt text itself lives in PROMPTS (constants.ts).
 */
export function buildSystemPrompt(business: BusinessConfig): string {
  return PROMPTS.SYSTEM({
    businessName: business.name,
    aboutSection: business.description ? PROMPTS.ABOUT_SECTION(business.name, business.description) : TEXT.EMPTY,
    tagCriteria: LEAD_TAGS.map((tag) => PROMPTS.TAG_CRITERION_LINE(tag, TAG_CRITERIA[tag])).join(TEXT.LINE_BREAK),
    tagUnion: LEAD_TAGS.map((tag) => JSON.stringify(tag)).join(PROMPTS.TAG_UNION_SEPARATOR),
  });
}

/** Wraps the untrusted enquiry in delimiters so it is clearly data, not instructions. */
export function buildUserMessage({ name, message }: TriageInput): string {
  return PROMPTS.USER_MESSAGE(name, message);
}
