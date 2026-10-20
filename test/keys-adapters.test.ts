import { describe, expect, it, vi } from "vitest";
import { MissingEventIdError, eventKey, memoryGuard, withGuard, withGuardJob, withGuardRoute } from "../src";

describe("eventKey", () => {
  it("uses each provider's delivery-stable id", () => {
    expect(eventKey.stripe({ id: "evt_1" })).toBe("stripe:evt_1");
    expect(eventKey.github(new Headers({ "X-GitHub-Delivery": "abc" }))).toBe("github:abc");
    expect(eventKey.shopify({ "x-shopify-webhook-id": "w1", "x-shopify-event-id": "e1" })).toBe("shopify:w1");
    expect(eventKey.svix({ "webhook-id": "msg_1" })).toBe("svix:msg_1");
    expect(eventKey.paystack({ event: "charge.success", data: { id: 42 } })).toBe("paystack:charge.success:42");
    expect(eventKey.flutterwave({ event: "charge.completed", data: { id: 7 } })).toBe("flutterwave:charge.completed:7");
    expect(eventKey.sqs({ messageId: "m1" })).toBe("sqs:m1");
    expect(eventKey.job("emails", { id: "9" })).toBe("job:emails:9");
    expect(eventKey.fromHeader({ "X-Delivery": ["d1"] }, "x-delivery", "acme")).toBe("acme:d1");
  });

  it("refuses to invent a key when the id is missing", () => {
    expect(() => eventKey.stripe({})).toThrow(MissingEventIdError);
    expect(() => eventKey.github({})).toThrow(/X-GitHub-Delivery/);
    expect(() => eventKey.paystack({ event: "charge.success", data: {} })).toThrow(MissingEventIdError);
  });
});

function res() {
  const r = { headersSent: false, code: 0, status: vi.fn((c: number) => ((r.code = c), r)), end: vi.fn(() => ((r.headersSent = true), r)) };
  return r;
}

describe("adapters", () => {
  it("withGuard: duplicate gets 200, the handler's own response is kept, errors go to next()", async () => {
    const guard = memoryGuard();
    const h = withGuard(guard, (req: { id: string }) => req.id, async (_req, r: ReturnType<typeof res>) => {
      r.status(201).end();
    });
    const first = res();
    await h({ id: "e1" }, first);
    expect(first.code).toBe(201);
    const dup = res();
    await h({ id: "e1" }, dup);
    expect(dup.code).toBe(200);

    const next = vi.fn();
    await withGuard(guard, () => "e2", async () => Promise.reject(new Error("x")))({}, res(), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it("withGuardRoute: reads the key from a clone and answers duplicates without running the handler", async () => {
    const guard = memoryGuard();
    const handler = vi.fn(async (req: Request) => Response.json(await req.json(), { status: 202 }));
    const route = withGuardRoute(guard, async (req) => `evt:${((await req.json()) as { id: string }).id}`, handler);
    const make = () => new Request("http://x/hook", { method: "POST", body: JSON.stringify({ id: "1" }) });
    expect((await route(make())).status).toBe(202);
    expect((await route(make())).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("withGuardJob: completes duplicates quietly and throws while another worker holds the job", async () => {
    let release!: () => void;
    const guard = memoryGuard();
    const job = withGuardJob(guard, (j: { id: string }) => `job:${j.id}`, async () => new Promise<string>((r) => (release = () => r("done"))));
    const first = job({ id: "1" });
    await new Promise((r) => setTimeout(r, 5));
    await expect(job({ id: "1" })).rejects.toThrow(/another worker/);
    release();
    expect(await first).toBe("done");
    expect(await job({ id: "1" })).toBeUndefined();
  });
});
