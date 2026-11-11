# Lead Handling Backend

A small Node + TypeScript API that takes in customer enquiries, stores them in MongoDB, and uses an LLM (`openai/gpt-oss-120b` on Groq) to write a short reply and tag each lead as **hot**, **warm** or **cold**. A login-protected admin endpoint lists every enquiry with its reply and tag.

## Run it

Requirements: Node 20+, a MongoDB connection string (Atlas free tier or local), and a [Groq API key](https://console.groq.com/keys).

```bash
npm install
cp .env.example .env      # then fill in MONGODB_URI, GROQ_API_KEY, ADMIN_PASSWORD, JWT_SECRET
npm run dev               # watch mode on http://localhost:3000
```

Production build: `npm run build && npm start`. Tests: `npm test`. These use an in-memory MongoDB and a fake LLM, so they don't need any keys. Type check: `npm run typecheck`.

If a required env var is missing, the server refuses to start and lists what's missing.

## Configuration

Everything that changes between deployments is read from `.env`, and nothing deployment-specific lives in code. Only four values are required. The rest have defaults (see [.env.example](.env.example)).

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | **required** | Mongo connection string (`${VAR}` references are expanded) |
| `MONGODB_DB_NAME` | `leads` | Database name, so the URI doesn't need to include it |
| `GROQ_API_KEY` | **required** | Groq API key |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / **required** | Admin login (password min 8 chars) |
| `JWT_SECRET` | **required** | Token signing secret, min 32 chars |
| `JWT_EXPIRES_IN` | `8h` | Token lifetime |
| `BUSINESS_NAME` / `BUSINESS_DESCRIPTION` | `our company` / empty | Who the LLM replies for and what they sell. This is what makes it reusable across businesses |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Any Groq chat model |
| `LLM_TIMEOUT_MS` / `LLM_MAX_RETRIES` | `15000` / `2` | Resilience |
| `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` | `0.3` / `1000` | Output tuning |
| `TRUST_PROXY` | `0` | Set `1` behind Render/Railway/Nginx so rate limits see real client IPs |
| `CORS_ORIGINS` | empty (off) | Comma-separated origins for a website form, or `*` |
| `BODY_LIMIT` | `20kb` | Max request body |
| `SUBMIT_RATE_LIMIT_PER_MINUTE` | `10` | Per-IP submissions |
| `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MINUTES` | `10` / `15` | Brute-force protection |

Data-shape limits (max name/message length, page size) are not deployment config. They live in `LIMITS` in [src/constants.ts](src/constants.ts), which is shared by the DB schema, request validation and LLM output validation, so the three can't drift apart.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/enquiries` | none | Submit `{ name, message }`. `201` with the `reply`, or `202` with a `notice` if the LLM failed (the enquiry is still saved). |
| `POST` | `/api/auth/login` | none | `{ username, password }` → `{ token }` |
| `GET` | `/api/admin/enquiries` | Bearer | List enquiries, newest first. Optional `?tag=hot\|warm\|cold&status=processed\|failed\|pending&page=1&limit=20` |
| `POST` | `/api/admin/enquiries/:id/retry` | Bearer | Re-run the LLM on a `failed` enquiry (or one stuck `pending` for 5+ min). `409` if it's already processed or another retry is in progress |
| `GET` | `/health` | none | Liveness + DB status |

```bash
# submit
curl -X POST localhost:3000/api/enquiries -H "Content-Type: application/json" \
  -d '{"name":"Sara","message":"We need a quote for 200 branded hoodies by end of month."}'

# log in, then list
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<ADMIN_PASSWORD>"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).token")
curl localhost:3000/api/admin/enquiries -H "Authorization: Bearer $TOKEN"
```

Submit responses. The customer sees the reply but not the internal lead tag or the raw provider error:

```jsonc
// 201 Created: saved and replied to
{ "id": "6730...", "status": "processed", "reply": "Hi Sara, thanks for reaching out! ...", "notice": null, "createdAt": "..." }

// 202 Accepted: saved, but the LLM was unavailable. An admin can retry it.
{ "id": "6731...", "status": "failed", "reply": null,
  "notice": "Your enquiry has been received, but we couldn't generate an automatic reply right now. Our team will follow up with you.",
  "createdAt": "..." }
```

The admin list returns the full record: `tag`, `tagReason`, `llmModel`, `llmError` and timestamps.

## Structure

```
src/
  constants.ts            every fixed value: tags/statuses, limits, routes, HTTP codes, messages, prompt text, env defaults
  server.ts               composition root: the only place concrete config + Groq are wired together
  app.ts                  createApp({ config, triager }): middleware + routes, never touches process.env
  db.ts                   mongoose connect/disconnect
  config/
    env.ts                the only file that reads process.env; zod-validated, exits with a clear message
    types.ts              typed config shapes (AppConfig, LlmConfig, ...)
  auth/auth.ts            login route + requireAuth middleware (JWT)
  enquiries/
    enquiry.model.ts      Mongoose schema
    enquiry.service.ts    submit / list / retry business logic
    enquiry.routes.ts     HTTP layer + request validation
  llm/
    triage.ts             provider-agnostic EnquiryTriager interface + output parsing/validation
    prompt.ts             prompt built from business config
    groq.ts               Groq implementation
  http/
    errors.ts             HttpError, 404 and error handler
    rate-limit.ts         shared limiter factory
```

No module contains literal content. Every message, route path, status code, enum value, limit and the full LLM prompt live in [src/constants.ts](src/constants.ts) as typed `as const` objects. Types such as `LeadTag`, `EnquiryStatus` and `HttpStatus` are derived from those objects, so a value and its type can't drift apart. Changing wording, adding a tag, or rewording the prompt is a one-file edit. Tag definitions (`TAG_CRITERIA`) are typed `Record<LeadTag, string>`, so adding a tag without describing it to the LLM is a compile error.

Routes only deal with HTTP. The service holds the logic and depends only on the `EnquiryTriager` interface. To add another provider (OpenAI, Anthropic, Ollama, ...), write one class next to `groq.ts` and pass it in `server.ts`. Nothing else changes. `createApp` takes all its dependencies as arguments, so the tests build it with a fake LLM and an in-memory Mongo.

## Decisions

- **MongoDB + Mongoose.** An enquiry is one self-contained document with no relations, so a document store fits, and Atlas's free tier makes hosting easy. Postgres would have worked just as well.
- **Groq + `openai/gpt-oss-120b`.** I planned to use Llama 3.3 70B, but Groq has retired its Llama chat models (the API returns `model_not_found`). Of the chat models still available, gpt-oss-120b is the strongest. In testing it tagged hot, warm and cold leads correctly, ignored a prompt-injection attempt, and answered in under 2 seconds. Because it's a reasoning model, `LLM_MAX_TOKENS` defaults to 1000 so its thinking doesn't eat into the reply. The model is set by `GROQ_MODEL`, so switching (e.g. to `openai/gpt-oss-20b` for lower cost) needs no code change.
- **One LLM call returns both the reply and the tag**, in JSON mode (`response_format: json_object`), at low temperature. The output is still checked against a zod schema, because JSON mode guarantees valid JSON but not the right fields. If the model wraps the JSON in prose, the parser recovers it.
- **Save first, then call the LLM.** The enquiry is written as `pending` before the LLM runs. If Groq times out or returns bad output, the lead is kept as `failed` with the error, and an admin can retry it. A lead never gets lost because of the LLM.
- **Retries are claimed atomically.** A retry first moves the enquiry from `failed` to `pending` in a single conditional `findOneAndUpdate`. When two retries arrive at once, exactly one wins and the other gets `409`, so the LLM is called once. The result is written only while the enquiry is still `pending`, so a processed enquiry is never overwritten. An enquiry left `pending` by a crash becomes retryable after 5 minutes.
- **Processing is synchronous inside the request.** On Groq this takes about a second, and the caller gets the reply back straight away. At higher volume I'd return `202` and hand the LLM work to a queue (BullMQ/Redis), but that's more than this brief needs.
- **Prompt injection.** The enquiry text is placed inside delimiters and the system prompt tells the model to treat it as data. The model's only output is a reply string and a tag from a fixed list, so the worst a malicious message can do is produce an odd reply or tag.
- **Auth is one admin account set from env, with a JWT.** The brief says "where *I* can log in", so a users collection, sign-up and password hashing would add surface area for nothing. Tokens are signed and verified with HS256 only (other algorithms, including `none`, are rejected). Credentials are compared in constant time, login is rate limited (10 per 15 min), and tokens expire (`JWT_EXPIRES_IN`). Multiple users would mean a `users` collection with bcrypt hashes.
- **Guardrails:** zod validation on every input, length limits, `helmet`, and a per-IP rate limit on submissions (each one costs an LLM call). All of these can be set from env.
- **`TRUST_PROXY` defaults to 0.** Trusting `X-Forwarded-For` when there is no proxy would let clients fake their IP and get around the rate limit, so it's off until you deploy behind one.

## Not done (deliberately)

No frontend, no queue, no user management, no pagination cursors, and no CI pipeline. Each of these is a straightforward addition to the current structure.
