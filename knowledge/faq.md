# Synthetic Finance Assistant FAQ

> **Academic demo only.** These answers are written for COMP6708 and are **not** official PolyU advice.

## What can the assistant do?

The current prototype can answer questions from the synthetic knowledge base, explain demo workflow, and read accessible request status. A later LLM version can use the same retrieved evidence.

## Why does the assistant sometimes wait?

The turn-taking layer groups short multi-message bursts. It tries to avoid replying after every fragment, while a maximum-wait rule prevents it from waiting indefinitely.

## Can the assistant submit a request?

The current MCP foundation is intentionally read-only. Write actions such as creating or submitting a request should be added later with explicit confirmation and authorization checks.

## Is this official PolyU policy?

No. All finance guidance in this repository is synthetic course-demo content.

## Can I use real finance data?

No. Use synthetic identities, requests, suppliers, and documents for the course demonstration.
