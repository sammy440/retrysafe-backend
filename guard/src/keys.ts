import { MissingEventIdError } from "./errors";

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

export const eventKey = {
  stripe: (event: { id?: unknown }) => `stripe:${required(event?.id, "Stripe event.id")}`,

  github: (headers: HeadersLike) => `github:${required(header(headers, "x-github-delivery"), "X-GitHub-Delivery header")}`,

  shopify: (headers: HeadersLike) => `shopify:${required(header(headers, "x-shopify-webhook-id"), "X-Shopify-Webhook-Id header")}`,

  svix: (headers: HeadersLike) => `svix:${required(header(headers, "svix-id") ?? header(headers, "webhook-id"), "svix-id / webhook-id header")}`,

  paystack: (body: { event?: unknown; data?: { id?: unknown; reference?: unknown } }) =>
    `paystack:${required(body?.event, "Paystack event name")}:${required(body?.data?.id ?? body?.data?.reference, "Paystack data.id / data.reference")}`,

  flutterwave: (body: { event?: unknown; type?: unknown; data?: { id?: unknown } }) =>
    `flutterwave:${required(body?.event ?? body?.type, "Flutterwave event")}:${required(body?.data?.id, "Flutterwave data.id")}`,

  sqs: (record: { messageId?: unknown; MessageId?: unknown }) => `sqs:${required(record?.messageId ?? record?.MessageId, "SQS messageId")}`,

  job: (queue: string, job: { id?: unknown }) => `job:${queue}:${required(job?.id, "job.id")}`,

  fromHeader: (headers: HeadersLike, name: string, prefix = name) => `${prefix}:${required(header(headers, name), `${name} header`)}`,
};
