/**
 * Run: npx --yes vite-node src/utils/__tests__/normalizeTaskForSaveCases.mjs
 */
import { normalizeTaskForSave } from '../taskCalculations.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS  ${name}`);
}

test('rfi boolean true serializes to string 1', () => {
  const result = normalizeTaskForSave({ rfi: true, plan: '8' });
  assert(result.rfi === '1', `expected "1", got ${JSON.stringify(result.rfi)}`);
});

test('rfi boolean false serializes to string 0', () => {
  const result = normalizeTaskForSave({ rfi: false, plan: '8' });
  assert(result.rfi === '0', `expected "0", got ${JSON.stringify(result.rfi)}`);
});

test('rfi empty stays empty', () => {
  const result = normalizeTaskForSave({ rfi: '', plan: '8' });
  assert(result.rfi === '', `expected "", got ${JSON.stringify(result.rfi)}`);
});

test('dl mirror checkbox fields serialize for sync payload', () => {
  const result = normalizeTaskForSave({
    rfi: true,
    dl_rfi: true,
    dl_done: false,
    plan: '8',
  });
  assert(result.rfi === '1', 'rfi');
  assert(result.dl_rfi === '1', 'dl_rfi');
  assert(result.dl_done === '0', 'dl_done');
});

test('override matching algorithm is preserved on save', () => {
  const result = normalizeTaskForSave({
    plan: '8',
    algorithm_1: 'Habiba A',
    override_1: 'Habiba A',
    override_2: 'Mohamed Khaled',
  });
  assert(result.override_1 === 'Habiba A', `override_1 cleared unexpectedly: ${result.override_1}`);
  assert(result.override_2 === 'Mohamed Khaled', `override_2=${result.override_2}`);
});

console.log(`\n${passed} passed`);
