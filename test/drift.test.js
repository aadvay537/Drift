// Minimal check that the drift rules are deterministic and catch escalation.
import { computeDrift } from '../public/drift.js';
import { mockLabel } from '../agent.js';
import { readFileSync } from 'node:fs';

const sample = JSON.parse(readFileSync(new URL('../public/sample-data.json', import.meta.url)));
const labeled = sample.items.map((it, i) => {
  const { topic, intensity } = mockLabel({ id: i, title: it.title });
  return { title: it.title, topic, intensity, durationSec: it.durationSec, watchedAt: it.watchedAt };
});

const a = computeDrift(labeled);
const b = computeDrift(labeled);

let pass = true;
function assert(cond, msg) { if (!cond) { pass = false; console.error('  ✗', msg); } else console.log('  ✓', msg); }

assert(JSON.stringify(a) === JSON.stringify(b), 'same input → identical output (deterministic)');
assert(a.type !== 'insufficient', `classified the sample (got "${a.type}", ${a.percent}%)`);
assert(['escalation', 'engagement', 'narrowing', 'mixed'].includes(a.type), 'returns a known drift type');
assert(a.confidence && ['low', 'medium', 'high'].includes(a.confidence), `has confidence: ${a.confidence}`);
assert(computeDrift([]).type === 'insufficient', 'empty input → insufficient (honest)');

console.log(`\ndrift rules: ${pass ? 'ALL PASS' : 'FAILURES'} — sample classified as "${a.type}" (+${a.percent}% ${a.metric}), ${a.confidence} confidence, ${a.coverageDays}d`);
process.exit(pass ? 0 : 1);
