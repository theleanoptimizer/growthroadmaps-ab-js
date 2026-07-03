/** Sync Growth Roadmaps visitor IDs to Shopify cart attributes for checkout attribution. */

export function syncShopifyCartAttributes(
  visitorId: string,
  sessionId: string,
): void {
  if (typeof window === "undefined" || typeof fetch === "undefined") return;
  const w = window as Window & { Shopify?: unknown };
  if (!w.Shopify) return;

  void fetch("/cart/update.js", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      attributes: {
        _gr_visitor_id: visitorId,
        _gr_session_id: sessionId,
      },
    }),
  }).catch(() => undefined);
}
