
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CWD = process.cwd();
const CAPACITY = 1000;
const DELAY_MS = 10_000;

let stopRequested = false;

class ShardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ShardError';
    this.details = details;
  }
}

class GracefulStop extends Error {
  constructor() {
    super('Operation interrupted by user.');
    this.name = 'GracefulStop';
  }
}

function log(message, toError = false) {
  (toError ? console.error : console.log)(`[${toError ? 'ERROR' : 'INFO'}] ${message}`);
}

function checkStop() {
  if (stopRequested) throw new GracefulStop();
}

function relative(filePath) {
  return path.relative(CWD, filePath).split(path.sep).join('/');
}

function absolute(relativePath) {
  const result = path.resolve(CWD, ...relativePath.split('/'));

  if (result !== CWD && !result.startsWith(CWD + path.sep)) {
    throw new ShardError(`Invalid relative path: ${relativePath}`);
  }

  return result;
}

function shardName(index) {
  return String(index).padStart(4, '0');
}

async function listShards() {
  const entries = await fs.readdir(CWD, { withFileTypes: true });
  const shards = [];

  for (const entry of entries) {
    const match = entry.name.match(/^(\d+)$/);

    if (!match) continue;

    if (!entry.isDirectory()) {
      throw new ShardError('Recognized shard name is not a directory.', { path: entry.name });
    }

    shards.push({ name: entry.name, index: Number(match[1]) });
  }

  return shards.sort((a, b) => a.index - b.index);
}

async function discover(shards = []) {
  const files = [];
  const dirs = [
    { directory: CWD, shard: null },
    ...shards.map(shard => ({
      directory: path.join(CWD, shard.name),
      shard: shard.name
    }))
  ];

  for (const { directory, shard } of dirs) {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) {
        if (shard) {
          throw new ShardError('Nested directories or non-regular entries prevent safe sharding.', {
            path: path.join(directory, entry.name)
          });
        }

        continue;
      }

      const fullPath = path.join(directory, entry.name);
      const stat = await fs.stat(fullPath);

      files.push({
        source: relative(fullPath),
        name: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }
  }

  // Stable sort: equal mtime preserves discovery order.
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function distribute(files, names) {
  const plan = [];

  for (let i = 0; i < names.length; i++) {
    const shard = names[i];
    const assigned = files.slice(i * CAPACITY, (i + 1) * CAPACITY);
    const usedNames = new Set();

    for (const file of assigned) {
      if (usedNames.has(file.name)) {
        throw new ShardError('Filename collision inside planned shard.', {
          shard,
          filename: file.name
        });
      }

      usedNames.add(file.name);

      plan.push({
        source: file.source,
        destination: `${shard}/${file.name}`,
        shard
      });
    }
  }

  return plan;
}

async function delay() {
  const end = Date.now() + DELAY_MS;

  while (Date.now() < end) {
    checkStop();

    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function executePlan(plan, names) {
  for (const name of names) {
    checkStop();

    const items = plan.filter(item => item.shard === name);
    const total = items.length;

    log(`Waiting 10 seconds before ${name}`);
    await delay();

    log(`Processing ${name}: 0/${total}`);

    let count = 0;

    for (const item of items) {
      checkStop();

      const source = absolute(item.source);
      const destination = absolute(item.destination);

      if (source !== destination) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.link(source, destination);
        await fs.unlink(source);
      }

      count++;
      console.log(`[PROGRESS] ${name}: ${count}/${total}`);
    }
  }
}

async function assertMissing(name) {
  try {
    await fs.access(path.join(CWD, name));
    throw new ShardError('Directory already exists.', { directory: name });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function startIncremental(shards) {
  const files = await discover();

  if (!files.length) {
    log('No eligible root files found.');
    return;
  }

  const firstIndex = Math.max(0, ...shards.map(shard => shard.index)) + 1;
  const count = Math.ceil(files.length / CAPACITY);
  const names = Array.from({ length: count }, (_, i) => shardName(firstIndex + i));

  for (const name of names) {
    await assertMissing(name);
  }

  log(`Discovered ${files.length} files.`);
  log(`Planned ${count} shards.`);

  await executePlan(distribute(files, names), names);
}

async function startGlobal(shards) {
  // Move old shard directories out of the way so the new layout starts clean.
  const tempDirs = [];

  for (const shard of shards) {
    const temp = `.shard-old-${shard.name}`;

    await assertMissing(temp);
    await fs.rename(path.join(CWD, shard.name), path.join(CWD, temp));

    tempDirs.push({ name: temp });
  }

  const files = await discover(tempDirs);
  const count = Math.ceil(files.length / CAPACITY);
  const names = Array.from({ length: count }, (_, i) => shardName(i + 1));

  log(`Discovered ${files.length} files globally.`);
  log(`Planned ${count} shards.`);

  await executePlan(distribute(files, names), names);

  log('Waiting 10 seconds before retiring old shards.');
  await delay();

  for (const temp of tempDirs) {
    try {
      await fs.rmdir(path.join(CWD, temp.name));
      log(`Retired ${temp.name}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

async function dryRun() {
  const shards = await listShards();
  const files = await discover();
  const count = Math.ceil(files.length / CAPACITY);
  const firstIndex = Math.max(0, ...shards.map(shard => shard.index)) + 1;

  console.log('\nIncremental dry run');
  console.log('-------------------');
  console.log(`Eligible files: ${files.length}`);
  console.log(`Shard capacity: ${CAPACITY}`);
  console.log(`Required shards: ${count}`);

  for (let i = 0; i < count; i++) {
    const amount = Math.min(CAPACITY, files.length - i * CAPACITY);

    console.log(`${shardName(firstIndex + i)}: ${amount} files`);
  }
}

function help() {
  console.log(`
File Sharding Utility

Usage:
  node shard.js
  node shard.js --help
  node shard.js --dry-run
  node shard.js --apply
  node shard.js --apply-global

Options:
  --help          Display help
  --dry-run       Preview incremental sharding
  --apply         Execute incremental sharding
  --apply-global  Restructure all recognized shards

Shard capacity: ${CAPACITY}
Delay: ${DELAY_MS / 1000} seconds
`);
}

async function main(args) {
  if (args.length === 0 || args.includes('--help')) {
    if (args.length > 1) {
      throw new ShardError('--help cannot be combined with other arguments.');
    }

    help();
    return;
  }

  const allowed = ['--dry-run', '--apply', '--apply-global'];

  if (args.length !== 1 || !allowed.includes(args[0])) {
    throw new ShardError('Use exactly one valid operational flag.');
  }

  if (args[0] === '--dry-run') {
    await dryRun();
    return;
  }

  const shards = await listShards();

  if (args[0] === '--apply') {
    await startIncremental(shards);
  } else {
    await startGlobal(shards);
  }
}

export async function runSharder(args = process.argv.slice(2)) {
  const handleSignal = () => {
    if (stopRequested) return;

    stopRequested = true;
    log('Interrupt requested. Finishing current file operation.');
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    await main(args);
  } catch (err) {
    if (err instanceof GracefulStop || stopRequested) {
      log('Operation interrupted. Progress preserved for recovery.');
      process.exitCode = 130;
      return;
    }

    log(err.message, true);

    if (err.details && Object.keys(err.details).length) {
      console.error(err.details);
    }

    log('Operation aborted. Inspect the filesystem before retrying.', true);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSharder();
}
