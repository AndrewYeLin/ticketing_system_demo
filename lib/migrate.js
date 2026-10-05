'use strict';

// One-time migration from the old flat request types to the intake type + sub_type
// model. Pure `migrateRows` for testability; a CLI wrapper (node lib/migrate.js) backs
// up the file, rewrites it, and writes a report.
//
//   Purchase Order / Invoice          -> Procurement / "Purchase / PO request"
//   Travel Allowance                  -> Travel / "Travel Allowance - meals/incidentals"
//   Reimbursement                     -> Travel / "Reimbursement"
//   New Supplier                      -> unchanged
//
// Supplier links are backfilled from supplier_name to a stable supplier_id only on a
// UNIQUE approved-supplier match; ambiguous/no-match rows are reported, never guessed.

const {
  SUBTYPES_BY_TYPE,
  requiredFieldsFor,
  WAITING_ON_BY_STATUS,
  PROCUREMENT_SUBMIT_TO_ADMIN,
  PROCUREMENT_PO_ISSUED,
  PROCUREMENT_INVOICE_RECEIVED,
} = require('./constants');

const TYPE_MAP = {
  'Purchase Order': { type: 'Procurement', sub: 'Purchase / PO request' },
  Invoice: { type: 'Procurement', sub: 'Purchase / PO request' },
  'Travel Allowance': { type: 'Travel', sub: 'Travel Allowance - meals/incidentals' },
  Reimbursement: { type: 'Travel', sub: 'Reimbursement' },
};

// old status -> new status, per target type.
const STATUS_MAP = {
  'Submitted for approval': { Procurement: PROCUREMENT_SUBMIT_TO_ADMIN, Travel: 'Submitted' },
  New: { Procurement: PROCUREMENT_SUBMIT_TO_ADMIN, Travel: 'Submitted' },
  'PO Issued': { Procurement: PROCUREMENT_PO_ISSUED },
  Forwarded: { Procurement: PROCUREMENT_PO_ISSUED },
  'Waiting for Supplier Invoice': { Procurement: PROCUREMENT_PO_ISSUED },
  'Ready for Invoice Processing': { Procurement: PROCUREMENT_INVOICE_RECEIVED },
  'Invoice Received': { Procurement: PROCUREMENT_INVOICE_RECEIVED },
};

// Fields still missing on a row relative to its (new) type/sub-type required set.
function incompleteFields(row) {
  const subs = SUBTYPES_BY_TYPE[row.request_type] || [];
  const key = subs.length ? String(row.sub_type || '').trim() : '';
  const required = ['received_date', ...requiredFieldsFor(row.request_type, key, row.supplier_type)];
  const missing = required.filter((f) => String(row[f] || '').trim() === '');
  if (row.request_type === 'Travel' && row.sub_type === 'Reimbursement') {
    const s = String(row.reimbursement_items || '').trim();
    if (s === '' || s === '[]') missing.push('reimbursement_items');
  }
  return missing;
}

// Migrate an array of parsed rows. Returns { rows, report }. Idempotent: rows already
// on a new type (no old type name) are passed through untouched.
function migrateRows(rows) {
  const report = {
    migrated: 0,
    unchanged: 0,
    supplierBackfilled: [],
    supplierUnmatched: [],
    incomplete: [],
  };

  // Index approved suppliers by legal entity name (for supplier_id backfill).
  const approvedByName = new Map();
  for (const r of rows) {
    if (
      r.request_type === 'New Supplier' &&
      r.current_status === 'Approved' &&
      String(r.deleted || '') !== 'Yes'
    ) {
      const nm = String(r.legal_entity_name || '').trim();
      if (nm) {
        if (!approvedByName.has(nm)) approvedByName.set(nm, []);
        approvedByName.get(nm).push(r.request_id);
      }
    }
  }

  const out = rows.map((r) => {
    const map = TYPE_MAP[r.request_type];
    if (!map) {
      report.unchanged++;
      return { ...r };
    }
    const row = { ...r };
    row.request_type = map.type;
    if (String(row.sub_type || '').trim() === '') row.sub_type = map.sub;

    const sm = STATUS_MAP[r.current_status];
    if (sm && sm[map.type]) row.current_status = sm[map.type];
    if (Object.prototype.hasOwnProperty.call(WAITING_ON_BY_STATUS, row.current_status)) {
      row.waiting_on = WAITING_ON_BY_STATUS[row.current_status];
    }

    if (map.type === 'Procurement') {
      // Old PO amount was a total; seed amount_ex_gst if not already set.
      if (String(row.amount || '').trim() !== '' && String(row.amount_ex_gst || '').trim() === '') {
        row.amount_ex_gst = row.amount;
      }
      const nm = String(row.supplier_name || '').trim();
      if (nm && String(row.supplier_id || '').trim() === '') {
        const ids = approvedByName.get(nm) || [];
        if (ids.length === 1) {
          row.supplier_id = ids[0];
          report.supplierBackfilled.push({ request_id: row.request_id, supplier_id: ids[0], supplier_name: nm });
        } else {
          report.supplierUnmatched.push({
            request_id: row.request_id,
            supplier_name: nm,
            reason: ids.length === 0 ? 'no approved supplier match' : 'multiple approved matches',
          });
        }
      }
    }

    report.migrated++;
    const missing = incompleteFields(row);
    if (missing.length) report.incomplete.push({ request_id: row.request_id, missing });
    return row;
  });

  return { rows: out, report };
}

module.exports = { migrateRows, incompleteFields, TYPE_MAP, STATUS_MAP };

// ---- CLI ----
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const csv = require('./csv');
  const { CURRENT_COLUMNS } = require('./constants');

  const dir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
  const file = path.join(dir, 'requests_current.csv');

  if (!fs.existsSync(file)) {
    console.error('No requests_current.csv found at', file);
    process.exit(1);
  }

  const rows = csv.parse(fs.readFileSync(file, 'utf8'));
  const { rows: out, report } = migrateRows(rows);

  if (report.migrated > 0) {
    const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, bak);
    fs.writeFileSync(file, csv.stringify(out, CURRENT_COLUMNS), 'utf8');
    fs.writeFileSync(
      path.join(dir, 'migration_report.json'),
      JSON.stringify(report, null, 2),
      'utf8'
    );
    console.log(`Migrated ${report.migrated} row(s). Backup: ${path.basename(bak)}`);
  } else {
    console.log('Nothing to migrate (already on the new model).');
  }
  console.log(JSON.stringify(report, null, 2));
}
