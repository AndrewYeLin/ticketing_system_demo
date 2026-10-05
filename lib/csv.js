'use strict';

// Minimal RFC4180-style CSV parser / serializer.
// Handles quoted fields, embedded commas, quotes ("") and newlines.

function escapeField(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Serialize an array of objects to a CSV string given an ordered column list.
function stringify(rows, columns) {
  const lines = [columns.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeField(row[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// Parse a CSV string into an array of plain objects keyed by the header row.
function parse(text) {
  if (!text) return [];
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ',') {
      pushField();
      i++;
    } else if (ch === '\r') {
      // swallow \r; handle the record on the following \n (or alone)
      if (text[i + 1] === '\n') i++;
      pushRecord();
      i++;
    } else if (ch === '\n') {
      pushRecord();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  // flush trailing field/record if the file did not end with a newline
  if (field !== '' || record.length > 0) {
    pushRecord();
  }

  if (records.length === 0) return [];
  const header = records[0];
  const out = [];
  for (let r = 1; r < records.length; r++) {
    const cells = records[r];
    if (cells.length === 1 && cells[0] === '') continue; // skip blank lines
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = cells[idx] != null ? cells[idx] : '';
    });
    out.push(obj);
  }
  return out;
}

module.exports = { parse, stringify, escapeField };
