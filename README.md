# Nexora

Nexora is an independent, free-first AI API platform in development.

## Day 1 foundation

This repository currently contains:
- A responsive black-and-lime dashboard interface
- Overview, Projects, API Keys, Usage, Logs, Models and Documentation navigation
- A local-only project creation preview
- A small Express server and health endpoint
- A Render deployment blueprint

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Current limitations

This is the first website foundation, not a production API gateway. The project-creation interaction is a browser-only preview and is not saved to an account or database. Authentication, durable storage, real Nexora API-key generation, rate limits, provider connections, model routing and usage accounting have not been implemented yet.

A Nexora API key will be an authentication credential for the Nexora gateway; it does not include free model compute by itself. Actual AI responses require a configured provider or hosted model, and provider quotas and terms apply.

## Deployment

The included `render.yaml` can be used as a starting point for a Render web service. Free hosting may sleep or have usage limits.
