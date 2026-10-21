import { MissingEventIdError } from "./errors";

/** Fetch `Headers`, Node `IncomingHttpHeaders`, or a plain record. */
export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

export function header(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function required(value: unknown, what: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  throw new MissingEventIdError(what);
}

/**
 * Stable dedupe keys per provider, prefixed with the provider name. Each uses the id that stays the same
 * across redeliveries of one event and differs between events, never the id of the object inside it.
 */
export const eventKey = {
  /** Stripe: the event id (evt_...), not data.object.id. */
  stripe: (event: { id?: unknown }) => `stripe:${required(event?.id, "Stripe event.id")}`,

  /** GitHub: the X-GitHub-Delivery header (a redelivery reuses it). */
  github: (headers: HeadersLike) => `github:${required(header(headers, "x-github-delivery"), "X-GitHub-Delivery header")}`,

  /**
   * Shopify: X-Shopify-Webhook-Id, which identifies one subscription's delivery. Not X-Shopify-Event-Id:
   * that one is shared by every subscription triggered by the same merchant action, so keying on it would
   * let one subscription's handler suppress another's. (https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)
   */
  shopify: (headers: HeadersLike) => `shopify:${required(header(headers, "x-shopify-webhook-id"), "X-Shopify-Webhook-Id header")}`,

  /** Svix / Standard Webhooks senders (Clerk, Resend, ...): the svix-id or webhook-id header. */
  svix: (headers: HeadersLike) => `svix:${required(header(headers, "svix-id") ?? header(headers, "webhook-id"), "svix-id / webhook-id header")}`,

  /**
   * Paystack sends no top-level event id: combine the event name with the transaction id or reference,
   * so `charge.success` and a later `refund.processed` for the same transaction stay distinct.
   */
  paystack: (body: { event?: unknown; data?: { id?: unknown; reference?: unknown } }) =>
    `paystack:${required(body?.event, "Paystack event name")}:${required(body?.data?.id ?? body?.data?.reference, "Paystack data.id / data.reference")}`,

  /** Flutterwave: event type plus data.id (no top-level event id). */
  flutterwave: (body: { event?: unknown; type?: unknown; data?: { id?: unknown } }) =>
    `flutterwave:${required(body?.event ?? body?.type, "Flutterwave event")}:${required(body?.data?.id, "Flutterwave data.id")}`,

  /** SQS: the message id (stable across redeliveries of the same message). */
  sqs: (record: { messageId?: unknown; MessageId?: unknown }) => `sqs:${required(record?.messageId ?? record?.MessageId, "SQS messageId")}`,

  /** BullMQ / Bull: the job id (retries reuse the job). Prefix with the queue name. */
  job: (queue: string, job: { id?: unknown }) => `job:${queue}:${required(job?.id, "job.id")}`,

  /** Any header carrying a delivery id. */
  fromHeader: (headers: HeadersLike, name: string, prefix = name) => `${prefix}:${required(header(headers, name), `${name} header`)}`,
};
