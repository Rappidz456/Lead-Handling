import { isValidObjectId } from "mongoose";
import {
  DB,
  ENQUIRY_STATUS,
  LIMITS,
  LOG_MESSAGES,
  MESSAGES,
  RETRY,
  RETRY_OUTCOME,
  type EnquiryStatus,
  type LeadTag,
} from "../constants.js";
import type { EnquiryTriager } from "../llm/triage.js";
import { EnquiryModel } from "./enquiry.model.js";

export class EnquiryService {
  constructor(private readonly triager: EnquiryTriager) {}

  /**
   * Saves the enquiry first, then asks the LLM for a reply + tag.
   * Saving first means an LLM outage never loses a lead: it is stored as `failed`
   * and can be retried from the admin endpoint.
   */
  async submit(input: { name: string; message: string }): Promise<EnquiryDto> {
    const enquiry = await EnquiryModel.create({ ...input, status: ENQUIRY_STATUS.PENDING });
    return this.process(enquiry.id, enquiry.name, enquiry.message);
  }

  /**
   * Re-runs the LLM on an enquiry that failed, or one stuck in `pending` for longer than
   * RETRY.PENDING_STALE_MS (e.g. the process crashed mid-call).
   *
   * The claim is a single atomic findOneAndUpdate that moves the enquiry to `pending`.
   * Concurrent retries race on that update; exactly one wins, the rest get `conflict`.
   * Processed enquiries are never touched.
   */
  async retry(id: string): Promise<RetryResult> {
    if (!isValidObjectId(id)) return { outcome: RETRY_OUTCOME.NOT_FOUND };

    const staleBefore = new Date(Date.now() - RETRY.PENDING_STALE_MS);
    const claimed = await EnquiryModel.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { status: ENQUIRY_STATUS.FAILED },
          { status: ENQUIRY_STATUS.PENDING, updatedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: ENQUIRY_STATUS.PENDING, llmError: null } },
      DB.RETURN_UPDATED,
    );

    if (!claimed) {
      const current = await EnquiryModel.findById(id).select({ status: 1 }).lean();
      if (!current) return { outcome: RETRY_OUTCOME.NOT_FOUND };
      return { outcome: RETRY_OUTCOME.CONFLICT, status: current.status };
    }

    const enquiry = await this.process(claimed.id, claimed.name, claimed.message);
    return { outcome: RETRY_OUTCOME.RETRIED, enquiry };
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

  /**
   * Runs the LLM for an enquiry this caller has claimed (status `pending`) and writes the outcome.
   * The write only applies while the enquiry is still `pending`, so a result can never
   * overwrite one written by another worker.
   */
  private async process(id: string, name: string, message: string): Promise<EnquiryDto> {
    let update: Record<string, unknown>;
    try {
      const result = await this.triager.triage({ name, message });
      update = {
        status: ENQUIRY_STATUS.PROCESSED,
        reply: result.reply,
        tag: result.tag,
        tagReason: result.reason || null,
        llmModel: this.triager.model,
        llmError: null,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(LOG_MESSAGES.TRIAGE_FAILED(id, error));
      update = {
        status: ENQUIRY_STATUS.FAILED,
        llmModel: this.triager.model,
        llmError: error.slice(0, LIMITS.STORED_ERROR_MAX_LENGTH),
      };
    }

    const written = await EnquiryModel.findOneAndUpdate(
      { _id: id, status: ENQUIRY_STATUS.PENDING },
      { $set: update },
      DB.RETURN_UPDATED,
    ).lean();
    // Another worker finished first: return what it wrote rather than overwriting it.
    const final = written ?? (await EnquiryModel.findById(id).orFail().lean());
    return toDto(final);
  }
}

export type RetryResult =
  | { outcome: typeof RETRY_OUTCOME.NOT_FOUND }
  | { outcome: typeof RETRY_OUTCOME.CONFLICT; status: EnquiryStatus }
  | { outcome: typeof RETRY_OUTCOME.RETRIED; enquiry: EnquiryDto };

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

export type EnquiryDto = ReturnType<typeof toDto>;

/**
 * What the public submit endpoint returns to the customer. The lead tag, tag reason
 * and raw LLM error are internal and only visible on the admin endpoints.
 */
export function toPublicDto(enquiry: EnquiryDto) {
  const replied = enquiry.status === ENQUIRY_STATUS.PROCESSED;
  return {
    id: enquiry.id,
    status: enquiry.status,
    reply: enquiry.reply,
    notice: replied ? null : MESSAGES.SUBMIT.REPLY_UNAVAILABLE,
    createdAt: enquiry.createdAt,
  };
}

/** The full admin shape (hides Mongo internals like __v). */
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
