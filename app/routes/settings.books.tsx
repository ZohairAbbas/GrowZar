import { Form, useNavigation } from "react-router";
import { BookOpen } from "lucide-react";

import type { Route } from "./+types/settings.books";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { Forbidden, hasPermission, requireSection } from "~/lib/authorize.server";
import { viewerIsInternal } from "~/lib/outcomes/results.server";
import { booksEnabled } from "~/lib/books-app/access.server";
import { Notice } from "~/components/metrics/Metrics";

export function meta() {
  return [{ title: "Books · Settings · Growzar" }];
}

/**
 * Settings → Books (B2, D-91): the organization's switch, off by default.
 * Until the pilot passes (B8) only internal accounts see this page and turn
 * it on; everyone else gets 404, so the pilot stays invisible.
 */
async function context(request: Request) {
  const viewer = await requireSection(request, "settings", "view");
  if (!(await viewerIsInternal(viewer.userId))) throw new Response("Not found", { status: 404 });
  return viewer;
}

export async function loader({ request }: Route.LoaderArgs) {
  const viewer = await context(request);
  const [canManage, settings, book] = await Promise.all([
    hasPermission(request, viewer.organizationId, "settings", "manage"),
    prisma.booksSettings.findUnique({ where: { organizationId: viewer.organizationId } }),
    prisma.bkBook.findUnique({ where: { organizationId: viewer.organizationId }, select: { createdAt: true } }),
  ]);
  return {
    canManage,
    serverOn: booksEnabled(),
    enabled: settings?.enabled ?? false,
    changedAt: settings?.changedAt?.toISOString() ?? null,
    setUp: Boolean(book),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const viewer = await context(request);
  if (!(await hasPermission(request, viewer.organizationId, "settings", "manage"))) {
    throw new Forbidden("Your role does not allow manage on settings.");
  }
  const intent = String((await readFormData(request)).get("intent") ?? "");
  if (intent !== "enable" && intent !== "disable") return { error: "Nothing to do." };
  const enabled = intent === "enable";
  await prisma.booksSettings.upsert({
    where: { organizationId: viewer.organizationId },
    create: { organizationId: viewer.organizationId, enabled, changedByUserId: viewer.userId, changedAt: new Date() },
    update: { enabled, changedByUserId: viewer.userId, changedAt: new Date() },
  });
  return { ok: enabled ? "Books is on for this organization." : "Books is off for this organization. Nothing in the books is deleted." };
}

export default function BooksSettingsPage({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <div className="space-y-4">
      <header>
        <h2 className="flex items-center gap-2 font-display text-lg font-bold text-gray-900">
          <BookOpen className="h-5 w-5 text-accent-600" /> Books
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          The organization's double-entry books. Shown here to internal accounts only while Books is piloted; members see it once it's on, if their role allows and they can see every store.
        </p>
      </header>

      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      {!d.serverOn ? <Notice tone="warn">Books is switched off on this server (BOOKS_ENABLED), so nobody can use it whatever the setting below says.</Notice> : null}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-5">
        <div>
          <h3 className="font-medium text-gray-900">For this organization</h3>
          <p className="text-sm text-gray-600">
            {d.enabled ? "On: Books shows in the navigation." : "Off: nobody in the organization sees Books."} {d.setUp ? "The books are set up." : "The books aren't set up yet."}
          </p>
        </div>
        {d.canManage ? (
          <Form method="post">
            <button
              type="submit"
              name="intent"
              value={d.enabled ? "disable" : "enable"}
              disabled={busy}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50 ${d.enabled ? "bg-field text-gray-700 hover:bg-gray-100" : "bg-navy text-white hover:bg-navy-surface"}`}
            >
              {d.enabled ? "Turn Books off" : "Turn Books on"}
            </button>
          </Form>
        ) : (
          <p className="text-sm text-gray-500">Only an owner or admin can change this.</p>
        )}
      </section>
    </div>
  );
}
