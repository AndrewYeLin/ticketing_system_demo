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
Hybrid turn-taking controller
  |-- local burst/max-wait guardrails
  |-- OpenAI semantic EOT -> WAIT / RESPOND
  |
  v
OpenAI Responses API
  |                         \
  v                          v
RAG evidence              Remote MCP
(synthetic docs)          (read-only tracker tools)
  \                         /
   \                       /
    v                     v
      Grounded assistant response
```

The design separates three concerns:

- **Turn-taking = WHEN** the assistant should speak.
- **RAG = KNOWLEDGE** the assistant is allowed to use for finance/process guidance.
- **MCP = ACTION / DATA** the model can read from the synthetic tracker through explicit tools.

## Turn-taking

`/api/assistant/turn` first computes the original deterministic baseline. Hard guardrails remain local: a forced response and the maximum-wait limit never depend on the model. Fresh ordinary fragments stay inside a **2.5-second local message-burst window** to make multi-message turns visible in the live demo while reducing premature replies and unnecessary model calls.

After the burst window, when OpenAI is configured, `gpt-6-luna` performs semantic end-of-turn classification and returns only `WAIT` or `RESPOND`. If the API is unavailable, the deterministic baseline is returned instead.

This makes the rule-based controller a genuine Assignment 2 comparison baseline rather than dead code.

## RAG

`lib/knowledgeBase.js` chunks and ranks the synthetic markdown in `knowledge/`. The selected passages are then supplied to the chat model. The model is instructed not to invent policy facts outside those passages.

Current flow:

```text
user burst -> lexical retrieval -> evidence passages -> OpenAI grounded synthesis
```

The UI shows the retrieved synthetic source headings.

## MCP

Two MCP transports are available:

- `npm run mcp`: standalone stdio server for local MCP clients.
- `/mcp`: bearer-protected Streamable HTTP MCP endpoint used by the OpenAI Responses API.

The remote endpoint is **role-aware**. Every OpenAI MCP call carries a server-signed actor context derived from the current logged-in session; the browser never constructs or receives that MCP credential. Common read-only tools are:

- `search_finance_knowledge`
- `list_demo_requests`
- `get_demo_request`
- `get_demo_request_history`

Requester calls are restricted to that requester's own accessible synthetic requests. Finance Admin additionally receives three aggregate insight tools:

- `get_request_summary` — authoritative total/open/draft/terminal counts plus status, type and waiting-on breakdowns.
- `get_requests_by_status` — safe request summaries for a requested status, including the special `open` view.
- `get_request_bottlenecks` — returned-for-info, waiting-on-user and stale-open indicators.

`open` is defined server-side as non-Draft and non-terminal work; the LLM does not count a truncated request list itself. The remote projections omit requester identity, supplier banking data, attachment metadata, and private internal-note text. The endpoint requires `MCP_SERVER_TOKEN`; it is never exposed to the browser.

Write tools remain deferred. A future `create_request_draft` or `submit_request` must add explicit user confirmation and authorization checks.

## OpenAI integration

The implementation uses the Responses API. Server-side configuration:

```text
LLM_PROVIDER=openai
OPENAI_API_MODE=responses
OPENAI_API_KEY=<secret>
OPENAI_TURN_MODEL=gpt-6-luna
OPENAI_CHAT_MODEL=gpt-6.1-sol
APP_BASE_URL=https://<railway-domain>
MCP_SERVER_TOKEN=<random-secret>
```

No OpenAI credential is sent to browser JavaScript.

## Failure behaviour

The app is intentionally demo-resilient:

1. OpenAI semantic EOT failure -> heuristic WAIT/RESPOND baseline.
2. OpenAI answer/MCP failure -> deterministic RAG or local tracker fallback.
3. Missing MCP configuration -> the model can still answer grounded RAG questions, but cannot use remote tracker tools.

## Suggested 5-minute demo

1. Sign in and open **Course Assistant**.
2. Send a burst: “I need a reimbursement” / “Uber from the airport” / “$46.80” / “and I have two receipts”.
3. Show WAIT behaviour and explain local burst control plus semantic EOT.
4. Ask “What documents do I need for reimbursement?” and show the synthetic RAG source labels.
5. As Finance Admin, ask “How many open requests do we have?” and show `get_request_summary` under **MCP tools used**.
6. Ask for the status of a synthetic `FR-YYYYMMDD-NNN` request to show record-level MCP access.
7. Briefly explain the role boundary, fallback path and that no fine-tuning is used.

## Evaluation ideas

Prepare 15–20 labelled scenarios and compare the heuristic baseline with semantic EOT on:

- end-of-turn accuracy/F1;
- premature response rate;
- added response latency;
- interruption/correction recovery.

The central trade-off is responsiveness versus premature interruption.
