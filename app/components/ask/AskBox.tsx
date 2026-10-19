import { Form } from "react-router";
import { ArrowUp, MessageCircleQuestionMark } from "lucide-react";

/** Home's single "Ask about your stores" box (G-GZR10-3): opens Ask with the question. */
export function AskBox() {
  return (
    <Form method="get" action="/ask" className="flex items-center gap-2 rounded-2xl bg-white p-2 pl-4">
      <MessageCircleQuestionMark className="h-5 w-5 flex-shrink-0 text-accent-600" aria-hidden="true" />
      <input
        name="q"
        required
        maxLength={2000}
        dir="auto"
        aria-label="Ask about your stores"
        placeholder="Ask about your stores, e.g. Lahore mein kaunsa courier best hai?"
        className="min-w-0 flex-1 bg-transparent py-2 text-sm focus:outline-none"
      />
      <button type="submit" aria-label="Ask" className="flex h-9 w-9 items-center justify-center rounded-full bg-navy text-mint">
        <ArrowUp className="h-4 w-4" />
      </button>
    </Form>
  );
}
