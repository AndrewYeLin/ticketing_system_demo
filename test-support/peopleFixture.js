'use strict';

const fs = require('fs');
const path = require('path');
const csv = require('../lib/csv');
const { PERSON_COLUMNS } = require('../lib/constants');

// These names and IDs are deliberately test-only fixtures. They keep workflow tests
// readable without putting synthetic directory entries back into the dev CSV defaults.
const TEST_PEOPLE = [
  ['PER-001', 'Administrator', '', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes'],
  ['PER-002', 'Client Sample', '', 'Yes', 'Yes', 'Yes', 'No', 'No'],
  ['PER-003', 'Staff Member A', '', 'Yes', 'Yes', 'Yes', 'No', 'No'],
  ['PER-004', 'Staff Member B', '', 'Yes', 'Yes', 'Yes', 'No', 'No'],
  ['PER-005', 'Jane Manager', '', 'Yes', 'Yes', 'Yes', 'Yes', 'No'],
  ['PER-006', 'John Director', '', 'Yes', 'Yes', 'Yes', 'Yes', 'No'],
  ['PER-007', 'Priya Head of School', '', 'Yes', 'Yes', 'Yes', 'Yes', 'No'],
  ['PER-008', 'finance.officer', '', 'Yes', 'Yes', 'Yes', 'No', 'Yes'],
  ['PER-009', 'Alex Lee', '', 'Yes', 'Yes', 'Yes', 'No', 'Yes'],
  ['PER-010', 'Sam Taylor', '', 'Yes', 'Yes', 'Yes', 'No', 'Yes'],
  ['PER-011', 'Alice', '', 'Yes', 'Yes', 'Yes', 'No', 'No'],
  ['PER-012', 'Bob', '', 'Yes', 'Yes', 'Yes', 'No', 'No'],
].map(([person_id, display_name, email, active, can_request, can_travel, can_approve, can_process]) => ({
  person_id, display_name, email, active, can_request, can_travel, can_approve, can_process,
}));

function writePeopleFixture(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'people.csv'), csv.stringify(TEST_PEOPLE, PERSON_COLUMNS), 'utf8');
}

module.exports = { writePeopleFixture };
