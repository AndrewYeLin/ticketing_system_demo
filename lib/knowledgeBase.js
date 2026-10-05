'use strict';

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');
const STOP = new Set([
  'a','an','and','are','as','at','be','by','can','do','for','from','how','i','in','is','it',
  'my','of','on','or','the','this','to','what','when','where','which','with','you','your'
]);

let cached = null;

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token && token.length > 1 && !STOP.has(token));
}

function parseDocument(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  let title = '';
  let section = '';
  const chunks = [];
  let buffer = [];

  function flush() {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (!text) return;
    chunks.push({
      file: path.basename(filePath),
      title: title || path.basename(filePath, '.md').replace(/[-_]+/g, ' '),
      section: section || title || 'Overview',
      text,
    });
  }

  for (const line of lines) {
    if (/^#\s+/.test(line)) {
      flush();
      title = line.replace(/^#\s+/, '').trim();
      section = title;
      continue;
    }
    if (/^##\s+/.test(line)) {
      flush();
      section = line.replace(/^##\s+/, '').trim();
      continue;
    }
    if (/^>\s*/.test(line)) continue;
    if (!line.trim()) {
      flush();
      continue;
    }
    buffer.push(line.replace(/^[-*]\s+/, ''));
  }
  flush();
  return chunks;
}

function loadKnowledge() {
  if (cached) return cached;
  const files = fs.readdirSync(KNOWLEDGE_DIR)
    .filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md')
    .sort();
  cached = files.flatMap((name) => parseDocument(path.join(KNOWLEDGE_DIR, name)));
  return cached;
}

function scoreChunk(chunk, queryTokens) {
  if (!queryTokens.length) return 0;
  const titleTokens = new Set(tokenize(`${chunk.title} ${chunk.section}`));
  const counts = new Map();
  for (const token of tokenize(chunk.text)) counts.set(token, (counts.get(token) || 0) + 1);
  let score = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += 4;
    score += Math.min(3, counts.get(token) || 0);
  }
  const phrase = queryTokens.join(' ');
  if (phrase.length > 4 && chunk.text.toLowerCase().includes(phrase)) score += 4;
  return score;
}

function searchFinanceKnowledge(query, options = {}) {
  const limit = Math.max(1, Math.min(8, Number(options.limit) || 4));
  const tokens = tokenize(query);
  return loadKnowledge()
    .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, tokens) }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
}

function resetKnowledgeCache() { cached = null; }

module.exports = { KNOWLEDGE_DIR, tokenize, loadKnowledge, searchFinanceKnowledge, resetKnowledgeCache };
