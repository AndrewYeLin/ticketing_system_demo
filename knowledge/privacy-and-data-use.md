# Synthetic Privacy and Data-Use Notice

> **Academic demo only.** This notice is for the COMP6708 prototype and is **not** an official PolyU privacy notice.

## Course-demo data only

Use synthetic data in this system. Do not enter real credentials, real supplier banking information, confidential operational records, medical information, student records, or other sensitive personal data.

## Assistant context

The assistant can receive the text typed into its chat panel and can use accessible request data to answer status questions. The lexical RAG component searches only the synthetic markdown files committed under `knowledge/`.

## LLM integration

No external LLM is required for the current fallback mode. When an LLM provider is added later, the deployment must clearly document what text is sent to that provider and must keep secrets in environment variables rather than source code.

## Logging

The course demo should avoid logging secrets or full sensitive request payloads. Demonstration data should remain synthetic.
