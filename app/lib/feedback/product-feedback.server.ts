import { prisma } from "../db.server";
import { VERSION } from "../version.server";
import type { FeedbackForm } from "./product-feedback";

/** One "this looks wrong", with the figures as they stood and the build that showed them. */
export async function saveFeedback(f: FeedbackForm, who: { organizationId: string; userId: string }, version: string = VERSION): Promise<string> {
  const row = await prisma.productFeedback.create({
    data: {
      organizationId: who.organizationId,
      userId: who.userId,
      storeId: f.storeId,
      tool: f.tool,
      kind: f.kind,
      note: f.note,
      subject: f.subject,
      inputs: f.inputs as never,
      version,
    },
    select: { id: true },
  });
  return row.id;
}
