# Nexora

Nexora is an independent, free-first AI API platform in development.

## Current website features

- Responsive black-and-neon-lime dashboard
- Account registration, sign-in and session handling
- Server-backed project creation, listing, editing and deletion
- Nexora API key generation, listing and revocation
- API key secrets are shown once and stored as hashes
- Render health endpoint and deployment configuration

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Current development status

The account, project and API-key management foundation is implemented. The AI gateway, provider connections, model routing and real usage accounting are still planned work and are not yet available. Nexora API keys are credentials; they do not include model inference or unlimited free compute.

Actual AI responses will require an available provider or hosted model. Free tiers and hosting quotas apply and may change.

## Deployment

The service is configured for automatic deployment from the `main` branch on Render. Free hosting may sleep or have usage limits.
