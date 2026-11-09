import Groq from "groq-sdk";
import type { LlmConfig } from "../config/types.js";
import { LLM, LLM_ERRORS } from "../constants.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt.js";
import { parseTriageOutput, type EnquiryTriager, type TriageInput, type TriageResult } from "./triage.js";

/** Groq implementation of EnquiryTriager. All settings come from LlmConfig. */
export class GroqTriager implements EnquiryTriager {
  readonly model: string;
  private readonly client: Groq;
  private readonly systemPrompt: string;

  constructor(private readonly config: LlmConfig) {
    this.model = config.model;
    this.client = new Groq({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: config.maxRetries });
    this.systemPrompt = buildSystemPrompt(config.business);
  }

  async triage(input: TriageInput): Promise<TriageResult> {
    const completion = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      response_format: { type: LLM.RESPONSE_FORMAT },
      messages: [
        { role: LLM.ROLE_SYSTEM, content: this.systemPrompt },
        { role: LLM.ROLE_USER, content: buildUserMessage(input) },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error(LLM_ERRORS.EMPTY_RESPONSE);
    return parseTriageOutput(raw);
  }
}
