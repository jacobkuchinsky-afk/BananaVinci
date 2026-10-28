// Rewrite .banana files in canonical form (all properties explicit, stable order):
//   npm run normalize -- projects/demo/demo.banana
import fs from 'node:fs';
import { parseProject } from '../src/format/parse';
import { serializeProject } from '../src/format/serialize';

for (const file of process.argv.slice(2)) {
  const r = parseProject(fs.readFileSync(file, 'utf8'));
  if (!r.ok) {
    console.error(`✗ ${file}`);
    for (const e of r.errors) console.error(`  line ${e.line ?? '?'} ${e.path}: ${e.message}`);
    process.exitCode = 1;
    continue;
  }
  fs.writeFileSync(file, serializeProject(r.project));
  console.log(`✓ normalized ${file}`);
}
