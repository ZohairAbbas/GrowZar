import { redirect } from "react-router";

import type { Route } from "./+types/auth.sign-out";
import { auth } from "~/lib/auth.server";
import { redirectWithCookies } from "~/lib/session.server";

/**
 * POST only. A GET sign-out is a link anyone can put in an <img> tag and log a
 * merchant out mid-shift, so the header posts a form here instead.
 */
export async function action({ request }: Route.ActionArgs) {
  const response = await auth.api.signOut({
    headers: request.headers,
    asResponse: true,
  });
  return redirectWithCookies(response, "/auth/sign-in");
}

export async function loader() {
  return redirect("/");
}
