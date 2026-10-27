import { useState } from "react";
import { useFetcher } from "react-router";
import { Flag } from "lucide-react";

import { FEEDBACK_KINDS, FEEDBACK_THANKS, KINDS_FOR, type FeedbackTool } from "~/lib/feedback/product-feedback";

/**
 * "This looks wrong" (pre-Wave-1 pack 2): a small link that opens a short
 * form in place, sends it with the figures the page showed, and says thanks.
 * `inputs` is what this tool showed, as the loader gave it to the page.
 */
export function LooksWrong({ tool, storeId, subject, inputs, compact = false }: { tool: FeedbackTool; storeId: string; subject?: string; inputs: Record<string, unknown>; compact?: boolean }) {
  const fetcher = useFetcher<{ ok?: true; error?: string }>();
  const [open, setOpen] = useState(false);
  const id = `looks-wrong-${tool}-${subject ?? "all"}`;
  if (fetcher.data?.ok) return <p className="text-xs font-semibold text-mint-700">{FEEDBACK_THANKS}</p>;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-gray-700 hover:underline">
        <Flag className="h-3 w-3" aria-hidden /> This looks wrong
      </button>
    );
  }
  const field = "rounded-full border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900";
  return (
    <fetcher.Form method="post" action="/api/feedback" className={`flex flex-wrap items-center gap-2 ${compact ? "max-w-xs" : ""}`}>
      <input type="hidden" name="tool" value={tool} />
      <input type="hidden" name="storeId" value={storeId} />
      {subject ? <input type="hidden" name="subject" value={subject} /> : null}
      <input type="hidden" name="inputs" value={JSON.stringify(inputs)} />
      <label className="sr-only" htmlFor={`${id}-kind`}>
        What looks wrong?
      </label>
      <select id={`${id}-kind`} name="kind" required defaultValue="" className={field}>
        <option value="" disabled>
          What looks wrong?
        </option>
        {KINDS_FOR[tool].map((k) => (
          <option key={k} value={k}>
            {FEEDBACK_KINDS[k]}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor={`${id}-note`}>
        Note
      </label>
      <input id={`${id}-note`} name="note" maxLength={1000} placeholder="Note (optional)" className={`min-w-[12rem] flex-1 ${field}`} />
      <button type="submit" disabled={fetcher.state !== "idle"} className="rounded-full bg-field px-3.5 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">
        Send
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-sm font-semibold text-gray-500 hover:underline">
        Cancel
      </button>
      {fetcher.data?.error ? <p className="w-full text-xs text-coral-700">{fetcher.data.error}</p> : null}
    </fetcher.Form>
  );
}
