# Nexora

Nexora is an independent, free-first AI API workspace and gateway.

## Working features

- Responsive black-and-neon-lime website and account dashboard
- Account registration, sign-in and persistent sessions
- Projects with descriptions, editing and deletion
- Project-linked Nexora API keys with one-time secret display and revocation
- API key authentication using hashed credentials
- OpenAI-compatible text chat endpoint and model listing
- Gemini-first text routing with Groq fallback when Gemini fails
- Per-request usage records and dashboard statistics
- Render health endpoint and deployment configuration

## API

Base URL: `https://nexora-x1tc.onrender.com`

List available models:

```http
GET /v1/models
Authorization: Bearer nx_live_YOUR_NEXORA_KEY
```

Chat completion:

```http
POST /v1/chat/completions
Authorization: Bearer nx_live_YOUR_NEXORA_KEY
Content-Type: application/json

{
  "model": "nexora-text",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ]
}
```

The chat endpoint returns an OpenAI-style `chat.completion` response. Successful requests include an `X-Nexora-Request-Id` response header to help correlate provider attempts in server logs.

## Capability status

- **Text:** connected to configured upstream providers. Nexora tries configured Gemini keys first and then Groq if Gemini attempts fail. Availability depends on provider model access, quotas, rate limits and upstream service health.
- **Images:** endpoint exists but returns `503 provider_not_configured` until a real provider is connected.
- **Video:** endpoint exists but returns `503 provider_not_configured` until a real provider is connected.

Nexora API keys authenticate requests; they do not themselves include AI inference, unlimited usage or free compute. Provider free tiers and hosting quotas apply and may change.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000.

## Deployment

The Render service is configured to deploy from the `main` branch. Free hosting may sleep or have usage limits. Keep provider credentials and the session secret in Render environment variables; never put them in browser code or public repositories.
