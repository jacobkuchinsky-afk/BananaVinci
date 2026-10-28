// The shared asset library from the command line (handy for AI agents and scripts).
//   npm run asset -- list [words…]                  search by name, tag, kind or description
//   npm run asset -- show <name>                    everything about one asset
//   npm run asset -- add <file-or-folder>… [--name n] [--tags a,b] [--description "…"]
//                                                   copy files into assets/ (folders are searched recursively)
//   npm run asset -- link <folder> [--tags a,b]     keep a folder where it is; its media (and anything added later) joins the library
//   npm run asset -- unlink <folder>
//   npm run asset -- tag <name> <tags>              replace an asset's tags (comma separated)
//   npm run asset -- rename <name> <new-name>
//   npm run asset -- describe <name> "<text>"
//   npm run asset -- remove <name>                  copied files go to assets/.trash/
//   npm run asset -- use <name> <project> [--id x]  copy an asset into a project and add it to the project's library
//   npm run asset -- rescan                         pick up new files in linked folders
//
// Asset requests (assets/requests.yaml): ask a human for media the library doesn't have. Each open request shows up
// as a drop box in the editor (Assets tab → Requests); dropping or pasting a file there fulfils it.
//   npm run asset -- request <name> --description "…" [--kind image|audio|video] [--tags a,b] [--project p]
//                                  [--note "how it will be used"] [--links url1,url2] [--remove-background]
//   npm run asset -- requests [open|done]            list requests and their status
//   npm run asset -- unrequest <name>                remove a request
//   npm run asset -- wait [names…] [--project p] [--any] [--timeout secs]
//                                  block until requests are filled (default: every open one, or the project's),
//                                  printing a line per fill; run it in the background to be told when the user drops a
//                                  file. Exit 0 = all filled (or the first, with --any), 3 = timed out.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ASSETS_DIR, CATALOG_FILE, REQUESTS_FILE, addRequest, loadRequests, removeRequest, addAssets, assetPath, findAsset, listAssets, loadCatalog, removeAsset, resolveAssetRefs, scanLinkedFolders, unlinkFolder, updateAsset } from '../server/assets';
import { projectFile } from '../server/projects';
import { cleanTags, searchAssets, type Asset, type AssetRequest } from '../src/format/assets';

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : '';
  else args.push(rest[i]);
}

const dur = (s?: number) => (s === undefined ? '' : `${s.toFixed(1)}s`);
const line = (a: Asset & { missing?: boolean }) =>
  `  ${a.name.padEnd(28)} ${a.kind.padEnd(6)} ${dur(a.duration).padStart(6)}  ${a.tags.length ? `[${a.tags.join(', ')}] ` : ''}${a.description}${a.missing ? '  (FILE MISSING)' : ''}`;

function usage(): never {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
  console.log(src.split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(cmd ? 2 : 0);
}

function report(r: Awaited<ReturnType<typeof addAssets>>) {
  for (const f of r.folders) console.log(`linked folder ${f}`);
  for (const a of r.added) console.log(`+ ${a.name}  (${a.kind}, ${a.file})`);
  for (const a of r.existing) console.log(`= ${a.name}  (already in the library)`);
  for (const s of r.skipped) console.log(`- skipped ${s} (not an image, video or audio file)`);
}

async function main() {
  switch (cmd) {
    case 'list':
    case 'search': {
      const { assets, folders } = listAssets();
      const found = searchAssets(assets, args.join(' '));
      console.log(`${found.length} of ${assets.length} assets in ${path.relative(process.cwd(), CATALOG_FILE)}${args.length ? ` matching "${args.join(' ')}"` : ''}`);
      for (const a of found) console.log(line(a));
      if (!args.length && folders.length) console.log(`\nlinked folders:\n${folders.map((f) => `  ${f.path}`).join('\n')}`);
      break;
    }
    case 'show': {
      const a = findAsset(loadCatalog(), args[0] ?? '');
      if (!a) throw new Error(`no asset named "${args[0]}"`);
      console.log(YAML.stringify({ ...a, path: assetPath(a), exists: fs.existsSync(assetPath(a)) }).trim());
      break;
    }
    case 'add':
      if (!args.length) usage();
      report(await addAssets(args, { name: flags.name, tags: flags.tags ? cleanTags(flags.tags) : [], description: flags.description }));
      break;
    case 'link':
      if (!args.length) usage();
      report(await addAssets(args, { link: true, tags: flags.tags ? cleanTags(flags.tags) : [] }));
      break;
    case 'unlink':
      console.log(`unlinked; removed ${await unlinkFolder(args[0] ?? '')} asset(s) from the library (files untouched)`);
      break;
    case 'tag':
      console.log(line(await updateAsset(args[0], { tags: args.slice(1).join(',') })));
      break;
    case 'rename':
      console.log(line(await updateAsset(args[0], { name: args[1] })));
      break;
    case 'describe':
      console.log(line(await updateAsset(args[0], { description: args.slice(1).join(' ') })));
      break;
    case 'remove':
      console.log(`removed ${(await removeAsset(args[0])).name}`);
      break;
    case 'use': {
      const [name, project] = args;
      if (!name || !project) usage();
      const file = projectFile(project);
      if (!file) throw new Error(`no project "${project}" in projects/`);
      const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
      const lib = (doc.toJS()?.library ?? []) as { id?: string; asset?: string }[];
      const already = lib.find((l) => l?.asset === findAsset(loadCatalog(), name)?.name);
      if (already && !flags.id) {
        console.log(`✓ already in ${path.relative(process.cwd(), file)} as library id "${already.id}"  (use it with  source: ${already.id})`);
        break;
      }
      const entry: Record<string, string> = { asset: name };
      if (flags.id) entry.id = flags.id;
      if (!YAML.isSeq(doc.get('library'))) doc.set('library', doc.createNode([]));
      (doc.get('library') as YAML.YAMLSeq).add(doc.createNode(entry));
      fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
      const r = await resolveAssetRefs(file);
      for (const x of r.resolved) console.log(`✓ ${path.relative(process.cwd(), file)}: library id "${x.id}" → ${x.file}  (use it with  source: ${x.id})`);
      if (r.errors.length) throw new Error(r.errors.join('\n'));
      break;
    }
    case 'request': {
      const name = args[0];
      if (!name) usage();
      const r = await addRequest({
        name,
        kind: (flags.kind as AssetRequest['kind']) || undefined,
        description: flags.description ?? args.slice(1).join(' '),
        tags: flags.tags,
        project: flags.project,
        note: flags.note,
        links: flags.links ? flags.links.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        removeBackground: 'remove-background' in flags ? true : undefined,
      });
      console.log(`requested ${r.kind} "${r.name}"${r.removeBackground ? ' (background will be removed)' : ''}: it now has a drop box in the editor (Assets → Requests)`);
      break;
    }
    case 'requests': {
      const all = loadRequests();
      const want = args[0];
      const list = want === 'open' || want === 'done' ? all.filter((r) => r.status === want) : all;
      const open = all.filter((r) => r.status === 'open').length;
      console.log(`${open} open, ${all.length - open} done  (${path.relative(process.cwd(), REQUESTS_FILE)})`);
      for (const r of list)
        console.log(
          `  ${r.status === 'done' ? '✓' : '·'} ${r.name.padEnd(26)} ${r.kind.padEnd(6)} ${r.status === 'done' ? `→ asset "${r.asset}"` : r.description}${r.project ? `  [${r.project}]` : ''}${r.removeBackground ? '  (cutout)' : ''}`,
        );
      break;
    }
    case 'unrequest':
      await removeRequest(args[0] ?? '');
      console.log(`removed request "${args[0]}"`);
      break;
    case 'wait': {
      const watchFor = args.length
        ? args
        : loadRequests().filter((r) => r.status === 'open' && (!flags.project || r.project === flags.project)).map((r) => r.name);
      if (!watchFor.length) {
        console.log(`no open requests${flags.project ? ` for project ${flags.project}` : ''} to wait for`);
        break;
      }
      const unknown = watchFor.filter((n) => !loadRequests().some((r) => r.name === n));
      if (unknown.length) throw new Error(`no request named ${unknown.map((n) => `"${n}"`).join(', ')}`);
      const pending = new Set(watchFor);
      console.log(`waiting for ${flags.any !== undefined ? 'any of ' : ''}${[...pending].join(', ')}…`);
      const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity;
      await new Promise<void>((resolve) => {
        const tick = () => {
          let all: AssetRequest[];
          try {
            all = loadRequests();
          } catch {
            return; // half-written or hand-edited file: try again next tick
          }
          for (const name of [...pending]) {
            const r = all.find((x) => x.name === name);
            if (!r) {
              console.log(`✗ ${name}: the request was removed`);
              pending.delete(name);
            } else if (r.status === 'done') {
              const a = findAsset(loadCatalog(), r.asset ?? name);
              console.log(`✓ ${name} → asset "${r.asset}"${a ? ` (${a.kind}, ${a.file})` : ''}${r.project ? `  add to ${r.project}'s library:  - { id: ${name}, asset: ${r.asset} }` : ''}`);
              pending.delete(name);
            }
          }
          const finished = !pending.size || (flags.any !== undefined && pending.size < watchFor.length);
          if (finished || Date.now() > deadline) {
            clearInterval(timer);
            if (!finished) {
              console.log(`timed out; still open: ${[...pending].join(', ')}`);
              process.exitCode = 3;
            } else if (pending.size) console.log(`still open: ${[...pending].join(', ')}`);
            resolve();
          }
        };
        const timer = setInterval(tick, 1000);
        tick();
      });
      break;
    }
    case 'rescan': {
      const added = await scanLinkedFolders();
      console.log(added.length ? added.map((a) => `+ ${a.name}`).join('\n') : 'nothing new in linked folders');
      break;
    }
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message ?? e}`);
  if (!fs.existsSync(ASSETS_DIR)) console.error(`  (no asset library yet at ${ASSETS_DIR})`);
  process.exit(1);
});
