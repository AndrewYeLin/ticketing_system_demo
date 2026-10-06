'use strict';

const DEFAULT_IDLE_MS = Number(process.env.ASSISTANT_IDLE_MS || 2500);
const DEFAULT_MAX_WAIT_MS = Number(process.env.ASSISTANT_MAX_WAIT_MS || 3600);

const EXPLICIT_FINISH = /\b(that'?s all|that is all|i'?m done|i am done|finished|please respond|please answer|go ahead)\b/i;
const CONTINUATION_END = /\b(and|also|because|but|with|for|about|then|so|actually|plus|except)\s*[,.:;-]?\s*$/i;
const QUESTION_START = /^(what|when|where|which|who|why|how|can|could|would|should|is|are|do|does|did|will|may)\b/i;

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: message && message.role === 'assistant' ? 'assistant' : 'user',
      text: String(message && (message.text || message.content) || '').trim(),
      at: Number(message && (message.at || message.timestamp) || 0),
    }))
    .filter((message) => message.text);
}

function decideTurn(input = {}) {
  const messages = normalizeMessages(input.messages);
  const users = messages.filter((message) => message.role === 'user');
  const last = users[users.length - 1];
  const elapsedMs = Math.max(0, Number(input.elapsed_ms ?? input.elapsedMs ?? 0));
  const maxWaitMs = Math.max(500, Number(input.max_wait_ms ?? input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS));
  const idleMs = Math.max(250, Number(input.idle_ms ?? input.idleMs ?? DEFAULT_IDLE_MS));

  if (!last) return { decision: 'WAIT', reason: 'no-user-message', confidence: 1, idle_ms: idleMs, max_wait_ms: maxWaitMs };
  const text = last.text.trim();
  const words = text.split(/\s+/).filter(Boolean);

  if (input.force === true) return { decision: 'RESPOND', reason: 'user-forced', confidence: 1, idle_ms: idleMs, max_wait_ms: maxWaitMs };
  if (elapsedMs >= maxWaitMs) return { decision: 'RESPOND', reason: 'max-wait-reached', confidence: 0.98, idle_ms: idleMs, max_wait_ms: maxWaitMs };
  if (EXPLICIT_FINISH.test(text)) return { decision: 'RESPOND', reason: 'explicit-turn-yield', confidence: 0.98, idle_ms: idleMs, max_wait_ms: maxWaitMs };
  if (/[?]\s*$/.test(text) || QUESTION_START.test(text)) {
    return { decision: 'RESPOND', reason: 'question-signal', confidence: 0.92, idle_ms: idleMs, max_wait_ms: maxWaitMs };
  }
  if (CONTINUATION_END.test(text)) return { decision: 'WAIT', reason: 'continuation-cue', confidence: 0.9, idle_ms: idleMs, max_wait_ms: maxWaitMs };
  if (elapsedMs < idleMs) return { decision: 'WAIT', reason: 'message-burst-window', confidence: 0.86, idle_ms: idleMs, max_wait_ms: maxWaitMs };
  if (words.length <= 4 && !/[.!]\s*$/.test(text)) return { decision: 'WAIT', reason: 'short-fragment', confidence: 0.78, idle_ms: idleMs, max_wait_ms: maxWaitMs };
  if (words.length < 10 && !/[.!]\s*$/.test(text) && users.length < 2) {
    return { decision: 'WAIT', reason: 'possible-incomplete-thought', confidence: 0.66, idle_ms: idleMs, max_wait_ms: maxWaitMs };
  }
  return { decision: 'RESPOND', reason: 'idle-and-semantically-complete', confidence: 0.72, idle_ms: idleMs, max_wait_ms: maxWaitMs };
}

module.exports = { decideTurn, normalizeMessages, DEFAULT_IDLE_MS, DEFAULT_MAX_WAIT_MS };
