/**
 * Loader-contract regression test for `client.js`.
 *
 * Run with `npm test`. Guards the one invariant whose violation took the DSH
 * desktop app down: the bundle MUST register its factory under the package name,
 * because `@deepseek-ai/dsh-client-modules` names every boot-graph row by
 * package name and resolves the entry by looking up that id.
 *
 * Also checks that neither materializing the factory nor calling `apply()` can
 * throw, since this package declares `dsh.client.immediately: true` and a thrown
 * client entry aborts the whole Web boot.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const failures = [];
const check = (ok, label, detail) => {
  if (ok) return;
  failures.push(detail === undefined ? label : `${label} — ${detail}`);
};

const registrations = [];
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration);
    },
  },
};

await import('../client.js');

check(registrations.length === 1, 'bundle registers exactly once', `got ${registrations.length}`);
const reg = registrations[0];
check(reg !== undefined, 'bundle registered a factory');
check(
  reg?.id === pkg.name,
  'module id equals package name',
  `id=${JSON.stringify(reg?.id)} name=${JSON.stringify(pkg.name)}`,
);

// A duplicate fetch of the same bundle must not be produced by this file itself.
const seen = new Set();
for (const r of registrations) {
  check(!seen.has(r.id), 'no duplicate factory id registered', r.id);
  seen.add(r.id);
}

// A missing `react` must degrade to an inert module instead of throwing.
const inert = reg.factory(() => {
  throw new Error('react unavailable');
});
check(typeof inert?.apply === 'function', 'missing react still yields an apply()');
try {
  inert.apply({ slots: { inject() { throw new Error('must not run'); }, register() {} } });
} catch (error) {
  check(false, 'missing react: apply() must not throw', String(error));
}

// The real face: materialize with react present and register the card.
const fakeReact = {
  createElement: (...args) => ({ args }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
};
const mod = reg.factory((specifier) => {
  if (specifier === 'react') return fakeReact;
  throw new Error(`unexpected external require: ${specifier}`);
});
check(typeof mod?.apply === 'function', 'module exports apply()');
check(Array.isArray(mod?.inject) && mod.inject.includes('slots'), 'module injects slots');

// apply() must tolerate every degraded context.
for (const [label, ctx] of [
  ['undefined ctx', undefined],
  ['null ctx', null],
  ['ctx without slots', {}],
  ['slots without inject/register', { slots: {} }],
]) {
  try {
    mod.apply(ctx);
  } catch (error) {
    check(false, `apply(${label}) must not throw`, String(error));
  }
}

// A realistic context must register the Plugins-page card with the exact
// documented option set — the slot contract is { id, order, label }, nothing else.
let registered;
let injectedSlot;
mod.apply({
  slots: {
    inject(slotName, register) {
      injectedSlot = slotName;
      register();
    },
    register(options) {
      registered = options;
      return () => {};
    },
  },
});
check(injectedSlot === 'plugins.item', 'injects plugins.item', String(injectedSlot));
check(registered !== undefined, 'card was registered');
check(
  registered !== undefined && Object.keys(registered).sort().join(',') === 'id,label,name,order',
  'card options match the slot contract {name,id,order,label}',
  JSON.stringify(registered === undefined ? null : Object.keys(registered)),
);

if (failures.length > 0) {
  console.error('client.js loader contract: FAIL');
  for (const failure of failures) console.error('  -', failure);
  process.exitCode = 1;
} else {
  console.log('client.js loader contract: ok');
  console.log(`  module id   : ${reg.id}`);
  console.log(`  registrations: ${registrations.length}`);
  console.log(`  card        : ${JSON.stringify(registered)}`);
}
