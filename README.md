# COMP6708 Group 19 — Finance Request Tracker

Academic prototype for COMP6708. This repository is a sanitised course-demo copy of an internal finance request workflow application. It contains synthetic demo identities and reference data only and is not an official PolyU service.

## Current system

- Requester portal for finance requests
- Admin work queue, status transitions and audit history
- File attachments
- Local authentication and role-based access
- CSV storage for a low-cost, single-instance course demo
- REST APIs that can later be exposed as MCP tools
- Planned chat layer for Assignment 2/3 work on textual turn-taking, RAG and MCP

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

## Assignment 3 direction

The existing REST API is intentionally retained so the next layer can add:
1. Turn-taking logic — decide whether to respond now or wait for more user messages.
2. RAG — answer finance/policy questions from a small demo knowledge base.
3. MCP — expose tools such as get_request, create_request, submit_request, and get_request_history.

Do not place real university operational data, credentials, supplier bank information or real tickets in this course repository.
