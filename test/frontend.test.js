'use strict';

// Static checks on the front-end sources.
//
// There is no DOM test harness here (node:test only, and adding one for a handful of
// assertions is not worth the dependency), so these read public/ as text. That is enough
// for the class of bug they exist to catch: three separate places describing the same
// table, drifting apart silently.
//
// The expense-line table is described in three places — the intake form's <thead> in
// index.html, the returned-request editor's <thead> built in app.js, and the per-cell
// labels addLineRow stamps onto each <td> (which the narrow layout prints above every
// field via `td::before { content: attr(data-label) }`). When the GST-entry and GST
// columns were dropped, only two of the three were updated: every cell after Category
// ended up wearing the previous column's label, so on a phone the supplier box asked for
// "GST ($)" and the receipt picker called itself "Supplier".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

const clean = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').replace(/\*/g, '').trim();

// <th> texts of the intake form's expense table.
function intakeHeaders() {
  const start = html.indexOf('id="reimbursement-table"');
  assert.ok(start > 0, 'the intake form no longer has #reimbursement-table');
  const thead = html.slice(start, html.indexOf('</thead>', start));
  return [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => clean(m[1]));
}

// <th> texts of the returned-request editor's table, built as an innerHTML string.
function editorHeaders() {
  const marker = app.indexOf("table.innerHTML = '<thead>");
  assert.ok(marker > 0, 'the returned-request editor no longer builds its own <thead>');
  const literal = app.slice(marker, app.indexOf(';', marker));
  return [...literal.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => clean(m[1]));
}

// The [control, label, cssClass] triples addLineRow stamps onto each <td>.
function cellColumns() {
  const start = app.indexOf('const columns = [');
  assert.ok(start > 0, 'addLineRow no longer declares its column list');
  const literal = app.slice(start, app.indexOf('];', start));
  return [...literal.matchAll(/\[\s*(\w+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g)]
    .map((m) => ({ control: m[1], label: m[2], cls: m[3] }));
}

test('the intake table and the returned-request editor describe the same columns', () => {
  assert.deepStrictEqual(editorHeaders(), intakeHeaders(),
    'the two expense tables have drifted apart; a row rendered into one will not line up');
  assert.doesNotMatch(app, /line-supplier|querySelector\('\.line-supplier'\)|legacySupplier|item\.supplier/,
    'Reimbursement expense lines still expose or preserve the removed Supplier field');
});

test('queue filters keep the required controls together without an advanced panel', () => {
  assert.doesNotMatch(html, /Advanced filters|queue-advanced-filters|f-requester|f-supplier|f-subtype|f-waiting/,
    'retired advanced filter controls are still exposed');
  for (const label of ['Search', 'Request type', 'All status', 'Processed by', 'Received from', 'Received to', 'Record visibility']) {
    assert.match(html, new RegExp(`<span>${label}</span>`), `${label} lost its visible field label`);
  }
  assert.doesNotMatch(app, /f-waiting|filters\.waiting|f\.waiting/,
    'Waiting on is still wired as an admin queue filter');
  assert.match(app, /NEW_SUPPLIER_FILTER = '__new_supplier__'/,
    'the New Supplier queue filter has no dedicated value');
  assert.match(app, /r\.request_type === 'Procurement' && r\.supplier_type === 'New Supplier'/,
    'New Supplier does not filter Procurement supplier type');
  assert.match(css, /#queue-primary-filters\s*\{[\s\S]*grid-template-columns:/,
    'queue filters no longer use a stable labelled grid');
  assert.match(app, /visibleStatuses = \(statuses\) => \[\.\.\.new Set\(statuses \|\| \[\]\)\]\.filter\(\(status\) => status !== 'Draft'\)/,
    'Draft is still offered as an admin queue filter');
  assert.doesNotMatch(app, /state\.options\.waiting_on \|\| \[\]/,
    'the removed waiting-on filter is still populated from API options');
});

test('Travel Allowance belongs to the Finance workspace, not Travel workspace', () => {
  assert.match(app, /TRAVEL_WORKSPACE_TYPES = new Set\(\['Travel'\]\)/,
    'Travel Allowance is still grouped into the Travel workspace');
  assert.match(app, /Manage Travel requests separately from Finance requests\./,
    'the admin Travel workspace still claims Travel Allowance');
  assert.match(app, /Manage Procurement, Travel Allowance and Reimbursement requests in one finance queue\./,
    'the admin Finance workspace does not explain where Travel Allowance is managed');
  assert.match(app, /Choose Travel and we will show you exactly what to provide\./,
    'the requester Travel workspace still offers Travel Allowance');
  assert.match(html, /data-tab="new-travel"[^>]*hidden/,
    'New Travel Request is still visible before the runtime options load');
  assert.doesNotMatch(app, /'Travel\|\|Domestic': \[[^\]]*destination/,
    'Destination is still collected by the hidden New Travel Request form');
});

test('Travel Allowance shows TA Calculator as an optional upload', () => {
  const constants = require('../lib/constants');
  assert.ok(constants.ALLOWED_ATTACHMENTS_BY_SUBTYPE['Travel Allowance']['Meals/incidentals'].includes('ta_calculator'),
    'TA Calculator is no longer an allowed Travel Allowance attachment');
  assert.ok(!constants.REQUIRED_ATTACHMENTS_BY_SUBTYPE['Travel Allowance']['Meals/incidentals'].includes('ta_calculator'),
    'TA Calculator became mandatory for Travel Allowance');
  assert.match(app, /const optionalIntakePurposes = type === 'Travel Allowance' \? \['ta_calculator'\] : \[\]/,
    'the optional TA Calculator upload slot is not rendered on the intake form');
  assert.match(app, /\[\.\.\.new Set\(\[\.\.\.requiredAtt, \.\.\.optionalIntakePurposes\]\)\]/,
    'optional Travel Allowance attachments are not included in the intake document slots');
  assert.strictEqual(constants.ATTACHMENT_LABELS.itinerary, 'Itinerary');
  assert.deepStrictEqual(constants.REQUIRED_ATTACHMENTS_BY_SUBTYPE['Travel Allowance']['Meals/incidentals'],
    ['itinerary', 'approval_email']);
});

test('Travel Allowance and Reimbursement activity codes are required in the UI and rules', () => {
  const constants = require('../lib/constants');
  assert.ok(constants.REQUIRED_BY_SUBTYPE['Travel Allowance']['Meals/incidentals'].includes('activity_code'));
  assert.ok(constants.REQUIRED_BY_SUBTYPE.Reimbursement.Reimbursement.includes('activity_code'));
  assert.match(app, /'Travel Allowance\|\|Meals\/incidentals': \['beneficiary_name', 'activity_code'/,
    'Travel Allowance does not mark activity code in its field list');
  assert.match(app, /'Reimbursement\|\|Reimbursement': \['requester_name', 'activity_code'\]/,
    'Reimbursement does not mark activity code in its field list');
});

test('Travel Allowance and Reimbursement no longer expose retired statuses', () => {
  const constants = require('../lib/constants');
  for (const type of ['Travel Allowance', 'Reimbursement']) {
    assert.ok(!constants.STATUSES_BY_TYPE[type].includes('Accepted by Finance'));
    assert.ok(!constants.STATUSES_BY_TYPE[type].includes('Processed in External System'));
  }
  assert.match(app, /const processedStatuses = new Set\(\['Completed'\]\)/,
    'the shared admin status control still treats the retired statuses as active');
});

test('Reimbursement required documents and line receipts are marked', () => {
  const constants = require('../lib/constants');
  assert.deepStrictEqual(constants.REQUIRED_ATTACHMENTS_BY_SUBTYPE.Reimbursement.Reimbursement,
    ['reimbursement_form', 'approval_email']);
  assert.ok(constants.ALLOWED_ATTACHMENTS_BY_SUBTYPE.Reimbursement.Reimbursement.includes('reimbursement_form'));
  assert.ok(constants.ALLOWED_ATTACHMENTS_BY_SUBTYPE.Reimbursement.Reimbursement.includes('approval_email'));
  assert.strictEqual(constants.ATTACHMENT_LABELS.reimbursement_form, 'Reimbursement Form');
  assert.strictEqual(constants.ATTACHMENT_LABELS.approval_email, 'Approval email');
  assert.match(app, /rec\.required = !tr\.dataset\.existingReceipt/,
    'new reimbursement lines do not require a receipt input');
  assert.match(html, /<th>Receipt <span class="req-star">\*<\/span><\/th>/,
    'the reimbursement receipt header does not show a required marker');
  assert.match(app, /<th>Description<\/th><th>Receipt <span class="req-star">\*<\/span><\/th>/,
    'the returned reimbursement editor receipt header does not show a required marker');
});

test('close reason stays beside status and cancelled requests retain existing PO context', () => {
  assert.match(html, /id="upd-close-reason-field"/, 'the close reason field is not part of the main status row');
  assert.match(app, /form\.elements\.close_reason/, 'the admin form no longer restores the saved close reason');
  assert.match(app, /status === 'Cancelled' && hasExistingPo/, 'cancelled requests would hide an existing PO');
  assert.match(app, /const showPoFields = statusIndex >= poIndex \|\| \(status === 'Cancelled' && hasExistingPo\)/,
    'PO visibility is not tied to the existing PO when a request is cancelled');
});

test('admin workflow controls follow the complete procurement content', () => {
  const extra = html.indexOf('id="admin-extra-fields"');
  const workflow = html.indexOf('id="admin-workflow-fields"');
  assert.ok(extra >= 0 && workflow > extra,
    'the admin workflow section must follow procurement follow-up fields');
  const workflowBlock = html.slice(workflow, html.indexOf('</section>', workflow));
  for (const id of ['upd-status-field', 'upd-close-reason-field', 'upd-waiting-field']) {
    assert.match(workflowBlock, new RegExp(`id="${id}"`), `${id} is not in the workflow section`);
  }
  assert.match(app, /if \(!isAdmin\) appendMetaValue\(meta, 'Waiting on'/,
    'admin still shows a duplicate Waiting on value in the identity strip');
  assert.match(app, /new Set\(\[\.\.\.adminEditableFieldNames\(row\), 'current_status'\]\)/,
    'admin still repeats Status in the recorded request details');
  assert.match(app, /function placeDetailBlocks\(isAdmin\)[\s\S]*workflow\.after\(attachments\)/,
    'admin attachments are not placed after the workflow controls');
  assert.match(css, /\.admin-workflow-fields\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,/,
    'the workflow section does not have a stable desktop layout');
});

test('closing a request detail stays in the authenticated workspace', () => {
  assert.match(app, /el\('detail-close'\)\.addEventListener\('click', \(event\) => \{[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);[\s\S]*closeDetail\(\);/,
    'the detail close action must not leak into an outer/default click action');
  assert.match(css, /\.overlay\s*\{\s*z-index:\s*40;/,
    'the detail overlay must sit above the sticky header hit area');
});

test('supplier master navigation is hidden while controlled supplier workflows remain available', () => {
  assert.match(html, /data-admin-tab="suppliers"[^>]*hidden/, 'the Suppliers admin tab is visible');
  assert.match(html, /data-admin-tab="supplier-requests"[^>]*hidden/, 'the Supplier requests workspace is visible');
  assert.match(app, /HIDDEN_REQUESTER_TYPES = new Set\(\['Supplier Setup', 'Travel'\]\)/,
    'Supplier Setup or Travel is not marked as hidden from the requester picker');
  assert.match(app, /requesterTypesForGroup\(group\)[\s\S]*!HIDDEN_REQUESTER_TYPES\.has\(type\)/,
    'the requester picker still renders Supplier Setup');
  assert.match(app, /\['suppliers', 'supplier-requests'\]\.includes\(tab\) \? 'requests'/,
    'a stale supplier tab value can still reveal a hidden page');
  assert.match(app, /el\('admin-tab-supplier-requests'\)\.hidden = true/,
    'the hidden Supplier requests page can still be rendered');
});

test('the activity code is the only code field left, and it keeps its Other backup path', () => {
  assert.doesNotMatch(app, /cost_code|costcode|fillCostSelect/,
    'the cost code is still collected somewhere in the front-end');
  assert.match(app, /function fillActivitySelect\(sel, current, otherValue = ''\)[\s\S]*const all = \(state\.options\.activity_codes \|\| \[\]\)\.slice\(\)/,
    'the activity code dropdown is not populated from the full reference list');
  assert.match(app, /otherOption\.textContent = otherCodeOptionLabel\(isOther \? otherInput\.value : ''\)/,
    'the selected Other option does not show the persisted custom code');
  assert.match(app, /other\.addEventListener\('input', \(\) => syncOtherCodeInput/,
    'typing a custom code does not update the visible dropdown label');
  assert.match(app, /other\.name = `\$\{name\}_other`/,
    'the free-text backup does not have a persisted field name');
  assert.match(app, /otherInput\.required = isOther/,
    'the free-text backup is not required when Other is selected');
  assert.match(app, /activity_code_other: \{ label: 'Other activity code'/,
    'the backup field is not included in the frontend field configuration');
});

test('the activity code follows the supplier type, from one shared rule', () => {
  assert.match(app, /function requiredFieldNamesFor\(type, subType, supplierType = ''\)[\s\S]*state\.options\.activity_code_required_supplier_types[\s\S]*required\.add\('activity_code'\)/,
    'the conditional activity code rule is not read from the server-published rule set');
  assert.match(app, /function wireActivityCodeRequirement\(container, type, subType, fallbackSupplierType = ''\)[\s\S]*supplierType\.addEventListener\('change', apply\)/,
    'changing the supplier type does not re-evaluate whether the activity code is required');
  for (const caller of [
    /wireActivityCodeRequirement\(box, type, sub, supplierTypeValue\)/,
    /wireActivityCodeRequirement\(box, row\.request_type, row\.sub_type, row\.supplier_type\)/,
    /wireActivityCodeRequirement\(fields, row\.request_type, row\.sub_type, row\.supplier_type\)/,
  ]) {
    assert.match(app, caller, `an editor does not wire the activity code requirement: ${caller}`);
  }
});

test('Other documents carries the New Supplier bank-evidence rule', () => {
  assert.match(app, /Additional supporting documentation required for New Suppliers, ONE of the following must be provided:/,
    'the New Supplier evidence note is missing from Other documents');
  assert.match(app, /Please upload one of above via Other documents/,
    'the note does not say where the evidence goes');
  for (const option of ['official supplier letterhead', 'quotation or tax invoice', 'financial institution', 'bank statement']) {
    assert.ok(app.includes(option), `the New Supplier evidence note is missing the "${option}" option`);
  }
  assert.match(app, /showNewSupplierEvidence = false/,
    'the New Supplier evidence note is not conditional');
  assert.doesNotMatch(app, /includeNewSupplierEvidence: row\.request_type|showNewSupplierEvidence: row\.supplier_type/,
    'admin or returned-request editors still show the user-only note');
  assert.match(app, /container\.append\(title, help, \.\.\.\(note \? \[note\] : \[\]\), slots, addButton\)/,
    'the conditional note is not rendered inside the Other documents section');
});

test('Procurement supporting documents share one required section and one rule source', () => {
  assert.match(app, /function requiredFieldNamesFor\(type, subType, supplierType = ''\)[\s\S]*new Set/,
    'request field requirements are not read from the shared options rules');
  assert.match(app, /const PROCUREMENT_INTAKE_DOCUMENTS = \['quote', 'approval_email'\]/,
    'Procurement supporting documents are not both rendered in the intake form');
  assert.match(app, /function requiredAttachmentPurposesFor\(type, subType, supplierType = ''\)[\s\S]*required\.includes\('new_supplier_form'\)/,
    'New Supplier Form is not conditionally required');
  assert.match(app, /const requiredSection = fixedPurposes\.length[\s\S]*buildRequiredDocumentSection/,
    'supporting documents do not render under Required documents');
  assert.match(app, /requiredSection\?\.fields\.appendChild\(field\.label\)[\s\S]*setAttachmentRequired\(field, requiredPurposes\.includes\(purpose\)\)/,
    'document placement and required markers are not updated from the same rule set');
  assert.doesNotMatch(app, /PROCUREMENT_INTAKE_OPTIONAL_DOCUMENTS|buildOptionalDocumentSection|Optional documents|optionalPurposes/,
    'the removed Optional documents section or its old rule path remains');
  assert.doesNotMatch(app, /syncSupplierDependentFields|supplier-dependent-req-star/,
    'the activity code still has a conflicting supplier-dependent required path');
  assert.match(app, /const requiredSet = requiredFieldNamesFor\(row\.request_type, row\.sub_type, row\.supplier_type\)/,
    'admin or returned request editors do not use the shared field requirements');
  assert.match(app, /const required = requiredAttachmentPurposesFor\(row\.request_type, row\.sub_type, row\.supplier_type\)/,
    'request detail completeness does not use the shared attachment requirements');
  assert.match(app, /title\.textContent = 'Required documents'/,
    'the supporting-document section is not labelled Required documents');
  assert.match(app, /title\.textContent = 'Other documents'/,
    'the Other documents section was not renamed');
  assert.match(html, /Required files appear under Required documents; optional extras can be added under Other documents/,
    'the intake help text does not use the unified document labels');
});

test('request selectors and code fields use purposeful widths', () => {
  assert.match(css, /\.dyn-grid\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(3,\s*minmax\(240px,\s*1fr\)\)/,
    'dynamic fields can collapse code selectors into unreadable columns');
  assert.match(css, /\.code-control-pair:has\(\.code-other-input\[hidden\]\)\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    'a hidden Other input still reserves a second grid column');
  assert.match(html, /class="request-selector-row span-2"[\s\S]*name="request_type"[\s\S]*id="subtype-field"/,
    'request type selectors are not isolated from the full-width detail grid');
  assert.match(html, /<label id="subtype-field" hidden>/,
    'the sub-type selector is visible before a request type has been chosen');
  assert.match(app, /cf\.sub_type\.innerHTML = ''[\s\S]*el\('subtype-field'\)\.hidden = true/,
    'resetting a request editor can leave a stale sub-type selector visible');
  assert.match(css, /#create-form\s*\{\s*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/,
    'the create form still constrains the detail area to the selector widths');
  assert.match(css, /\.request-selector-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(240px,\s*300px\)\s+minmax\(300px,\s*420px\);/,
    'request type selectors do not have purposeful widths');
  assert.match(css, /@media \(max-width: 960px\) \{[\s\S]*#create-form\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*\.request-selector-row\s*\{\s*grid-template-columns:\s*minmax\(220px,\s*260px\)\s+minmax\(260px,\s*360px\);/,
    'selector widths do not reduce before the form reaches the mobile breakpoint');
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*\.grid-form, #create-form,[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    'the form remains multi-column too far into the narrow layout');
});

test('workspace navigation leaves room for its labels at the reading scale', () => {
  assert.match(css, /\.workspace-layout\s*\{\s*grid-template-columns:\s*250px\s+minmax\(0,\s*1fr\);\s*gap:\s*22px;/,
    'the desktop workspace rail is still too narrow for its labels');
  assert.match(css, /\.tabs \.nav-label\s*\{\s*white-space:\s*nowrap;\s*\}/,
    'workspace labels can still wrap inside the navigation rail');
  assert.match(css, /@media \(max-width: 1050px\) \{[\s\S]*\.workspace-layout\s*\{\s*grid-template-columns:\s*230px\s+minmax\(0,\s*1fr\);/,
    'the medium-width workspace rail was not widened consistently');
});

test('bootstrap failures cannot expose the default requester view', () => {
  const start = app.indexOf('async function startApp(me)');
  const end = app.indexOf('// Notification emails', start);
  assert.ok(start > 0 && end > start, 'startApp bootstrap boundary changed');
  const bootstrap = app.slice(start, end);
  assert.ok(bootstrap.indexOf('applyRoleView();') < bootstrap.indexOf("state.options = await api('/api/options');"),
    'the authenticated role must be applied before options are fetched');
  assert.match(app, /function showStartupError\(\) \{[\s\S]*showLogin\(\);[\s\S]*We could not load your workspace\./,
    'bootstrap failures do not return to a visible login error state');
  assert.match(app, /async function startAppSafely\(me\) \{[\s\S]*await startApp\(me\);[\s\S]*showStartupError\(\);/,
    'startup errors are not contained by the safe bootstrap wrapper');
  assert.match(app, /if \(me\) await startAppSafely\(me\); else showLogin\(\);/,
    'session restore does not use the safe bootstrap wrapper');
  assert.strictEqual((app.match(/const ready = await startAppSafely\(me\);/g) || []).length, 2,
    'login and registration do not both use the safe bootstrap wrapper');
});

test('client-side detail ids work when the app is served over plain HTTP', () => {
  assert.match(app, /function newClientUuid\(\)[\s\S]*globalThis\.crypto\?\.randomUUID/,
    'client ids still assume randomUUID is available in every browser context');
  assert.match(app, /globalThis\.crypto\?\.getRandomValues/,
    'the UUID fallback does not use browser randomness when it is available');
  assert.match(app, /return UUID_RE\.test\(candidate\) \? candidate : newClientUuid\(\);/,
    'stableClientId still calls the secure-context-only API directly');
  assert.doesNotMatch(app, /return UUID_RE\.test\(candidate\) \? candidate : crypto\.randomUUID\(\);/,
    'admin detail rendering can still fail on an HTTP deployment');
});

test('reimbursement line totals fall back to exclusive GST amounts', () => {
  assert.match(html, /Enter either Total Excl\. GST or Total Incl\. GST for every line/,
    'reimbursement guidance still says both totals are required');
  assert.match(html, /class="line-total-note"[^>]*>Calculated from all expense lines\./,
    'the intake total does not explain how it is calculated');
  assert.match(app, /function effectiveReimbursementLineAmount\(item\)/,
    'reimbursement lines do not define a single effective amount');
  assert.match(app, /const raw = inclusive \|\| exclusive;/,
    'the inclusive/exclusive amount fallback is missing');
  assert.match(app, /reduce\(\(s, it\) => s \+ effectiveReimbursementLineAmount\(it\), 0\)/,
    'the visible reimbursement total still ignores exclusive-only lines');
  assert.match(app, /totalNote\.className = 'line-total-note'/,
    'the returned-request total does not explain how it is calculated');
});

test('admin invoice fields share the matching invoice document card', () => {
  assert.match(app, /invoiceDocuments = invoiceEditor\?\.invoiceDocuments/,
    'the admin invoice editor is still detached from Invoice documents');
  assert.match(app, /invoiceEditor\.getInvoiceGroup\(requestedIndex\)/,
    'new invoice fields are not resolved against their document group');
  assert.match(app, /invoiceRow\.insertBefore\(details, attachmentGrid \|\| null\)/,
    'invoice details are not placed before the matching upload controls');
  assert.match(app, /attachments-list'\)\.querySelectorAll\('\.invoice-admin-editor \.invoice-document-group'\)/,
    'the update payload no longer reads invoice fields from their document cards');
  assert.match(css, /\.invoice-admin-details\s*\{[\s\S]*grid-template-columns: repeat\(3,/,
    'invoice detail fields lost their three-column desktop layout');
  assert.match(css, /\.admin-supporting-documents > \.invoice-approval-section \{ grid-column: 1 \/ -1; \}/,
    'the admin approval section is still constrained to one grid column');
});

test('admin PO status does not require invoice details before the invoice stage', () => {
  assert.match(app, /stage-invoice-entry'[\s\S]*node\.hidden = statusIndex < invoiceIndex/,
    'invoice entry fields are still exposed as required at PO stage');
  assert.match(app, /const invoiceFieldsRequired = requestType === 'Procurement' && statusIndex >= invoiceIndex/,
    'invoice requirements are not tied to the invoice workflow stage');
  assert.match(app, /stageInvoiceRequired === 'true'/,
    'invoice amount validity still blocks PO-stage updates');
});

test('PO-stage invoice handover allows an incomplete requester draft', () => {
  const handover = app.slice(app.indexOf('function addInvoiceHandover'), app.indexOf('function labelledControl'));
  assert.match(handover, /You can save an incomplete draft/,
    'the PO-stage editor does not explain that draft saving is allowed');
  assert.match(handover, /const number = textField\('Invoice number'\);/,
    'invoice number is still browser-required before the final send action');
  assert.match(handover, /const doc = fileField\('Invoice file', \{ stored: existingDocument \}\);/,
    'invoice file is still browser-required before the final send action');
  assert.match(handover, /const approval = fileField\('Invoice approval email', \{ stored: storedByPurpose\.get\('invoice_approval_email'\) \}\);/,
    'approval email is still browser-required before the final send action');
  assert.match(handover, /if \(validateBeforeSend\)/,
    'final invoice handover validation was removed instead of being kept on Send');
});

test('admin requester documents do not add a redundant action heading', () => {
  assert.doesNotMatch(app, /Add or replace requester documents/,
    'the requester document editor still adds a duplicate hierarchy level');
  assert.doesNotMatch(app, /Add or replace Finance-issued documents/,
    'the Finance document editor still adds a duplicate hierarchy level');
  assert.match(app, /Files supplied by the user\. Finance can upload or replace them here/,
    'the admin editing instruction was lost with the redundant heading');
  assert.match(app, /Finance-issued documents can be uploaded or replaced here\. Every change is recorded in History\./,
    'the Finance editing instruction was lost with the redundant heading');
  assert.match(css, /\.admin-supporting-documents\s*\{[\s\S]*display: grid;/,
    'the flattened requester document group no longer has a stable layout');
  assert.match(css, /\.attachments-list \.attachment-summary-title \{ margin: 0; \}/,
    'attachment hierarchy headings can still inherit the legacy large top margin');
  assert.match(css, /\.attachments-list \.attachment-subsection-title,[\s\S]*\.other-document-list > h4 \{ margin: 0; \}/,
    'nested attachment headings can still inherit the legacy large top margin');
});

test('requester is presented as User without changing the internal role vocabulary', () => {
  assert.match(html, /<span class="nav-label">user workspace<\/span>/i);
  assert.match(html, /<span class="eyebrow">User portal<\/span>/);
  assert.match(html, /<th>ID<\/th><th>Request<\/th><th>User \/ Traveller<\/th>/);
  assert.match(app, /requester_name: \{ label: 'User', control: 'staff' \}/);
  assert.match(app, /function userFacingLabel\(value\)/);
  assert.match(app, /function titleCaseStatus\(value\)/);
  assert.match(app, /const PROCUREMENT_RETURN_TO_REQUESTOR_STATUS = 'Return to User'/);
  assert.match(app, /const PO_ISSUED_STATUS = 'PO issued to user'/);
  assert.match(app, /roleLabel\.textContent = me\.role === 'admin' \? 'Finance admin' : 'User'/);
});

test('every expense cell is labelled with the column it actually sits under', () => {
  const headers = intakeHeaders();
  const cells = cellColumns();
  // The last header is the blank one above the remove button, which carries no control.
  assert.deepStrictEqual(cells.map((c) => c.label), headers.slice(0, -1),
    'a cell label does not match its column heading — the narrow layout prints these above each field');
});

test('each expense cell gets its own control, so labels cannot drift again', () => {
  const controls = cellColumns().map((c) => c.control);
  assert.strictEqual(new Set(controls).size, controls.length, 'a control is rendered into two cells');
  assert.deepStrictEqual(controls, ['catSel', 'ex', 'total', 'desc', 'rec'],
    'the control order changed; check the headings still describe them in this order');
});

test('every expense column class has a width rule, and none is left unused', () => {
  const used = new Set(cellColumns().map((c) => `line-cell-${c.cls}`).concat('line-cell-remove'));
  const declared = new Set([...css.matchAll(/\.(line-cell-[a-z]+)\s*\{/g)].map((m) => m[1]));
  for (const cls of used) assert.ok(declared.has(cls), `${cls} is applied but has no width rule`);
  for (const cls of declared) assert.ok(used.has(cls), `${cls} is dead CSS — no cell uses it`);
});

test('the page fetches nothing the CSP would block', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /default-src 'self'/, 'the CSP is no longer same-origin by default');
  const external = [...html.matchAll(/<link[^>]+href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(external, [],
    `index.html loads ${external.join(', ')}, which the same-origin CSP blocks — the request fails on every page view`);
});
