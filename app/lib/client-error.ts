/**
 * A crash in the browser, sent to the server log so "the error has been
 * logged" is true (found 2026-10-19: Ask crashed for pilot users and nothing
 * on the server said why). Best effort: a beacon, never retried, never shown.
 */
export function reportClientError(error: unknown) {
  if (typeof window === "undefined") return;
  try {
    const e = error instanceof Error ? error : null;
    const body = JSON.stringify({
      message: (e?.message ?? String(error)).slice(0, 2_000),
      stack: (e?.stack ?? "").slice(0, 6_000),
      url: window.location.pathname + window.location.search,
      userAgent: navigator.userAgent.slice(0, 300),
    });
    navigator.sendBeacon?.("/api/client-error", new Blob([body], { type: "application/json" }));
  } catch {
    // Reporting must never be what breaks the page.
  }
}
