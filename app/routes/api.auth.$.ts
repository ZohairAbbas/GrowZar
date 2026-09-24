import { auth } from "~/lib/auth.server";

/**
 * Better Auth's own endpoints, mounted at /api/auth/*.
 *
 * It speaks Fetch `Request`/`Response` natively, so there is nothing to adapt:
 * the magic-link callback, sign-out, the OAuth callback that Google sign-in
 * will use later, and the organization plugin's endpoints all land here.
 */
export async function loader({ request }: { request: Request }) {
  return auth.handler(request);
}

export async function action({ request }: { request: Request }) {
  return auth.handler(request);
}
