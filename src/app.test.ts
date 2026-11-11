import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "./app.js";
import { EnquiryModel } from "./enquiries/enquiry.model.js";
import type { EnquiryTriager, TriageResult } from "./llm/triage.js";
import type { AppConfig } from "./config/types.js";
import { MESSAGES, RETRY } from "./constants.js";

/** Fake LLM so the API tests are fast, free and deterministic. */
class FakeTriager implements EnquiryTriager {
  model = "fake-model";
  fail = false;
  delayMs = 0;
  calls = 0;
  async triage({ name }: { name: string; message: string }): Promise<TriageResult> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error("Groq is down");
    return { reply: `Thanks ${name}, we'll be in touch.`, tag: "hot", reason: "Ready to buy" };
  }
}

const config: AppConfig = {
  http: { trustProxy: 0, bodyLimit: "20kb", corsOrigins: ["https://example.com"] },
  auth: {
    adminUsername: "admin",
    adminPassword: "correct-horse-battery",
    jwtSecret: "test-secret-that-is-at-least-32-characters-long",
    jwtExpiresIn: "1h",
  },
  rateLimit: { submitPerMinute: 1000, loginMaxAttempts: 1000, loginWindowMinutes: 15 },
};
const auth = config.auth;

let mongo: MongoMemoryServer;
const triager = new FakeTriager();
const app = createApp({ config, triager });

async function login() {
  const res = await request(app).post("/api/auth/login").send({ username: "admin", password: auth.adminPassword });
  return res.body.token as string;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  triager.fail = false;
  triager.delayMs = 0;
  triager.calls = 0;
  await EnquiryModel.deleteMany({});
});

describe("POST /api/enquiries", () => {
  it("returns 201 with the reply, and stores the tag internally", async () => {
    const res = await request(app).post("/api/enquiries").send({ name: "Sam", message: "I need 50 units by Friday" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "processed", reply: "Thanks Sam, we'll be in touch.", notice: null });
    // Lead scoring is internal: the customer never sees the tag.
    expect(res.body).not.toHaveProperty("tag");

    const saved = await EnquiryModel.findById(res.body.id).lean();
    expect(saved).toMatchObject({ name: "Sam", tag: "hot", status: "processed" });
  });

  it("rejects invalid input", async () => {
    const res = await request(app).post("/api/enquiries").send({ name: "", message: "hi" });
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe("name");
  });

  it("uses the same message when a field is missing entirely", async () => {
    const res = await request(app).post("/api/enquiries").send({ name: "Sam" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: "message", message: "message is required" }]);
  });

  it("returns 202 with a clear notice when the LLM fails, and still stores the lead", async () => {
    triager.fail = true;
    const res = await request(app).post("/api/enquiries").send({ name: "Ana", message: "Pricing?" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "failed", reply: null, notice: MESSAGES.SUBMIT.REPLY_UNAVAILABLE });
    // The raw provider error is for admins only.
    expect(res.body).not.toHaveProperty("llmError");

    const saved = await EnquiryModel.findById(res.body.id).lean();
    expect(saved).toMatchObject({ status: "failed", llmError: "Groq is down" });
  });
});

describe("CORS", () => {
  it("allows configured origins only", async () => {
    const ok = await request(app).get("/health").set("Origin", "https://example.com");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://example.com");
    const other = await request(app).get("/health").set("Origin", "https://evil.test");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("auth + admin", () => {
  it("rejects bad credentials", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "admin", password: "nope" });
    expect(res.status).toBe(401);
  });

  it("blocks the admin list without a token", async () => {
    expect((await request(app).get("/api/admin/enquiries")).status).toBe(401);
    const bad = await request(app).get("/api/admin/enquiries").set("Authorization", "Bearer garbage");
    expect(bad.status).toBe(401);
  });

  it("lists enquiries with reply and tag, filterable by tag", async () => {
    await request(app).post("/api/enquiries").send({ name: "Sam", message: "Buy now" });
    const token = await login();

    const all = await request(app).get("/api/admin/enquiries").set("Authorization", `Bearer ${token}`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(1);
    expect(all.body.items[0]).toMatchObject({ name: "Sam", tag: "hot", reply: expect.any(String) });

    const cold = await request(app).get("/api/admin/enquiries?tag=cold").set("Authorization", `Bearer ${token}`);
    expect(cold.body.total).toBe(0);
  });

  it("retries a failed enquiry", async () => {
    triager.fail = true;
    const created = await request(app).post("/api/enquiries").send({ name: "Ana", message: "Pricing?" });
    triager.fail = false;

    const token = await login();
    const res = await request(app)
      .post(`/api/admin/enquiries/${created.body.id}/retry`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "processed", tag: "hot", llmError: null });
  });
});

describe("JWT algorithm", () => {
  const listWith = (token: string) => request(app).get("/api/admin/enquiries").set("Authorization", `Bearer ${token}`);

  it("issues HS256 tokens", async () => {
    const token = await login();
    expect(jwt.decode(token, { complete: true })?.header.alg).toBe("HS256");
  });

  it("rejects a token signed with a different algorithm, even with the right secret", async () => {
    const hs512 = jwt.sign({ role: "admin" }, auth.jwtSecret, { algorithm: "HS512" });
    expect((await listWith(hs512)).status).toBe(401);
  });

  it('rejects an unsigned alg "none" token', async () => {
    const none = jwt.sign({ role: "admin" }, null, { algorithm: "none" });
    expect((await listWith(none)).status).toBe(401);
  });
});

describe("retry safety", () => {
  const retry = (id: string, token: string) =>
    request(app).post(`/api/admin/enquiries/${id}/retry`).set("Authorization", `Bearer ${token}`);

  async function createFailed() {
    triager.fail = true;
    const res = await request(app).post("/api/enquiries").send({ name: "Ana", message: "Pricing?" });
    triager.fail = false;
    triager.calls = 0;
    return res.body.id as string;
  }

  it("refuses to retry a processed enquiry and leaves it untouched", async () => {
    const created = await request(app).post("/api/enquiries").send({ name: "Sam", message: "Buy now" });
    const before = await EnquiryModel.findById(created.body.id).lean();
    triager.calls = 0;

    const res = await retry(created.body.id, await login());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(MESSAGES.ERRORS.RETRY_ALREADY_PROCESSED);
    expect(triager.calls).toBe(0);
    expect(await EnquiryModel.findById(created.body.id).lean()).toEqual(before);
  });

  it("lets exactly one of two simultaneous retries run", async () => {
    const id = await createFailed();
    const token = await login();
    triager.delayMs = 100; // keep the first retry in flight while the second arrives

    const results = await Promise.all([retry(id, token), retry(id, token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe(MESSAGES.ERRORS.RETRY_IN_PROGRESS);
    expect(triager.calls).toBe(1);
    expect(await EnquiryModel.findById(id).lean()).toMatchObject({ status: "processed", tag: "hot" });
  });

  it("treats a fresh pending enquiry as in progress, but a stale one as retryable", async () => {
    const token = await login();
    const { insertedId: fresh } = await EnquiryModel.collection.insertOne({
      name: "Fresh", message: "x", status: "pending", createdAt: new Date(), updatedAt: new Date(),
    });
    const old = new Date(Date.now() - RETRY.PENDING_STALE_MS - 1000);
    const { insertedId: stale } = await EnquiryModel.collection.insertOne({
      name: "Stale", message: "x", status: "pending", createdAt: old, updatedAt: old,
    });

    expect((await retry(String(fresh), token)).status).toBe(409);
    const res = await retry(String(stale), token);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processed");
  });

  it("returns 404 for unknown or malformed ids", async () => {
    const token = await login();
    expect((await retry(new mongoose.Types.ObjectId().toString(), token)).status).toBe(404);
    expect((await retry("not-an-id", token)).status).toBe(404);
  });
});
