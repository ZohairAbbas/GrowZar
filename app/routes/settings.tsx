import { Form, Link, Outlet } from "react-router";
import { ArrowLeft, LogOut } from "lucide-react";

import type { Route } from "./+types/settings";
import { requireOrganization } from "~/lib/session.server";
import { SettingsNav } from "~/components/settings/SettingsNav";
import { Logo } from "./shell";

/**
 * The settings shell. The full app shell — nine sections, store switcher,
 * locked previews — is G-GZR-6; this is the frame the day-1 screens need and
 * nothing more.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { session } = await requireOrganization(request);
  return {
    user: { name: session.user.name, email: session.user.email },
  };
}

export default function SettingsLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="min-h-screen bg-field p-3 md:p-4">
      <header className="mx-auto max-w-6xl rounded-2xl bg-white">
        <div className="flex items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-center gap-4">
            <Link to="/home" className="flex items-center gap-2.5">
              <Logo />
            </Link>
            <Link
              to="/home"
              className="hidden items-center gap-1.5 rounded-full bg-field px-3.5 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100 sm:flex"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Home
            </Link>
          </div>

          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-gray-600 sm:inline">
              {loaderData.user.email}
            </span>
            <Form method="post" action="/auth/sign-out">
              <button
                type="submit"
                className="flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium text-gray-600 transition hover:bg-field hover:text-gray-900"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </Form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl gap-5 py-5 md:flex">
        <aside className="mb-5 self-start rounded-2xl bg-white p-3 md:mb-0 md:w-64 md:flex-shrink-0">
          <SettingsNav />
        </aside>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
