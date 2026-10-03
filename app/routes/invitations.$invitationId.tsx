import { Form, Link, redirect, useNavigation } from "react-router";
import {
  AlertCircle,
  Building2,
  Check,
  Clock,
  Mail,
  Shield,
  X,
} from "lucide-react";

import type { Route } from "./+types/invitations.$invitationId";
import { auth } from "~/lib/auth.server";
import { readFormData } from "~/lib/form.server";
import {
  getSession,
  readableAuthError,
  redirectWithCookies,
} from "~/lib/session.server";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";
import { RoleBadge } from "~/components/ui/RoleBadge";

export function meta() {
  return [{ title: "Invitation · Growzar" }];
}

/**
 * Ported from salvage/components/invitations/InvitationAcceptance.tsx.
 *
 * The layout carried over; the behaviour did not. The salvaged component never
 * fetched the invitation at all — it rendered "Loading..." as the organization
 * name, a hardcoded `viewer` role badge and a hardcoded "expires in 7 days",
 * then POSTed to /api/invitations/:token/accept, an endpoint the hub did not
 * have. Here the loader reads the real invitation through Better Auth and the
 * page shows the organization, the real role and the real expiry.
 *
 * Signed-out visitors are the common case (the invitation email goes to
 * someone with no account yet), so this route is outside the signed-in shell
 * and offers sign-up with a `next` back to itself.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const session = await getSession(request);
  const invitationId = params.invitationId;

  if (!session) {
    return { state: "signed-out" as const, invitationId };
  }

  try {
    const invitation = await auth.api.getInvitation({
      query: { id: invitationId },
      headers: request.headers,
    });

    return {
      state: "ready" as const,
      invitationId,
      invitation: {
        email: invitation.email,
        role: invitation.role,
        organizationName: invitation.organizationName,
        inviterEmail: invitation.inviterEmail,
        expiresAt: invitation.expiresAt,
      },
      viewerEmail: session.user.email,
    };
  } catch (error) {
    // Better Auth refuses to show an invitation to anyone but its recipient,
    // and refuses expired or already-answered ones. All of those are the same
    // dead end for the person holding the link.
    return {
      state: "unavailable" as const,
      invitationId,
      reason: readableAuthError(
        error,
        "This invitation is no longer available.",
      ),
      viewerEmail: session.user.email,
    };
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const session = await getSession(request);
  if (!session) {
    throw redirect(
      `/auth/sign-in?next=${encodeURIComponent(`/invitations/${params.invitationId}`)}`,
    );
  }

  const formData = await readFormData(request);
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "decline") {
      await auth.api.rejectInvitation({
        body: { invitationId: params.invitationId },
        headers: request.headers,
      });
      throw redirect("/");
    }

    const accepted = await auth.api.acceptInvitation({
      body: { invitationId: params.invitationId },
      headers: request.headers,
    });

    if (accepted?.invitation.organizationId) {
      // Land them inside the organization they just joined, not whichever one
      // happened to be active before. The returned cookie has to travel with
      // the redirect or the session cache keeps the old active organization.
      const activated = await auth.api.setActiveOrganization({
        body: { organizationId: accepted.invitation.organizationId },
        headers: request.headers,
        asResponse: true,
      });
      throw redirectWithCookies(activated, "/");
    }

    throw redirect("/");
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: readableAuthError(error, "Could not answer that invitation.") };
  }
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="bg-primary-500 px-8 py-8 text-center text-white">
          <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/10">
            <Mail className="h-8 w-8" />
          </span>
          <h1 className="font-display text-2xl font-bold">You're invited</h1>
          <p className="mt-1 text-sm text-navy-muted">
            Join an organization on Growzar
          </p>
        </div>
        <div className="p-8">{children}</div>
      </div>
    </main>
  );
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Mail;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-gray-50 p-4">
      <Icon className="mt-0.5 h-5 w-5 flex-shrink-0 text-gray-500" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-700">{label}</p>
        <div className="mt-0.5 text-base text-gray-900">{children}</div>
      </div>
    </div>
  );
}

export default function Invitation({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const submittingIntent = navigation.formData?.get("intent")?.toString() ?? null;

  if (loaderData.state === "signed-out") {
    const next = encodeURIComponent(`/invitations/${loaderData.invitationId}`);
    return (
      <Card>
        <p className="text-sm leading-relaxed text-gray-600">
          Sign in, or create an account with the address this invitation was
          sent to, and we'll bring you straight back here.
        </p>
        <div className="mt-6 space-y-3">
          <Link
            to={`/auth/sign-up?next=${next}`}
            className="flex h-12 w-full items-center justify-center rounded-full bg-primary-500 font-semibold text-white transition hover:bg-primary-600"
          >
            Create an account
          </Link>
          <Link
            to={`/auth/sign-in?next=${next}`}
            className="flex h-12 w-full items-center justify-center rounded-xl border-2 border-gray-300 font-semibold text-gray-700 transition hover:bg-gray-50"
          >
            Sign in
          </Link>
        </div>
      </Card>
    );
  }

  if (loaderData.state === "unavailable") {
    return (
      <Card>
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <span>{loaderData.reason}</span>
        </div>
        <p className="mt-4 text-sm text-gray-600">
          You are signed in as {loaderData.viewerEmail}. If the invitation went
          to a different address, sign in with that one and open the link again.
        </p>
        <Link
          to="/"
          className="mt-6 flex h-12 w-full items-center justify-center rounded-xl border-2 border-gray-300 font-semibold text-gray-700 transition hover:bg-gray-50"
        >
          Go to Growzar
        </Link>
      </Card>
    );
  }

  const { invitation, viewerEmail } = loaderData;
  const wrongAccount =
    invitation.email.toLowerCase() !== viewerEmail.toLowerCase();

  return (
    <Card>
      <div className="space-y-4">
        <Row icon={Building2} label="Organization">
          <span className="truncate font-semibold">
            {invitation.organizationName}
          </span>
        </Row>

        <Row icon={Shield} label="Your role">
          <RoleBadge role={invitation.role} />
        </Row>

        <Row icon={Mail} label="Invited address">
          <span className="truncate">{invitation.email}</span>
        </Row>

        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <Clock className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
          <p className="text-sm font-medium text-amber-800">
            Expires{" "}
            {new Date(invitation.expiresAt).toLocaleDateString(undefined, {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
      </div>

      {wrongAccount ? (
        <div className="mt-6 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <span>
            This invitation was sent to {invitation.email}, but you are signed
            in as {viewerEmail}.
          </span>
        </div>
      ) : null}

      {actionData?.error ? (
        <div className="mt-6 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <span>{actionData.error}</span>
        </div>
      ) : null}

      <Form method="post" className="mt-6 space-y-3">
        <button
          type="submit"
          name="intent"
          value="accept"
          disabled={busy || wrongAccount}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary-500 font-semibold text-white transition hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && submittingIntent === "accept" ? (
            <LoadingSpinner size="sm" />
          ) : (
            <Check className="h-5 w-5" />
          )}
          <span>Accept invitation</span>
        </button>

        <button
          type="submit"
          name="intent"
          value="decline"
          disabled={busy || wrongAccount}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-gray-300 font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && submittingIntent === "decline" ? (
            <LoadingSpinner size="sm" />
          ) : (
            <X className="h-5 w-5" />
          )}
          <span>Decline</span>
        </button>
      </Form>
    </Card>
  );
}
