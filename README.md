# COMP6708 Group 19 — Finance Request Tracker

Academic prototype for COMP6708. This repository is a sanitised course-demo copy of an internal finance request workflow application. It contains synthetic demo identities and reference data only and is not an official PolyU service.

## Current system

- Requester portal for finance requests
- Admin work queue, status transitions and audit history
- File attachments
- Local authentication and role-based access
- CSV storage for a low-cost, single-instance course demo
- REST APIs plus a standalone MCP read-only tool server
- Logged-in Course Assistant with training-free turn-taking and lexical RAG fallback

## Local run

1. Copy .env.example to .env.
2. Set SESSION_SECRET, DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD.
3. Run npm ci.
4. Run npm run start:demo.
5. Open http://localhost:3000.

## Railway

Deploy with the included Dockerfile. Add a persistent volume mounted at /app/persist.

Required variables:
- SESSION_SECRET
- DEMO_ADMIN_EMAIL
- DEMO_ADMIN_PASSWORD
- DEMO_MODE=true
- STORAGE=csv
- REGISTRATION_ALLOWED_DOMAINS=connect.polyu.hk,polyu.edu.hk

After Railway creates the public domain, optionally set APP_BASE_URL to that HTTPS URL.

## Assignment 3 foundation

The repository now includes:

1. **Turn-taking** — `/api/assistant/turn` decides `WAIT` or `RESPOND` for text message bursts using a training-free heuristic baseline.
2. **RAG** — `lib/knowledgeBase.js` retrieves evidence from synthetic markdown under `knowledge/`.
3. **Course Assistant UI** — a logged-in floating chat panel demonstrates multi-message waiting, RAG answers and live synthetic request-status lookup.
4. **MCP** — `npm run mcp` starts a genuine standalone MCP stdio server with read-only knowledge and ticket tools.

See `docs/ASSIGNMENT3_ARCHITECTURE.md` for the architecture, demo flow and later LLM integration points.

The current web assistant deliberately works without an external LLM. When a provider is selected, add the API key only through local/Railway environment variables.

Do not place real university operational data, credentials, supplier bank information or real tickets in this course repository.
