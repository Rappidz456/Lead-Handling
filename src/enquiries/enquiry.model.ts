import { Schema, model, type InferSchemaType } from "mongoose";
import { DB, ENQUIRY_STATUS, ENQUIRY_STATUSES, LEAD_TAGS, LIMITS } from "../constants.js";

const enquirySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: LIMITS.NAME_MAX_LENGTH },
    message: { type: String, required: true, trim: true, maxlength: LIMITS.MESSAGE_MAX_LENGTH },

    status: { type: String, enum: ENQUIRY_STATUSES, default: ENQUIRY_STATUS.PENDING, index: true },
    tag: { type: String, enum: LEAD_TAGS, default: null, index: true },
    reply: { type: String, default: null },
    tagReason: { type: String, default: null },

    llmModel: { type: String, default: null },
    llmError: { type: String, default: null },
  },
  { timestamps: true },
);

enquirySchema.index(DB.SORT_NEWEST_FIRST);

export type Enquiry = InferSchemaType<typeof enquirySchema>;
export const EnquiryModel = model(DB.ENQUIRY_MODEL_NAME, enquirySchema);
