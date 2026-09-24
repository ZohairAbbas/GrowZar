import { Form, Link, useNavigation } from "react-router";
import { AlertCircle, Check, Clock, Send, Users, X } from "lucide-react";

import type { Route } from "./+types/settings.team";
import { auth } from "~/lib/auth.server";
import { canSendEmail } from "~/lib/env.server";
import { prisma } from "~/lib/db.server";
import { Forbidden, can, requireSection } from "~/lib/authorize.server";
import { readableAuthError } from "~/lib/session.server";
import { INVITABLE_ROLES, ROLE_LABELS } from "~/lib/permissions";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";
import { RoleBadge } from "~/components/ui/RoleBadge";

export function meta() {
  return [{ title: "Team · Growzar" }];
}

/**
 * Ported from salvage/components/settings/{InviteMemberForm, TeamMembersList,
 * PendingInvitations}.tsx, rewired to Better Auth and merged into one route.
 *
 * The salvaged InviteMemberForm fetched /api/roles on mount to fill its select.
 * Growzar's roles are a compile-time list (app/lib/permissions.ts), so the
 * round trip is gone; the organization's custom roles join that list in
 * G-GZR-2, at which point the loader supplies them.
 *
 * The salvaged version also reported "Invitation sent" on any 2xx, whether or
 * not the email left the building. This one says which of the two happened,
 * because on a box with no Resend key the difference is the whole story.
 */
export async function loader({ request }: Route.LoaderArgs) {
  // The page itself is a Settings view; the two things it can *do* are checked
  // separately below, because a manager may invite without being able to
  // manage the team.
  const viewer = await requireSection(request, "settings", "view");
  const organizationId = viewer.organizationId;

  const organization = await auth.api.getFullOrganization({
    query: { organizationId },
    headers: request.headers,
  });

  const invitations = await auth.api.listInvitations({
    query: { organizationId },
    headers: request.headers,
  });

  const [canManageTeam, canInvite] = await Promise.all([
    can(request, organizationId, { member: ["update"] }),
    can(request, organizationId, { invitation: ["create"] }),
  ]);

  const scopes = await prisma.memberStoreScope.groupBy({
    by: ["memberId"],
    where: { member: { organizationId } },
    _count: { storeId: true },
  });
  const scopeCounts = new Map(scopes.map((row) => [row.memberId, row._count.storeId]));

  const scopeFlags = await prisma.member.findMany({
    where: { organizationId },
    select: { id: true, scopeAllStores: true },
  });
  const allStoresById = new Map(
    scopeFlags.map((row) => [row.id, row.scopeAllStores !== false]),
  );

  return {
    canManageTeam,
    canInvite,
    members: (organization?.members ?? []).map((member) => ({
      id: member.id,
      role: member.role,
      name: member.user.name,
      email: member.user.email,
      createdAt: member.createdAt,
      isViewer: member.id === viewer.memberId,
      allStores: allStoresById.get(member.id) ?? true,
      scopedStoreCount: scopeCounts.get(member.id) ?? 0,
    })),
    pending: invitations
      .filter((invitation) => invitation.status === "pending")
      .map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role ?? "staff",
        expiresAt: invitation.expiresAt,
      })),
    viewerRole: viewer.role,
    emailConfigured: canSendEmail,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const viewer = await requireSection(request, "settings", "view");
  const organizationId = viewer.organizationId;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  // Every branch re-checks the permission it needs. The loader's answer
  // decided what to render; it cannot be trusted to decide what to execute,
  // because a form can be posted without ever loading the page.
  const needed: Record<string, string[]> =
    intent === "invite"
      ? { invitation: ["create"] }
      : intent === "cancel-invitation"
        ? { invitation: ["cancel"] }
        : { member: ["delete"] };

  if (!(await can(request, organizationId, needed))) {
    throw new Forbidden("Your role does not allow that.");
  }

  try {
    if (intent === "cancel-invitation") {
      await auth.api.cancelInvitation({
        body: { invitationId: String(formData.get("invitationId") ?? "") },
        headers: request.headers,
      });
      return { ok: "Invitation cancelled." };
    }

    if (intent === "remove-member") {
      await auth.api.removeMember({
        body: {
          memberIdOrEmail: String(formData.get("memberId") ?? ""),
          organizationId,
        },
        headers: request.headers,
      });
      return { ok: "Member removed." };
    }

    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const role = String(formData.get("role") ?? "");

    if (!email) {
      return { error: "Enter an email address to invite." };
    }
    if (!INVITABLE_ROLES.includes(role as (typeof INVITABLE_ROLES)[number])) {
      return { error: "Choose a role for the invitation." };
    }

    await auth.api.createInvitation({
      body: { email, role: role as "admin" | "manager" | "staff", organizationId },
      headers: request.headers,
    });

    return {
      ok: canSendEmail
        ? `Invitation sent to ${email}.`
        : `Invitation created for ${email}, but no email was sent — RESEND_API_KEY is empty. The link is in the server log.`,
    };
  } catch (error) {
    return { error: readableAuthError(error, "That did not work.") };
  }
}

export default function TeamSettings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  // Both come from the loader's permission check, so a custom role gets the
  // same answer a built-in one does. Neither is the enforcement — the action
  // re-checks — they only decide what is worth rendering.
  const { members, pending, emailConfigured, canManageTeam, canInvite } =
    loaderData;
  const submittingIntent = navigation.formData?.get("intent")?.toString() ?? null;

  return (
    <div className="space-y-6">
      {actionData?.error ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <span>{actionData.error}</span>
        </div>
      ) : null}

      {actionData && "ok" in actionData && actionData.ok ? (
        <div className="flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          <Check className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <span>{actionData.ok}</span>
        </div>
      ) : null}

      {canInvite ? (
        <section className="rounded-2xl border border-gray-200 bg-white p-6">
          <h1 className="text-lg font-semibold text-gray-900">Invite someone</h1>
          <p className="mt-1 text-sm text-gray-600">
            They get an email with a link that expires in 7 days.
          </p>

          {!emailConfigured ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              RESEND_API_KEY is empty on this host, so invitations are created
              but not emailed. The link is written to the server log instead.
            </p>
          ) : null}

          <Form method="post" className="mt-5 flex flex-col gap-3 sm:flex-row">
            <input type="hidden" name="intent" value="invite" />

            <input
              name="email"
              type="email"
              required
              placeholder="colleague@company.pk"
              className="h-12 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
            />

            <select
              name="role"
              required
              defaultValue="staff"
              className="h-12 rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
            >
              {INVITABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role].label}
                </option>
              ))}
            </select>

            <button
              type="submit"
              disabled={navigation.state === "submitting"}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary-500 px-6 font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
            >
              {submittingIntent === "invite" ? (
                <LoadingSpinner size="sm" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              <span>Invite</span>
            </button>
          </Form>

          <dl className="mt-4 space-y-1">
            {INVITABLE_ROLES.map((role) => (
              <div key={role} className="flex gap-2 text-xs text-gray-500">
                <dt className="font-semibold text-gray-700">
                  {ROLE_LABELS[role].label}
                </dt>
                <dd>{ROLE_LABELS[role].description}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {pending.length > 0 ? (
        <section className="rounded-2xl border border-gray-200 bg-white p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <Clock className="h-5 w-5 text-gray-400" />
            Pending invitations
          </h2>

          <ul className="mt-4 divide-y divide-gray-100">
            {pending.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">
                    {invitation.email}
                  </p>
                  <p className="text-xs text-gray-500">
                    Expires{" "}
                    {new Date(invitation.expiresAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <RoleBadge role={invitation.role} />
                  {canManageTeam ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="cancel-invitation" />
                      <input type="hidden" name="invitationId" value={invitation.id} />
                      <button
                        type="submit"
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-500 transition hover:bg-red-50 hover:text-red-600"
                      >
                        <X className="h-3.5 w-3.5" />
                        Cancel
                      </button>
                    </Form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-2xl border border-gray-200 bg-white p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
          <Users className="h-5 w-5 text-gray-400" />
          Members
        </h2>

        <ul className="mt-4 divide-y divide-gray-100">
          {members.map((member) => (
            <li
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900">
                  {member.name}
                  {member.isViewer ? (
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      you
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-gray-500">{member.email}</p>
                <p className="mt-0.5 truncate text-xs text-gray-500">
                  {member.allStores
                    ? "All stores"
                    : member.scopedStoreCount === 0
                      ? "No stores"
                      : `${member.scopedStoreCount} ${
                          member.scopedStoreCount === 1 ? "store" : "stores"
                        }`}
                </p>
              </div>

              <div className="flex items-center gap-3">
                <RoleBadge role={member.role} />
                {canManageTeam ? (
                  <Link
                    to={`/settings/team/${member.id}`}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-accent-600 transition hover:bg-accent-50"
                  >
                    Role &amp; stores
                  </Link>
                ) : null}
                {canManageTeam && !member.isViewer && member.role !== "owner" ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="remove-member" />
                    <input type="hidden" name="memberId" value={member.id} />
                    <button
                      type="submit"
                      className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-500 transition hover:bg-red-50 hover:text-red-600"
                    >
                      <X className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  </Form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
