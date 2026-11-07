# Nexora

Nexora is a free-first AI API workspace and gateway. It provides project-linked API keys and OpenAI-style endpoints for text and image generation.

## Current capabilities

- Account registration and sign-in
- Projects with descriptions
- Project-linked API keys with one-time secret display and revocation
- Separate **Text** and **Image** key capabilities
- Hashed API-key storage (the raw key is shown only when created)
- OpenAI-compatible text chat endpoint and model listing
- Text routing: configured Gemini keys are tried first; Groq is used as a fallback when configured
- Image generation through a configured OpenAI-compatible upstream provider
- Per-request usage records and dashboard statistics
- Render health endpoint

Video generation is **not configured yet**. The video endpoint currently returns `503 provider_not_configured`; video is planned for a later stage.

## Base URL

```text
https://nexora-x1tc.onrender.com
```

## Create an API key

1. Sign in to the Nexora dashboard.
2. Create or select a project.
3. Open API Keys and create a key.
4. Choose **Text** for chat/model requests or **Image** for image generation.
5. Copy the secret when it is displayed. Nexora stores a hash, so the full secret cannot be displayed again. If it is lost, revoke it and create another key.
6. Keep the key on your server or in a secure secret manager. Do not put it in public frontend code, source control, screenshots, or public repositories.

All public API requests use this header:

```http
Authorization: Bearer nx_live_YOUR_NEXORA_KEY
```

Use a Text key for `/v1/models` and `/v1/chat/completions`. Use an Image key for `/v1/images/generations`. Using the wrong capability returns `403 key_capability_mismatch`.

## Text API

### List available models

```http
GET /v1/models
Authorization: Bearer nx_live_YOUR_TEXT_KEY
```

The response lists `nexora-text` when at least one text provider is configured. Actual availability depends on upstream provider access, quotas, rate limits and service health.

### Chat completion

```http
POST /v1/chat/completions
Authorization: Bearer nx_live_YOUR_TEXT_KEY
Content-Type: application/json

{
  "model": "nexora-text",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ]
}
```

The response uses an OpenAI-style `chat.completion` shape. Supported message roles are `system`, `user`, and `assistant`. You can also send a non-empty `prompt`. Optional `temperature` is clamped to 0–2 and `max_tokens` to 1–8192.

Nexora tries configured Gemini API keys first, then the configured Groq provider if Gemini attempts fail. Provider credentials and model names are configured on the server, never in client code.

Successful chat responses include an `X-Nexora-Request-Id` header for support and log correlation.

## Image API

Image generation requires an Image-capability Nexora key and a configured OpenAI-compatible upstream image provider.

### Generate an image

```http
POST /v1/images/generations
Authorization: Bearer nx_live_YOUR_IMAGE_KEY
Content-Type: application/json

{
  "model": "nexora-image",
  "prompt": "A small red cabin in a snowy forest",
  "n": 1,
  "size": "1024x1024",
  "response_format": "url"
}
```

- `prompt` is required and may contain up to 4,000 characters.
- `n` is optional and must be between 1 and 4 (default: 1).
- `size` is optional and must look like `1024x1024` (default: `1024x1024`).
- `response_format` may be `url` (default) or `b64_json`.

The upstream must accept `POST /images/generations` with Bearer authentication and return OpenAI-style `data` items containing `url` or `b64_json`.

### Server-side image provider configuration

Set these environment variables on the Nexora server (for example, in Render):

- `IMAGE_API_BASE_URL` — upstream OpenAI-compatible API base URL, without the `/images/generations` suffix
- `IMAGE_API_KEY` — upstream provider credential
- `IMAGE_MODEL` — model name accepted by that provider

Never expose `IMAGE_API_KEY` in browser code or commit it to GitHub. Provider pricing, credits, quotas, model availability and terms apply.

## Usage tracking

The Nexora dashboard records API requests and shows summary statistics and recent activity. The signed-in dashboard endpoint is:

```http
GET /api/usage
```

It uses the account's browser session cookie; it is not a public Nexora-key endpoint. Recorded fields include capability, endpoint, model, HTTP status, provider, duration and timestamp. Usage records are created for authenticated gateway requests, including validation and provider failures.

## Error responses

Errors are returned as JSON. Most gateway errors use this shape:

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "A valid Nexora bearer API key is required."
  }
}
```

Common HTTP statuses and codes:

| HTTP status | Error code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Missing or invalid request fields |
| 401 | `invalid_api_key` | Missing, malformed, unknown or revoked Nexora key |
| 403 | `key_capability_mismatch` | Key does not have permission for this endpoint |
| 429 | `provider_rate_limited` | Configured upstream provider is rate-limiting requests |
| 502 | `provider_error` / `invalid_provider_response` | Upstream rejected the request or returned an unsupported response |
| 503 | `provider_not_configured` / `provider_unavailable` / `gateway_unavailable` | Provider is not configured, unreachable, or gateway service is unavailable |
| 504 | `provider_timeout` | Upstream provider did not respond in time |

A `404 not_found` response means the Nexora API route does not exist. Account and dashboard routes may return their own simpler error format.

## Health check

```http
GET /api/health
```

This reports service, database and capability configuration status. It does not guarantee that an upstream provider will accept a generation request.

## Run locally

Requires Node.js 20 or newer and a PostgreSQL database configured through `DATABASE_URL`.

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deployment and security

The Render service deploys from the `main` branch. Free hosting may sleep or have usage limits. Keep `SESSION_SECRET`, database credentials, and all upstream provider API keys in server-side environment variables. Never put secrets in browser code or public repositories.

## Important limits

Nexora API keys authenticate requests; they do not include inference compute, unlimited usage or free provider access. Text and image generation depend on configured upstream providers, their pricing, free tiers, quotas, rate limits and service availability. Render hosting and database plans also have limits.
