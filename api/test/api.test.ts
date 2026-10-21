import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { RateLimiter } from "../src/rate-limit";
import { AnalysisRunner } from "../src/runner";

const STRIPE_ROUTE = `import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
const stripe = new Stripe("sk");
const prisma = new PrismaClient();
export async function POST(req: Request) {
  const event = stripe.webhooks.constructEvent(await req.text(), req.headers.get("stripe-signature")!, "whsec");
  await prisma.order.create({ data: { id: event.id } });
  return Response.json({ ok: true });
}`;

const SAFE_ROUTE = STRIPE_ROUTE.replace(
  "await prisma.order.create({ data: { id: event.id } });",
  "await prisma.$transaction(async (tx) => {\n    await tx.processedEvent.create({ data: { id: event.id } });\n    await tx.order.create({ data: { id: event.id } });\n  });",
);

const config = loadConfig({ ALLOWED_ORIGINS: "https://retrysafe.dev" });
const post = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/v1/analyze", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("POST /v1/analyze", () => {
  it("analyzes submitted files and returns handlers, effect maps, and findings", async () => {
    const app = createApp(config);
    const res = await post(app, { files: { "app/api/webhooks/stripe/route.ts": STRIPE_ROUTE } });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { handlers: { handler: { name: string } }[]; findings: { rule: string; location: { file: string; line: number } }[] } };
    expect(result.handlers.map((h) => h.handler.name)).toEqual(["POST /api/webhooks/stripe"]);
    expect(result.findings.map((f) => `${f.rule} ${f.location.file}:${f.location.line}`)).toEqual(["unguarded-side-effect app/api/webhooks/stripe/route.ts:7"]);
  });

  it("returns no findings for the transactional pattern, and reads schema files", async () => {
    const app = createApp(config);
    const res = await post(app, {
      files: {
        "app/api/webhooks/stripe/route.ts": SAFE_ROUTE,
        "prisma/schema.prisma": "model ProcessedEvent {\n  id String @id\n}",
      },
    });
    const { result } = (await res.json()) as { result: { findings: unknown[]; handlers: { guards: { schema?: string }[] }[] } };
    expect(result.findings).toEqual([]);
    expect(result.handlers[0]!.guards[0]!.schema).toBe("unique-constraint");
  });

  it("honors tsconfig path aliases across submitted files", async () => {
    const app = createApp(config);
    const res = await post(app, {
      files: {
        "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } }, include: ["**/*.ts"] }),
        "lib/db.ts": `import { PrismaClient } from "@prisma/client";\nexport const db = new PrismaClient();`,
        "app/api/webhooks/x/route.ts": `import { db } from "@/lib/db";\nexport async function POST() {\n  await db.payment.create({ data: {} });\n  return new Response();\n}`,
      },
    });
    const { result } = (await res.json()) as { result: { findings: { rule: string }[] } };
    expect(result.findings.map((f) => f.rule)).toEqual(["unguarded-side-effect"]);
  });

  it("validates input: paths, size, count, and JSON", async () => {
    const app = createApp(loadConfig({ MAX_FILES: "2", MAX_FILE_BYTES: "50" }));
    const bad = async (body: unknown) => ((await (await post(app, body)).json()) as { error: { code: string } }).error.code;
    expect(await bad("{nope")).toBe("invalid_json");
    expect(await bad({ files: {} })).toBe("invalid_request");
    expect(await bad({ files: { "../etc/passwd.ts": "x" } })).toBe("invalid_request");
    expect(await bad({ files: { "/abs.ts": "x" } })).toBe("invalid_request");
    expect(await bad({ files: { "a.exe": "x" } })).toBe("invalid_request");
    expect(await bad({ files: { "a.ts": "x".repeat(51) } })).toBe("invalid_request");
    expect(await bad({ files: { "a.ts": "", "b.ts": "", "c.ts": "" } })).toBe("invalid_request");
    expect(await bad({ files: { "a.ts": "" }, options: { evil: true } })).toBe("invalid_request");
  });

  it("rate limits per client", async () => {
    const app = createApp(config, { limiter: new RateLimiter(1) });
    const body = { files: { "a.ts": "export const x = 1;" } };
    expect((await post(app, body)).status).toBe(200);
    const limited = await post(app, body);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("times out pathological analyses instead of hanging", async () => {
    const app = createApp(config, { runner: new AnalysisRunner(1, 1) });
    const res = await post(app, { files: { "app/api/webhooks/stripe/route.ts": STRIPE_ROUTE } });
    expect(res.status).toBe(504);
  });
});

describe("other endpoints", () => {
  it("serves rule docs", async () => {
    const res = await createApp(config).request("/v1/rules");
    const { rules } = (await res.json()) as { rules: { id: string; summary: string; why: string; safePattern: string }[] };
    expect(rules.length).toBeGreaterThanOrEqual(16);
    expect(rules.find((r) => r.id === "unguarded-side-effect")?.safePattern).toBeTruthy();
  });

  it("allows only configured origins", async () => {
    const app = createApp(config);
    const ok = await app.request("/health", { headers: { origin: "https://retrysafe.dev" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://retrysafe.dev");
    const other = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect((await app.request("/nope")).status).toBe(404);
  });
});
