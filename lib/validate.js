'use strict';

// Pure, dependency-free field validators shared by create and update.
//
// Each validator returns `null` when the value is acceptable, or a human-readable
// error string when it is not. They never throw and never touch I/O, so they are
// trivial to unit-test and to reuse from new request types / fields.
//
// Callers (lib/store.js) collect these into a { field: message } map and raise a
// single StoreError carrying all field errors, so the API can report every problem
// at once instead of one-at-a-time.

// Strict YYYY-MM-DD that must also be a real calendar date (rejects 2026-02-31).
function validateDate(value) {
  const s = String(value == null ? '' : value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return 'must be a valid date in YYYY-MM-DD format';
  const [, y, mo, d] = m.map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return `is not a real calendar date: ${s}`;
  }
  return null;
}

// Amount: finite number, >= 0, at most 2 decimal places. Accepts the string form
// the API/CSV uses. Rejects blanks here — presence is enforced separately.
function validateAmount(value) {
  const s = String(value == null ? '' : value).trim();
  if (s === '') return 'is required';
  // Disallow thousands separators / currency symbols / exponents — keep it strict.
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    return 'must be a number with at most 2 decimal places (no symbols or separators)';
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return 'must be a finite number';
  if (n < 0) return 'must be zero or greater';
  return null;
}

// Basic, deliberately permissive email shape check (server-side floor; the browser
// input[type=email] does the friendly UX). Non-empty single-@ with a dotted domain.
function validateEmail(value) {
  const s = String(value == null ? '' : value).trim();
  if (s === '') return 'is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'is not a valid email address';
  return null;
}

// Normalise an ABN: strip all whitespace. Returns { value, error }.
// Empty ABN is allowed (optional field) and normalises to ''. When present it must
// be exactly 11 digits. Checksum validation is intentionally left out (business
// decision) but this is the single place to add it later.
function normalizeAbn(value) {
  const raw = String(value == null ? '' : value).trim();
  if (raw === '') return { value: '', error: null };
  const digits = raw.replace(/\s+/g, '');
  if (!/^\d{11}$/.test(digits)) {
    return { value: raw, error: 'must be 11 digits' };
  }
  return { value: digits, error: null };
}

// Yes/No enum (used for evidence_provided, has_attachments).
function validateYesNo(value) {
  const s = String(value == null ? '' : value).trim();
  if (s !== 'Yes' && s !== 'No') return "must be 'Yes' or 'No'";
  return null;
}

module.exports = {
  validateDate,
  validateAmount,
  validateEmail,
  normalizeAbn,
  validateYesNo,
};
