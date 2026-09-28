import { redirect } from "react-router";

import type { Route } from "./+types/claim";
import { readFormData } from "~/lib/form.server";
import {
  CLAIM_FAILURE_MESSAGES,
  consumeClaimToken,
} from "~/lib/claim-token.server";

export function meta() {
  return [{ title: "Connecting your store · Growzar" }];
}

/**
 * Where "Open in Growzar" lands (D-10, API-CONTRACT §10).
 *
 * The token is carried in a URL fragment or a POST body, never a query string:
 * a query string is written to access logs, referrer headers and browser
 * history, and this token is a bearer proof of shop ownership.
 *
 * A fragment never reaches the server, so a GET here renders a page whose only
 * job is to move the fragment into a POST. That is also why this route has a
 * `<noscript>` path — a merchant with scripts blocked gets an explanation
 * rather than a blank screen.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);

  // An app that puts the token in the query string is not following §10. Say
  // so rather than accepting it: honouring it here would make the logged copy
  // of the token useful to whoever reads the logs.
  if (url.searchParams.has("token")) {
    return {
      error:
        "That link passed its token in the URL, which Growzar does not accept. The app needs to use a fragment or a POST.",
    };
  }

  return { error: null };
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await readFormData(request);
  const token = String(formData.get("token") ?? "").trim();

  if (!token) {
    return { error: CLAIM_FAILURE_MESSAGES.malformed };
  }

  const result = await consumeClaimToken(token);

  if (!result.ok) {
    // Deliberately not logging the token or the reason alongside it.
    console.warn(`[claim] token refused: ${result.reason}`);
    return { error: CLAIM_FAILURE_MESSAGES[result.reason] };
  }

  throw redirect(`/claim/${result.pendingClaimId}`);
}

/**
 * Moves `#token=…` into a POST and replaces the history entry, so the token is
 * not left in the address bar or the back stack.
 */
const HANDOFF = `
(function () {
  var hash = window.location.hash || "";
  var match = hash.match(/(?:^#|&)token=([^&]+)/);
  if (!match) {
    document.getElementById("claim-status").textContent =
      "This link is missing its token. Press “Open in Growzar” again inside your app.";
    return;
  }
  history.replaceState(null, "", window.location.pathname);
  var form = document.getElementById("claim-form");
  form.elements.token.value = decodeURIComponent(match[1]);
  form.submit();
})();
`;

export default function Claim({ loaderData, actionData }: Route.ComponentProps) {
  const error = actionData?.error ?? loaderData?.error ?? null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-xl">
        <h1 className="text-xl font-semibold text-gray-900">
          Connecting your store
        </h1>

        {error ? (
          <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        ) : (
          <p id="claim-status" className="mt-3 text-sm text-gray-600">
            One moment.
          </p>
        )}

        <form id="claim-form" method="post" className="hidden">
          <input type="hidden" name="token" />
        </form>

        <noscript>
          <p className="mt-3 text-sm text-gray-600">
            Connecting a store needs JavaScript for this one step, because the
            part of the link that proves you own the shop is never sent to our
            server on its own.
          </p>
        </noscript>

        {error ? null : (
          <script
            // The token only exists in this browser; nothing here is rendered
            // from user input.
            dangerouslySetInnerHTML={{ __html: HANDOFF }}
          />
        )}
      </div>
    </main>
  );
}
