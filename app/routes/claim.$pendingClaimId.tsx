import { Form, Link, redirect, useNavigation } from "react-router";
import { AlertCircle, Building2, Clock, Store as StoreIcon } from "lucide-react";

import type { Route } from "./+types/claim.$pendingClaimId";
import { auth } from "~/lib/auth.server";
import { readFormData } from "~/lib/form.server";
import { prisma } from "~/lib/db.server";
import { attachStore, autoConnectApps } from "~/lib/claim.server";
import { scheduleStore } from "~/lib/sync/queue.server";
import { getSession, redirectWithCookies } from "~/lib/session.server";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";

export function meta() {
  return [{ title: "Connect your store · Growzar" }];
}

const APP_LABELS: Record<string, string> = {
  COURIERIFY: "Courierify",
  FINANCIFY: "Financify",
  WHATKABOT: "WhatKaBot",
  PREVENTIFY: "Preventify",
  RETAINIFY: "Retainify",
  INVENTORIFY: "Inventorify",
};

/**
 * The second half of a claim: the shop is proven, and now it needs an
 * organization to belong to.
 *
 * Split from /claim because the person may have no account yet. The token is
 * single-use and lives five minutes; a sign-up round trip outlives it. The
 * PendingClaim row is the continuation, and it proves only what the token
 * proved.
 */
async function loadPendingClaim(pendingClaimId: string) {
  const claim = await prisma.pendingClaim.findUnique({
    where: { id: pendingClaimId },
  });

  if (!claim || claim.consumedAt || claim.expiresAt < new Date()) {
    return null;
  }

  return claim;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const claim = await loadPendingClaim(params.pendingClaimId);

  if (!claim) {
    return { state: "expired" as const };
  }

  const session = await getSession(request);

  if (!session) {
    return {
      state: "signed-out" as const,
      continueTo: `/claim/${claim.id}`,
      shopDomain: claim.shopDomain,
      appLabel: APP_LABELS[claim.app] ?? claim.app,
      email: claim.email,
    };
  }

  const organizations = await auth.api.listOrganizations({
    headers: request.headers,
  });

  const existingStore = await prisma.store.findUnique({
    where: { shopDomain: claim.shopDomain },
    select: { id: true, organizationId: true },
  });

  return {
    state: "ready" as const,
    shopDomain: claim.shopDomain,
    appLabel: APP_LABELS[claim.app] ?? claim.app,
    email: claim.email,
    isStoreOwner: claim.isStoreOwner,
    signedInAs: session.user.email,
    // Several stores per organization, and several organizations per person:
    // pressing the button from another store while signed in offers the list.
    organizations: organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      alreadyHasThisStore: existingStore?.organizationId === organization.id,
    })),
    claimedElsewhere: Boolean(
      existingStore &&
        !organizations.some((o) => o.id === existingStore.organizationId),
    ),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const claim = await loadPendingClaim(params.pendingClaimId);
  if (!claim) {
    return { error: "That link has expired. Press “Open in Growzar” again." };
  }

  const session = await getSession(request);
  if (!session) {
    throw redirect(
      `/auth/sign-up?next=${encodeURIComponent(`/claim/${params.pendingClaimId}`)}`,
    );
  }

  const formData = await readFormData(request);
  const organizationId = String(formData.get("organizationId") ?? "");

  // Membership is re-checked against the database rather than trusted from the
  // form: the organization id arrives from a page anyone can edit.
  const membership = await prisma.member.findFirst({
    where: { organizationId, userId: session.user.id },
    select: { id: true },
  });

  if (!membership) {
    return { error: "Choose an organization you belong to." };
  }

  const outcome = await attachStore({
    organizationId,
    userId: session.user.id,
    app: claim.app,
    shopDomain: claim.shopDomain,
    isStoreOwner: claim.isStoreOwner,
  });

  if (outcome.kind === "not_the_owner") {
    return {
      error:
        "Only the shop's owner can connect it to Growzar the first time. Ask them to press “Open in Growzar”, then they can add you.",
    };
  }

  // The claim is spent either way, so it cannot be replayed against a second
  // organization.
  await prisma.pendingClaim.update({
    where: { id: claim.id },
    data: { consumedAt: new Date() },
  });

  if (outcome.kind === "needs_approval") {
    return {
      pending: true as const,
      shopDomain: claim.shopDomain,
    };
  }

  await prisma.consumedClaimToken.updateMany({
    where: { shopDomain: claim.shopDomain, userId: null, email: claim.email },
    data: { userId: session.user.id, storeId: outcome.storeId },
  });

  // Auto-connect (D-03). Failures here do not fail the claim — the merchant is
  // already in, and the five-minute sync will pick up whatever was unreachable.
  try {
    await autoConnectApps({
      storeId: outcome.storeId,
      shopDomain: claim.shopDomain,
      claimedThroughApp: claim.app,
    });
  } catch (error) {
    console.error("[claim] auto-connect failed", error);
  }

  // Put the store on the sync cycle now. The worker only scheduled at startup,
  // so a store claimed afterwards was never synced until someone happened to
  // restart it — and nothing errors while that is true, the store just sits
  // there empty. The worker's reconcile is the net under this.
  try {
    await scheduleStore(outcome.storeId);
  } catch (error) {
    console.error("[claim] could not schedule the sync cycle", error);
  }

  const activated = await auth.api.setActiveOrganization({
    body: { organizationId },
    headers: request.headers,
    asResponse: true,
  });

  throw redirectWithCookies(activated, `/stores/${outcome.storeId}`);
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
        {children}
      </div>
    </main>
  );
}

export default function ClaimContinue({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();

  // Checked before the expired branch on purpose: answering the claim consumes
  // it, so by the time this renders the loader has already re-run and found
  // nothing. The action's own result is what is true here.
  if (actionData && "pending" in actionData && actionData.pending) {
    return (
      <Shell>
        <div className="p-8">
          <h2 className="text-base font-semibold text-gray-900">
            Waiting for approval
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">
            {actionData.shopDomain} is already connected to another
            organization on Growzar. We have asked them to approve your access;
            nothing changes until they do.
          </p>
          <Link
            to="/"
            className="mt-6 flex h-12 w-full items-center justify-center rounded-xl border-2 border-gray-300 font-semibold text-gray-700 transition hover:bg-gray-50"
          >
            Go to Growzar
          </Link>
        </div>
      </Shell>
    );
  }

  if (loaderData.state === "expired") {
    return (
      <Shell>
        <div className="p-8 text-center">
          <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-50">
            <Clock className="h-7 w-7 text-amber-600" />
          </span>
          <h1 className="text-lg font-semibold text-gray-900">
            That link has expired
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            Press “Open in Growzar” inside your app again for a fresh one.
          </p>
        </div>
      </Shell>
    );
  }

  const header = (
    <div className="bg-primary-500 px-8 py-7 text-white">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-white/10">
        <StoreIcon className="h-6 w-6" />
      </span>
      <h1 className="text-lg font-semibold">{loaderData.shopDomain}</h1>
      <p className="mt-1 text-sm text-gray-300">
        Verified by {loaderData.appLabel}
      </p>
    </div>
  );

  if (loaderData.state === "signed-out") {
    // From the loader, not from `window`: this renders on the server first.
    const next = encodeURIComponent(loaderData.continueTo);
    return (
      <Shell>
        {header}
        <div className="p-8">
          <p className="text-sm leading-relaxed text-gray-600">
            Sign in or create an account and this shop will be connected to it.
            {loaderData.email ? (
              <>
                {" "}
                Your app tells us you are{" "}
                <strong className="text-gray-900">{loaderData.email}</strong>.
              </>
            ) : null}
          </p>
          <div className="mt-6 space-y-3">
            <Link
              to={`/auth/sign-up?next=${next}`}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-primary-500 font-semibold text-white transition hover:bg-primary-600"
            >
              Create an account
            </Link>
            <Link
              to={`/auth/sign-in?next=${next}`}
              className="flex h-12 w-full items-center justify-center rounded-xl border-2 border-gray-300 font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              I already have one
            </Link>
          </div>
        </div>
      </Shell>
    );
  }


  const { organizations, claimedElsewhere, isStoreOwner, signedInAs } = loaderData;

  return (
    <Shell>
      {header}
      <Form method="post" className="p-8">
        {actionData?.error ? (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <span>{actionData.error}</span>
          </div>
        ) : null}

        {claimedElsewhere ? (
          <p className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This store is already connected to another organization. Continuing
            asks them for access rather than moving it.
          </p>
        ) : null}

        {!isStoreOwner && !claimedElsewhere ? (
          <p className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Your app says you are staff on this shop rather than its owner. Only
            the owner can connect it the first time.
          </p>
        ) : null}

        <h2 className="text-sm font-semibold text-gray-900">
          Connect it to which organization?
        </h2>
        <p className="mt-1 text-xs text-gray-500">Signed in as {signedInAs}.</p>

        {organizations.length === 0 ? (
          <div className="mt-4">
            <p className="text-sm text-gray-600">
              You do not have an organization yet.
            </p>
            <Link
              to="/organizations/new"
              className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-500 font-semibold text-white transition hover:bg-primary-600"
            >
              <Building2 className="h-4 w-4" />
              Create one
            </Link>
          </div>
        ) : (
          <>
            <div className="mt-3 space-y-2">
              {organizations.map((organization, index) => (
                <label
                  key={organization.id}
                  className="flex cursor-pointer items-center gap-3 rounded-xl border border-gray-200 p-3 transition hover:bg-gray-50 has-[:checked]:border-accent-500 has-[:checked]:bg-accent-50"
                >
                  <input
                    type="radio"
                    name="organizationId"
                    value={organization.id}
                    defaultChecked={index === 0}
                    className="h-4 w-4"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900">
                      {organization.name}
                    </span>
                    {organization.alreadyHasThisStore ? (
                      <span className="block text-xs text-gray-500">
                        Already has this store
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>

            <button
              type="submit"
              disabled={navigation.state === "submitting"}
              className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-500 font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
            >
              {navigation.state === "submitting" ? (
                <LoadingSpinner size="sm" />
              ) : null}
              <span>Connect this store</span>
            </button>

            <Link
              to="/organizations/new"
              className="mt-3 block text-center text-sm font-medium text-accent-500 hover:text-accent-600"
            >
              Create a new organization instead
            </Link>
          </>
        )}
      </Form>
    </Shell>
  );
}
