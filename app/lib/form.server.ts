/**
 * Read a form body without turning a malformed request into a 500.
 *
 * `request.formData()` throws when the body is absent or not form-encoded — a
 * POST with no body at all, or one sent as JSON. Every action that called it
 * directly answered such a request with a 500, which is both wrong (the fault
 * is the caller's) and noisy (it logs as a server error and pages whoever is
 * watching).
 *
 * Found by the Courierify instance against `/claim`. Their description was
 * "500 when it gets no token", but a form-encoded POST *without* a token is
 * handled correctly — the throw happens before any field is read, so it is the
 * body's shape that matters, not its contents. Which means it was never
 * specific to `/claim`: every action in the app had it.
 *
 * A thrown 400 rather than a returned error, so call sites need no new
 * branches and cannot forget to handle it.
 */
export async function readFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new Response("Expected a form-encoded body.", {
      status: 400,
      statusText: "Bad Request",
    });
  }
}
