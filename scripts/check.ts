// Validate .banana files from the command line:  npm run check -- projects/demo/demo.banana
// Exit code 0 = valid. Useful for AI agents after editing a project file.
// Library entries written as `{ id: boom, asset: explosion-sfx }` are filled in first (the asset is copied into media/).
import fs from 'node:fs';
import { parseProject } from '../src/format/parse';
import { resolveAssetRefs } from '../server/assets';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: npm run check -- <file.banana> [...]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  const assets = await resolveAssetRefs(file);
  for (const x of assets.resolved) console.log(`  copied asset "${x.asset}" → ${x.file} (library id "${x.id}")`);
  for (const e of assets.errors) console.log(`  asset error: ${e}`);
  const r = parseProject(fs.readFileSync(file, 'utf8'));
  if (r.ok) {
    const objects = r.project.tracks.reduce((n, t) => n + t.objects.length, 0);
    console.log(`✓ ${file}: valid (${r.project.tracks.length} tracks, ${objects} objects, ${r.project.library.length} library items)`);
    for (const w of r.warnings) console.log(`  warning: line ${w.line ?? '?'} ${w.path}: ${w.message}`);
  } else {
    failed = true;
    console.log(`✗ ${file}:`);
    for (const e of r.errors) console.log(`  line ${e.line ?? '?'}  ${e.path || '(root)'}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
