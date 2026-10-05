'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertApplicationTarget, targetSummary } = require('../lib/runtimeConfig');

const common = {
  DB_SERVER: 'mwrcdev2.polyu.edu.hk',
  DB_PORT: '1433',
  DB_PASSWORD: 'not-a-real-password',
};

test('local CSV is the safe default and does not require SQL settings', () => {
  assert.deepStrictEqual(assertApplicationTarget({ NODE_ENV: 'development', STORAGE: 'csv' }), {
    environment: 'development', storage: 'csv', database: '', user: '',
  });
  assert.deepStrictEqual(assertApplicationTarget({}), {
    environment: 'development', storage: 'csv', database: '', user: '',
  });
});

test('local SQL accepts only the isolated test database and login', () => {
  const env = {
    ...common, NODE_ENV: 'development', STORAGE: 'sql',
    DB_DATABASE: 'FinanceRequestTracker_test', DB_USER: 'frt_test',
  };
  assert.deepStrictEqual(targetSummary(env), {
    environment: 'development', storage: 'sql', database: 'financerequesttracker_test', user: 'frt_test',
  });
  assert.deepStrictEqual(assertApplicationTarget(env), targetSummary(env));
  assert.throws(() => assertApplicationTarget({ ...env, DB_DATABASE: 'FinanceRequestTracker' }), /target mismatch/);
  assert.throws(() => assertApplicationTarget({ ...env, DB_USER: 'frt_app' }), /target mismatch/);
});

test('production accepts only the production database and least-privilege login', () => {
  const env = {
    ...common, NODE_ENV: 'production', STORAGE: 'sql',
    DB_DATABASE: 'FinanceRequestTracker', DB_USER: 'frt_app',
  };
  assert.deepStrictEqual(assertApplicationTarget(env), {
    environment: 'production', storage: 'sql', database: 'financerequesttracker', user: 'frt_app',
  });
  assert.throws(() => assertApplicationTarget({ ...env, STORAGE: 'csv' }), /must use STORAGE=sql/);
  assert.throws(() => assertApplicationTarget({ ...env, DB_DATABASE: 'FinanceRequestTracker_test' }), /target mismatch/);
  assert.throws(() => assertApplicationTarget({ ...env, DB_USER: 'frt_test' }), /target mismatch/);
});

test('unknown storage and incomplete SQL settings fail before a connection is opened', () => {
  assert.throws(() => assertApplicationTarget({ STORAGE: 'postgres' }), /must be csv or sql/);
  assert.throws(() => assertApplicationTarget({ NODE_ENV: 'development', STORAGE: 'sql' }), /DB_SERVER/);
});
