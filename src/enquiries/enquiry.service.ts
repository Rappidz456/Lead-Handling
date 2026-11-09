import { isValidObjectId } from "mongoose";
import { DB, ENQUIRY_STATUS, LIMITS, LOG_MESSAGES, type EnquiryStatus, type LeadTag } from "../constants.js";
import type { EnquiryTriager } from "../llm/triage.js";
import { EnquiryModel } from "./enquiry.model.js";

export class EnquiryService {
  constructor(private readonly triager: EnquiryTriager) {}

  /**
   * Saves the enquiry first, then asks the LLM for a reply + tag.
   * Saving first means an LLM outage never loses a lead: it is stored as `failed`
   * and can be retried from the admin endpoint.
   */
  async submit(input: { name: string; message: string }) {
    const enquiry = await EnquiryModel.create({ ...input, status: ENQUIRY_STATUS.PENDING });
    return this.process(enquiry.id);
  }

  async retry(id: string) {
    if (!isValidObjectId(id)) return null;
    const exists = await EnquiryModel.exists({ _id: id });
    if (!exists) return null;
    return this.process(id);
  }

  async list(filter: { tag?: LeadTag; status?: EnquiryStatus; page: number; limit: number }) {
    const query: Record<string, unknown> = {};
    if (filter.tag) query.tag = filter.tag;
    if (filter.status) query.status = filter.status;

    const [items, total] = await Promise.all([
      EnquiryModel.find(query)
        .sort(DB.SORT_NEWEST_FIRST)
        .skip((filter.page - 1) * filter.limit)
        .limit(filter.limit)
        .lean(),
      EnquiryModel.countDocuments(query),
    ]);

    return { items: items.map(toDto), page: filter.page, limit: filter.limit, total };
  }

  private async process(id: string) {
    const enquiry = await EnquiryModel.findById(id).orFail();
    try {
      const result = await this.triager.triage({ name: enquiry.name, message: enquiry.message });
      enquiry.set({
        status: ENQUIRY_STATUS.PROCESSED,
        reply: result.reply,
        tag: result.tag,
        tagReason: result.reason || null,
        llmModel: this.triager.model,
        llmError: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(LOG_MESSAGES.TRIAGE_FAILED(id, message));
      enquiry.set({
        status: ENQUIRY_STATUS.FAILED,
        llmModel: this.triager.model,
        llmError: message.slice(0, LIMITS.STORED_ERROR_MAX_LENGTH),
      });
    }
    await enquiry.save();
    return toDto(enquiry.toObject());
  }
}

type EnquiryDoc = {
  _id: unknown;
  name: string;
  message: string;
  status: string;
  tag?: string | null;
  reply?: string | null;
  tagReason?: string | null;
  llmModel?: string | null;
  llmError?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The public shape returned by the API (hides Mongo internals like __v). */
export function toDto(doc: EnquiryDoc) {
  return {
    id: String(doc._id),
    name: doc.name,
    message: doc.message,
    status: doc.status,
    tag: doc.tag ?? null,
    reply: doc.reply ?? null,
    tagReason: doc.tagReason ?? null,
    llmModel: doc.llmModel ?? null,
    llmError: doc.llmError ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
