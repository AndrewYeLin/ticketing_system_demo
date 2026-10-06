# COMP6708 Group 19 — Finance Request Tracker

Academic prototype for COMP6708. This repository is a sanitised course-demo copy of an internal finance request workflow application. It contains synthetic demo identities and reference data only and is not an official PolyU service.

## Current system

- Requester portal for finance requests
- Admin work queue, status transitions and audit history
- File attachments
- Local authentication and role-based access
- CSV storage for a low-cost, single-instance course demo
- REST APIs plus role-aware read-only MCP tools and Admin queue insights
- Logged-in Course Assistant with OpenAI semantic turn-taking, grounded RAG, remote MCP tools, and deterministic fallback

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

1. **Turn-taking** — a deterministic burst/maximum-wait baseline is augmented by OpenAI semantic end-of-turn classification.
2. **RAG** — `lib/knowledgeBase.js` retrieves evidence from synthetic markdown; the chat model may synthesise an answer only from that evidence.
3. **Course Assistant UI** — a logged-in floating chat panel shows WAIT/RESPOND behaviour, RAG sources, and MCP tools used.
4. **MCP** — `/mcp` is a bearer-protected, server-signed role-aware Streamable HTTP endpoint. Requesters see only their accessible tickets; Admin also gets server-computed queue summary, status-filter and bottleneck insight tools. `npm run mcp` remains available for stdio clients.
5. **Fallback** — if OpenAI is unavailable, the original deterministic turn-taking and response paths still work.

See `docs/ASSIGNMENT3_ARCHITECTURE.md` for architecture, demo flow, environment variables, and safety boundaries.

OpenAI secrets and the MCP bearer token belong only in local/Railway environment variables and must never be committed.

Do not place real university operational data, credentials, supplier bank information or real tickets in this course repository.
