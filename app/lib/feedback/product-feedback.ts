/**
 * "This looks wrong" (pre-Wave-1 pack 2): what a member can say about a Beta
 * forecast or a return-risk band, and reading the form they send. Pure.
 *
 * The page sends the figures it showed, as it had them; money is in them only
 * where the loader gave it to the page, so a member without finance:view
 * never sends any.
 */

export const FEEDBACK_TOOLS = ["cash_forecast", "month_end", "return_risk"] as const;
export type FeedbackTool = (typeof FEEDBACK_TOOLS)[number];

export const FEEDBACK_KINDS = {
  wrong_amount: "Wrong amount",
  wrong_date: "Wrong date",
  wrong_band: "Wrong band",
  not_my_store: "Doesn't apply to my store",
  other: "Other",
} as const;
export type FeedbackKind = keyof typeof FEEDBACK_KINDS;

/** The choices each tool offers, in order. */
export const KINDS_FOR: Record<FeedbackTool, readonly FeedbackKind[]> = {
  cash_forecast: ["wrong_amount", "wrong_date", "not_my_store", "other"],
  month_end: ["wrong_amount", "wrong_date", "not_my_store", "other"],
  return_risk: ["wrong_band", "not_my_store", "other"],
};

/** Where each tool lives, for the access check: Plan's forecasts, and Orders' bands. */
export const SECTION_FOR = { cash_forecast: "plan", month_end: "plan", return_risk: "orders" } as const;

export const FEEDBACK_THANKS = "Thanks, we've got it. The team will look.";

const NOTE_MAX = 1000;
const INPUTS_MAX = 16_000;

export type FeedbackForm = {
  tool: FeedbackTool;
  kind: FeedbackKind;
  storeId: string;
  note: string | null;
  subject: string | null;
  inputs: Record<string, unknown>;
};

const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");

/** The form as a feedback row's fields, or what is wrong with it. */
export function parseFeedback(form: FormData): FeedbackForm | { error: string } {
  const tool = text(form.get("tool")) as FeedbackTool;
  if (!FEEDBACK_TOOLS.includes(tool)) return { error: "Unknown tool." };
  const kind = text(form.get("kind")) as FeedbackKind;
  if (!KINDS_FOR[tool].includes(kind)) return { error: "Choose what looks wrong." };
  const storeId = text(form.get("storeId"));
  if (!storeId || storeId.length > 64) return { error: "Unknown store." };
  const subject = text(form.get("subject")) || null;
  if (tool === "return_risk" && !subject) return { error: "Which order?" };
  if (subject && subject.length > 64) return { error: "Unknown order." };
  const note = text(form.get("note")).slice(0, NOTE_MAX) || null;
  const raw = text(form.get("inputs"));
  if (raw.length > INPUTS_MAX) return { error: "Too much to send." };
  let inputs: unknown;
  try {
    inputs = JSON.parse(raw || "null");
  } catch {
    return { error: "The figures shown could not be read." };
  }
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return { error: "The figures shown could not be read." };
  return { tool, kind, storeId, note, subject, inputs: inputs as Record<string, unknown> };
}
