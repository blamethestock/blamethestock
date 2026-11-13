// Tiny test harness for Blame the Stock. Works in jsc (dev/run-tests.sh) and in a browser (dev/tests/index.html).
//
//   import { suite, test, eq, near, ok } from './harness.js';
//   suite('core');                                   // label for the tests that follow in this file
//   test('adds', () => { eq(1 + 1, 2); });           // a test may also be async
//   near(0.1 + 0.2, 0.3, 1e-12);  ok(value, 'why');
//
// Tests only register here; dev/tests/run.js runs them all and reports.

const tests = [];
let label = '';

export function suite(name) { label = name ? String(name) : ''; }

export function test(name, fn) {
  tests.push({ name: label ? label + ' › ' + name : String(name), fn });
}

export function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'bigint') return v + 'n';
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function same(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
}

function fail(msg, detail) { throw new Error((msg ? msg + ': ' : '') + detail); }

// Deep equality (=== for values, NaN equals NaN; 0 equals -0 — check -0 with ok(Object.is(x, 0))).
export function eq(actual, expected, msg) {
  if (!same(actual, expected)) fail(msg, 'expected ' + show(expected) + ', got ' + show(actual));
}

// |actual - expected| <= tol
export function near(actual, expected, tol = 1e-9, msg) {
  if (typeof actual !== 'number' || !(Math.abs(actual - expected) <= tol)) {
    fail(msg, 'expected ' + show(expected) + ' ± ' + tol + ', got ' + show(actual));
  }
}

export function ok(value, msg) {
  if (!value) fail(msg || 'expected a true value', 'got ' + show(value));
}

// Runs every registered test in order. onResult({ name, ok, error }) is called after each one.
export async function runAll(onResult) {
  const results = [];
  for (const t of tests) {
    let res;
    try {
      await t.fn();
      res = { name: t.name, ok: true };
    } catch (e) {
      res = { name: t.name, ok: false, error: (e && e.message) || String(e) };
    }
    results.push(res);
    if (onResult) onResult(res);
  }
  const failed = results.filter((x) => !x.ok).length;
  return { results, total: results.length, passed: results.length - failed, failed };
}
