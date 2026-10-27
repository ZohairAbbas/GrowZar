import { Form, Link, useNavigation } from "react-router";
import { AlertCircle, CheckCircle2, MailX } from "lucide-react";

import type { Route } from "./+types/digest.unsubscribe";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { readUnsubscribeToken } from "~/lib/digest/unsubscribe.server";
import { AppIcon } from "~/components/ui/AppIcon";

export function meta() {
  return [{ title: "Weekly digest · Growzar" }];
}

/**
 * The weekly digest's unsubscribe link (G-GZR6-5). It works signed out, from
 * the signed token alone. Opening it only asks; the button, or a mail
 * client's one-click unsubscribe (a POST with `List-Unsubscribe=One-Click`,
 * RFC 8058), records the opt-out. A link scanner opening the page changes
 * nothing.
 */
async function memberFor(token: string | null) {
  const memberId = readUnsubscribeToken(token);
  if (!memberId) return null;
  return prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, user: { select: { email: true } }, organization: { select: { name: true } }, digestOptOut: { select: { at: true } } },
  });
}

export async function loader({ url }: Route.LoaderArgs) {
  const member = await memberFor(url.searchParams.get("t"));
  return {
    token: url.searchParams.get("t") ?? "",
    member: member ? { email: member.user.email, organization: member.organization.name, optedOut: member.digestOptOut !== null } : null,
  };
}

export async function action({ request, url }: Route.ActionArgs) {
  const form = await readFormData(request);
  const token = url.searchParams.get("t") ?? (typeof form.get("t") === "string" ? (form.get("t") as string) : null);
  const member = await memberFor(token);
  if (!member) return { done: false };
  const via = form.get("List-Unsubscribe") === "One-Click" ? "email_header" : "email";
  await prisma.digestOptOut.upsert({ where: { memberId: member.id }, create: { memberId: member.id, via }, update: {} });
  return { done: true };
}

export default function Unsubscribe({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const { member, token } = loaderData;
  const done = actionData?.done || member?.optedOut;
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="bg-primary-500 px-8 py-7 text-white">
          <AppIcon className="mb-4 h-10 w-10" />
          <h1 className="font-display text-2xl font-bold">Weekly digest</h1>
        </div>
        <div className="space-y-5 p-8 text-sm text-gray-700">
          {!member || actionData?.done === false ? (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">
              <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
              <span>This link is not valid. You can turn the digest off in Growzar's settings instead.</span>
            </div>
          ) : done ? (
            <div className="flex items-start gap-2 rounded-xl border border-mint-200 bg-mint-50 px-4 py-3 text-mint-700">
              <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0" />
              <span>
                {member.email} will no longer get {member.organization}'s weekly digest. You can turn it back on in settings.
              </span>
            </div>
          ) : (
            <Form method="post" className="space-y-4">
              <input type="hidden" name="t" value={token} />
              <p>
                Stop the weekly Growzar digest for <strong>{member.email}</strong> at <strong>{member.organization}</strong>?
              </p>
              <button
                type="submit"
                disabled={navigation.state === "submitting"}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary-500 font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
              >
                <MailX className="h-4 w-4" /> Unsubscribe
              </button>
            </Form>
          )}
          <Link to="/settings/digest" className="block text-center font-semibold text-accent-600 hover:underline">
            Email settings
          </Link>
        </div>
      </div>
    </main>
  );
}
