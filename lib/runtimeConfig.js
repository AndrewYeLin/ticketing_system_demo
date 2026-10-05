'use strict';

// Runtime target guard. The application has two intentionally separate SQL targets:
// FinanceRequestTracker_Test for local SQL development and FinanceRequestTracker for
// production. CSV remains the safe local default. Keeping this check independent of the
// database driver lets the server refuse a wrong target before opening a connection.

const TARGETS = Object.freeze({
  development: Object.freeze({ database: 'financerequesttracker_test', user: 'frt_test' }),
  production: Object.freeze({ database: 'financerequesttracker', user: 'frt_app' }),
});

function normalise(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function storageKind(env = process.env) {
  const value = normalise(env.STORAGE);
  if (!value || value === 'csv') return 'csv';
  if (value === 'sql') return 'sql';
  throw new Error(`STORAGE must be csv or sql, received "${env.STORAGE}".`);
}

function environmentKind(env = process.env) {
  return normalise(env.NODE_ENV) === 'production' ? 'production' : 'development';
}

function targetSummary(env = process.env) {
  return {
    environment: environmentKind(env),
    storage: storageKind(env),
    database: normalise(env.DB_DATABASE),
    user: normalise(env.DB_USER),
  };
}

function assertApplicationTarget(env = process.env) {
  const target = targetSummary(env);

  const demoMode = normalise(env.DEMO_MODE) === 'true';
  if (target.environment === 'production' && target.storage !== 'sql' && !demoMode) {
    throw new Error('Production must use STORAGE=sql unless DEMO_MODE=true is explicitly set.');
  }
  if (target.storage === 'csv') return target;

  const expected = TARGETS[target.environment];
  const missing = ['DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD']
    .filter((key) => !String(env[key] == null ? '' : env[key]).trim());
  if (missing.length) {
    throw new Error(`SQL storage requires ${missing.join(', ')} to be set.`);
  }
  if (target.database !== expected.database || target.user !== expected.user) {
    const database = target.environment === 'production' ? 'FinanceRequestTracker' : 'FinanceRequestTracker_Test';
    const user = target.environment === 'production' ? 'frt_app' : 'frt_test';
    throw new Error(
      `${target.environment} SQL target mismatch: expected ${database} with ${user}, `
      + `received ${env.DB_DATABASE || '(empty)'} with ${env.DB_USER || '(empty)'}.`
    );
  }
  return target;
}

module.exports = { TARGETS, storageKind, environmentKind, targetSummary, assertApplicationTarget };
