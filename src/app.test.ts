import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "./app.js";
import { EnquiryModel } from "./enquiries/enquiry.model.js";
import type { EnquiryTriager, TriageResult } from "./llm/triage.js";
import type { AppConfig } from "./config/types.js";

/** Fake LLM so the API tests are fast, free and deterministic. */
class FakeTriager implements EnquiryTriager {
  model = "fake-model";
  fail = false;
  async triage({ name }: { name: string; message: string }): Promise<TriageResult> {
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
  await EnquiryModel.deleteMany({});
});

describe("POST /api/enquiries", () => {
  it("saves the enquiry with the LLM reply and tag", async () => {
    const res = await request(app).post("/api/enquiries").send({ name: "Sam", message: "I need 50 units by Friday" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Sam", status: "processed", tag: "hot", reply: "Thanks Sam, we'll be in touch." });
    expect(await EnquiryModel.countDocuments()).toBe(1);
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

  it("still stores the lead when the LLM fails", async () => {
    triager.fail = true;
    const res = await request(app).post("/api/enquiries").send({ name: "Ana", message: "Pricing?" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "failed", tag: null, llmError: "Groq is down" });
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
