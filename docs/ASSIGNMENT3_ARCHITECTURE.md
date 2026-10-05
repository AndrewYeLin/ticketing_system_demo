# COMP6708 Assignment 3 — Conversational Finance Assistant Architecture

This repository is an **academic prototype**. The finance content under `knowledge/` is synthetic and is not official PolyU policy.

## Core design

```text
User
  |
  v
Chat UI
  |
  v
Turn-taking controller -----> WAIT / RESPOND
  |
  v
Assistant orchestration
  |                     \
  v                      v
RAG knowledge          MCP tools
(synthetic docs)       (tracker data/actions)
  \                      /
   \                    /
    v                  v
      Finance Request Tracker
```

The design separates three concerns:

- **Turn-taking = WHEN** the assistant should speak. It reduces premature replies during multi-message user bursts.
- **RAG = KNOWLEDGE** the assistant is allowed to use. The current retriever searches only synthetic course-demo markdown files.
- **MCP = ACTION / DATA** the assistant can access in the tracker. The first MCP server is intentionally read-only.

## Current training-free fallback

No external LLM is required to run the app.

The browser sends each user message to `/api/assistant/turn`. A deterministic controller uses question signals, explicit turn-yield phrases, continuation cues, short fragments, an inactivity window, and a maximum wait. The result is `WAIT` or `RESPOND`.

When the system responds, `/api/assistant/respond` either reads an accessible request ID such as `FR-20261005-001`, or retrieves relevant passages from the synthetic knowledge base.

This is deliberately a baseline. Assignment 2 can compare such rules with LLM-based end-of-turn prediction.

## RAG

`lib/knowledgeBase.js` loads and chunks markdown from `knowledge/`, tokenises the query and ranks chunks lexically. No embeddings or external model are used yet.

Later LLM flow:

```text
question -> retrieve top chunks -> prompt LLM with chunks -> cited answer
```

## MCP

Run the standalone MCP server with:

```bash
npm run mcp
```

Initial read-only tools:

- `search_finance_knowledge`
- `list_requests`
- `get_request`
- `get_request_history`

Knowledge search works without credentials. Ticket tools require `APP_BASE_URL`, `MCP_DEMO_EMAIL`, and `MCP_DEMO_PASSWORD`.

Write tools are intentionally deferred. They should require explicit confirmation and authorization checks.

## Future LLM integration

The current deployment can run with `LLM_PROVIDER=none`. When a provider is chosen, add a server-side provider adapter for semantic EOT classification, grounded RAG answer generation, MCP tool selection, and streaming/cancellation. Keep API keys only in environment variables.

## Suggested 5-minute demo

1. Sign in to the deployed tracker.
2. Open **Course Assistant**.
3. Send a burst: “I need a reimbursement” / “Uber from the airport” / “$46.80” / “and I have two receipts”.
4. Show WAIT behaviour rather than a reply after every fragment.
5. Ask “What documents do I need for reimbursement?” and show synthetic RAG evidence.
6. Ask for the status of an accessible synthetic FR request ID.
7. Explain the MCP tools and future LLM provider adapter.

## Evaluation ideas

Prepare 15–20 labelled scenarios and report end-of-turn accuracy/F1, premature response rate, added response latency, and interruption/correction recovery.
