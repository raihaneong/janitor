
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const CWD = process.cwd();
const CAPACITY = 1000;
const DELAY_MS = 10_000;

const MANIFEST = path.join(CWD, '.shard-manifest.json');
const JOURNAL = path.join(CWD, '.shard-operation.csv');
const LOCK = path.join(CWD, '.shard-lock');

const CSV_HEADER =
  'operation_id,operation,shard,created,progress,timestamp\n';

let stopRequested = false;
let lockToken = null;

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

function log(message) {
  console.log(`[INFO] ${message}`);
}

function error(message) {
  console.error(`[ERROR] ${message}`);
}

function fail(message, details = {}) {
  throw new ShardError(message, details);
}

function relative(filePath) {
  return path.relative(CWD, filePath).split(path.sep).join('/');
}

function absolute(relativePath) {
  const result = path.resolve(CWD, ...relativePath.split('/'));

  if (result !== CWD && !result.startsWith(CWD + path.sep)) {
    fail(`Invalid relative path: ${relativePath}`);
  }

  return result;
}

function isMetadata(name) {
  return (
    name === '.shard-manifest.json' ||
    name === '.shard-operation.csv' ||
    name === '.shard-lock' ||
    name.startsWith('.shard-manifest.json.tmp-')
  );
}

function shardInfo(name) {
  let match = name.match(/^shard-(\d+)$/);

  if (match) {
    return {
      name,
      index: Number(match[1])
    };
  }

  return null;
}

function compareShards(a, b) {
  return a.index - b.index;
}

async function statRecord(filePath) {
  const stat = await fs.stat(filePath);

  if (!stat.isFile()) {
    fail('Expected a regular file.', { path: filePath });
  }

  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: String(stat.dev),
    ino: String(stat.ino)
  };
}

function sameIdentity(expected, actual) {
  return (
    expected.size === actual.size &&
    Math.abs(expected.mtimeMs - actual.mtimeMs) < 1 &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino
  );
}

async function atomicWriteJSON(filePath, data) {
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;

  const handle = await fs.open(temp, 'wx');

  try {
    await handle.writeFile(JSON.stringify(data, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(temp, filePath);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

async function readManifest() {
  try {
    const raw = await fs.readFile(MANIFEST, 'utf8');
    const manifest = JSON.parse(raw);

    return manifest;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveManifest(manifest) {
  manifest.updatedAt = new Date().toISOString();
  await atomicWriteJSON(MANIFEST, manifest);
}

async function listShardDirectories() {
  const entries = await fs.readdir(CWD, {
    withFileTypes: true
  });

  const shards = [];

  for (const entry of entries) {
    const info = shardInfo(entry.name);

    if (!info) continue;

    if (!entry.isDirectory()) {
      fail('Recognized shard name is not a directory.', {
        path: entry.name
      });
    }

    shards.push(info);
  }

  return shards.sort(compareShards);
}

async function scanDirectory(directory, shardName = null) {
  const entries = await fs.readdir(directory, {
    withFileTypes: true
  });

  const files = [];

  for (const entry of entries) {
    if (entry.isFile()) {
      if (!shardName && isMetadata(entry.name)) continue;

      const fullPath = path.join(directory, entry.name);

      files.push({
        source: relative(fullPath),
        name: entry.name,
        ...(await statRecord(fullPath))
      });

      continue;
    }

    if (shardName && !entry.isFile()) {
      fail(
        'Nested directories or non-regular entries prevent safe shard retirement.',
        { path: path.join(directory, entry.name) }
      );
    }
  }

  return files;
}

async function discoverIncremental() {
  return scanDirectory(CWD);
}

async function discoverGlobal(shards) {
  const files = [];

  // Root files first.
  files.push(...await scanDirectory(CWD));

  // Then shard directories in ascending numeric order.
  for (const shard of shards) {
    const directory = path.join(CWD, shard.name);

    files.push(
      ...await scanDirectory(directory, shard.name)
    );
  }

  return files;
}

function sortFiles(files) {
  // Stable sort: equal mtime preserves discovery order.
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function makeShardName(index) {
  return `shard-${String(index).padStart(4, '0')}`;
}

function distribute(files, names) {
  const plan = [];
  const shards = [];

  for (let i = 0; i < names.length; i++) {
    const assigned = files.slice(
      i * CAPACITY,
      (i + 1) * CAPACITY
    );

    const name = names[i];
    const usedNames = new Set();

    for (const file of assigned) {
      if (usedNames.has(file.name)) {
        fail('Filename collision inside planned shard.', {
          shard: name,
          filename: file.name
        });
      }

      usedNames.add(file.name);

      plan.push({
        source: file.source,
        destination: `${name}/${file.name}`,
        shard: name,
        name: file.name,
        size: file.size,
        mtimeMs: file.mtimeMs,
        dev: file.dev,
        ino: file.ino
      });
    }

    shards.push({
      name,
      count: assigned.length
    });
  }

  return { files: plan, shards };
}

function nextOperationId() {
  return crypto.randomUUID();
}

// --------------------------------------------------
// CSV JOURNAL
// --------------------------------------------------

async function ensureJournal() {
  try {
    await fs.access(JOURNAL);
  } catch {
    await fs.writeFile(JOURNAL, CSV_HEADER, {
      flag: 'wx'
    });
  }

  const content = await fs.readFile(JOURNAL, 'utf8');

  if (!content.startsWith(CSV_HEADER)) {
    fail('CSV journal has an invalid header.');
  }
}

async function journalRows() {
  const content = await fs.readFile(JOURNAL, 'utf8');
  const lines = content.trimEnd().split('\n');

  return lines.slice(1).filter(Boolean).map(line => {
    const fields = line.split(',');

    if (fields.length !== 6) {
      fail('Malformed CSV journal record.', { line });
    }

    return {
      operationId: fields[0],
      operation: fields[1],
      shard: fields[2],
      created: fields[3],
      progress: fields[4],
      timestamp: fields[5]
    };
  });
}

async function appendJournal(
  operationId,
  operation,
  shard,
  progress
) {
  const row = [
    operationId,
    operation,
    shard,
    'true',
    progress,
    new Date().toISOString()
  ].join(',') + '\n';

  const handle = await fs.open(JOURNAL, 'a');

  try {
    await handle.writeFile(row);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureCheckpoints(operation, shard, count) {
  const rows = await journalRows();

  const existing = new Set(
    rows
      .filter(r =>
        r.operationId === operation.id &&
        r.shard === shard
      )
      .map(r => r.progress)
  );

  for (const checkpoint of [250, 500, 750]) {
    if (count >= checkpoint && !existing.has(String(checkpoint))) {
      await appendJournal(
        operation.id,
        operation.type,
        shard,
        String(checkpoint)
      );
    }
  }
}

async function completeShard(operation, shard) {
  const rows = await journalRows();

  const alreadyCompleted = rows.some(r =>
    r.operationId === operation.id &&
    r.shard === shard &&
    r.progress === 'completed'
  );

  if (!alreadyCompleted) {
    await appendJournal(
      operation.id,
      operation.type,
      shard,
      'completed'
    );
  }
}

async function completeOperation(operation) {
  const rows = await journalRows();

  const alreadyCompleted = rows.some(r =>
    r.operationId === operation.id &&
    r.shard === '__operation__' &&
    r.progress === 'completed'
  );

  if (!alreadyCompleted) {
    await appendJournal(
      operation.id,
      operation.type,
      '__operation__',
      'completed'
    );
  }
}

// --------------------------------------------------
// LOCKING
// --------------------------------------------------

async function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') return true;
    throw err;
  }
}

async function acquireLock() {
  lockToken = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: crypto.randomUUID()
  };

  try {
    const handle = await fs.open(LOCK, 'wx');
    await handle.writeFile(JSON.stringify(lockToken));
    await handle.sync();
    await handle.close();
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  let existing;

  try {
    existing = JSON.parse(await fs.readFile(LOCK, 'utf8'));
  } catch {
    fail('Lock file is unreadable. Inspect it manually.', {
      path: LOCK
    });
  }

  if (await processIsAlive(existing.pid)) {
    fail('Another sharding process appears to be running.', {
      pid: existing.pid
    });
  }

  log('Removing stale lock from an interrupted process.');

  await fs.unlink(LOCK);

  const handle = await fs.open(LOCK, 'wx');
  await handle.writeFile(JSON.stringify(lockToken));
  await handle.sync();
  await handle.close();
}

async function releaseLock() {
  if (!lockToken) return;

  try {
    const existing = JSON.parse(
      await fs.readFile(LOCK, 'utf8')
    );

    if (existing.token === lockToken.token) {
      await fs.unlink(LOCK);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      error(`Could not release lock: ${err.message}`);
    }
  }

  lockToken = null;
}

// --------------------------------------------------
// SAFE FILE MOVEMENT
// --------------------------------------------------

async function inspectFile(filePath, expected) {
  try {
    const actual = await statRecord(filePath);

    if (!sameIdentity(expected, actual)) {
      fail('File identity mismatch.', {
        path: filePath,
        expected,
        actual
      });
    }

    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function moveSafely(item) {
  const source = absolute(item.source);
  const destination = absolute(item.destination);

  let sourceExists = await inspectFile(source, item);
  let destinationExists = await inspectFile(destination, item);

  if (sourceExists && destinationExists) {
    // A crash may have happened after linking but before unlinking.
    const sourceStat = await fs.stat(source);
    const destinationStat = await fs.stat(destination);

    if (
      String(sourceStat.dev) !== String(destinationStat.dev) ||
      String(sourceStat.ino) !== String(destinationStat.ino)
    ) {
      fail('Source and destination both exist with different identities.', {
        source,
        destination
      });
    }

    await fs.unlink(source);
    return;
  }

  if (!sourceExists && destinationExists) {
    return;
  }

  if (!sourceExists && !destinationExists) {
    fail('File is missing from both source and destination.', {
      source,
      destination
    });
  }

  await fs.mkdir(path.dirname(destination), {
    recursive: true
  });

  try {
    // Hard-link creation is exclusive: it cannot overwrite a destination.
    await fs.link(source, destination);
  } catch (err) {
    fail('Could not safely create destination file.', {
      source,
      destination,
      code: err.code,
      message: err.message
    });
  }

  destinationExists = await inspectFile(destination, item);

  if (!destinationExists) {
    fail('Destination verification failed.', { destination });
  }

  await fs.unlink(source);
}

// --------------------------------------------------
// RECOVERY AND VALIDATION
// --------------------------------------------------

async function inspectShard(shard, items) {
  const directory = path.join(CWD, shard);

  try {
    const stat = await fs.stat(directory);

    if (!stat.isDirectory()) {
      fail('Shard path is not a directory.', { directory });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await fs.mkdir(directory);
  }

  const entries = await fs.readdir(directory);
  const expectedNames = new Set(items.map(item => item.name));

  for (const name of entries) {
    if (!expectedNames.has(name)) {
      fail('Unexpected file or directory in shard.', {
        shard,
        name
      });
    }
  }

  let count = 0;

  for (const item of items) {
    const destination = absolute(item.destination);
    const source = absolute(item.source);

    const destinationExists = await inspectFile(destination, item);
    const sourceExists = await inspectFile(source, item);

    if (destinationExists && !sourceExists) {
      count++;
      continue;
    }

    if (destinationExists && sourceExists) {
      const a = await fs.stat(source);
      const b = await fs.stat(destination);

      if (
        String(a.dev) !== String(b.dev) ||
        String(a.ino) !== String(b.ino)
      ) {
        fail('Ambiguous source/destination conflict.', {
          source,
          destination
        });
      }

      await fs.unlink(source);
      count++;
      continue;
    }

    if (!destinationExists && !sourceExists) {
      fail('Planned file cannot be found.', {
        source,
        destination
      });
    }
  }

  return count;
}

async function validatePlan(operation) {
  for (const shard of operation.shards) {
    const items = operation.files.filter(
      item => item.shard === shard.name
    );

    for (const item of items) {
      const destination = absolute(item.destination);
      const source = absolute(item.source);

      if (!await inspectFile(destination, item)) {
        fail('Validation failed: destination missing.', {
          destination
        });
      }

      try {
        await fs.access(source);
        fail('Validation failed: source still exists.', {
          source,
          destination
        });
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }

  log('New layout validated.');
}

async function retireOldLayout(operation) {
  for (const name of operation.oldShardDirs || []) {
    const directory = path.join(CWD, name);

    try {
      await fs.rmdir(directory);
      log(`Retired ${name}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        fail('Could not retire previous shard directory.', {
          directory,
          code: err.code,
          message: err.message
        });
      }
    }
  }
}

function manifestFile(item) {
  return {
    path: item.destination,
    shard: item.shard,
    name: item.name,
    size: item.size,
    mtimeMs: item.mtimeMs,
    dev: item.dev,
    ino: item.ino
  };
}

async function finalizeOperation(manifest, operation) {
  await validatePlan(operation);

  if (operation.type === 'global') {
    await retireOldLayout(operation);
  }

  // Commit the new index while retaining the recovery plan.
  const newFiles = operation.files.map(manifestFile);

  if (operation.type === 'global') {
    manifest.files = newFiles;
  } else {
    const existing = new Set(
      manifest.files.map(item => item.path)
    );

    for (const item of newFiles) {
      if (existing.has(item.path)) {
        fail('Manifest destination already exists.', {
          path: item.path
        });
      }

      manifest.files.push(item);
    }
  }

  operation.stage = 'validated';
  await saveManifest(manifest);

  await completeOperation(operation);

  delete manifest.pendingOperation;
  await saveManifest(manifest);

  log('Operation completed successfully.');
}

// --------------------------------------------------
// OPERATION EXECUTION
// --------------------------------------------------

function checkStop() {
  if (stopRequested) throw new GracefulStop();
}

async function delay() {
  const end = Date.now() + DELAY_MS;

  while (Date.now() < end) {
    checkStop();

    await new Promise(resolve =>
      setTimeout(resolve, 200)
    );
  }
}

async function executeOperation(manifest) {
  const operation = manifest.pendingOperation;

  if (operation.stage === 'validated') {
    await finalizeOperation(manifest, operation);
    return;
  }

  log(`Resuming ${operation.type} operation ${operation.id}`);

  for (const shard of operation.shards) {
    checkStop();

    const items = operation.files.filter(
      item => item.shard === shard.name
    );

    const actualCount = await inspectShard(
      shard.name,
      items
    );

    await ensureCheckpoints(
      operation,
      shard.name,
      actualCount
    );

    if (actualCount === items.length) {
      await completeShard(operation, shard.name);
      log(`${shard.name}: completed (${actualCount})`);
      continue;
    }

    if (operation.type === 'incremental') {
      log(`Waiting 10 seconds before ${shard.name}`);
      await delay();
    }

    log(`Processing ${shard.name}: ${actualCount}/${items.length}`);

    let count = actualCount;

    for (const item of items) {
      checkStop();

      const destinationExists = await inspectFile(
        absolute(item.destination),
        item
      );

      if (!destinationExists) {
        await moveSafely(item);
        count++;

        if ([250, 500, 750].includes(count)) {
          await appendJournal(
            operation.id,
            operation.type,
            shard.name,
            String(count)
          );
        }

        console.log(
          `[PROGRESS] ${shard.name}: ${count}/${items.length}`
        );
      }
    }

    await completeShard(operation, shard.name);

    log(`${shard.name}: completed`);

    // Incremental mode delays before each next shard.
    // Global mode has one delay after all file moves.
  }

  if (operation.type === 'global') {
    log('Waiting 10 seconds before global validation.');
    await delay();
  }

  checkStop();

  await finalizeOperation(manifest, operation);
}

// --------------------------------------------------
// MANIFEST INITIALIZATION AND VALIDATION
// --------------------------------------------------

async function rebuildManifest(shards) {
  log('Manifest not found. Rebuilding from existing shards.');

  const files = [];

  for (const shard of shards) {
    const directory = path.join(CWD, shard.name);
    const entries = await fs.readdir(directory, {
      withFileTypes: true
    });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const fullPath = path.join(directory, entry.name);

      files.push({
        path: relative(fullPath),
        shard: shard.name,
        name: entry.name,
        ...(await statRecord(fullPath))
      });
    }
  }

  return {
    updatedAt: new Date().toISOString(),
    files
  };
}

async function validateManifest(manifest, shards) {
  const actual = new Map();

  for (const shard of shards) {
    const directory = path.join(CWD, shard.name);
    const entries = await fs.readdir(directory, {
      withFileTypes: true
    });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const fullPath = path.join(directory, entry.name);
      actual.set(relative(fullPath), {
        path: relative(fullPath),
        shard: shard.name,
        name: entry.name,
        ...(await statRecord(fullPath))
      });
    }
  }

  const indexed = new Map();

  for (const item of manifest.files) {
    if (indexed.has(item.path)) {
      fail('Duplicate manifest entry.', { path: item.path });
    }

    indexed.set(item.path, item);
  }

  for (const [filePath, item] of actual) {
    const expected = indexed.get(filePath);

    if (!expected) {
      fail('Filesystem file is absent from manifest.', {
        path: filePath
      });
    }

    if (!sameIdentity(expected, item)) {
      fail('Manifest metadata does not match filesystem.', {
        path: filePath
      });
    }
  }

  for (const filePath of indexed.keys()) {
    if (!actual.has(filePath)) {
      fail('Manifest references a missing file.', {
        path: filePath
      });
    }
  }
}

// --------------------------------------------------
// OPERATION PLANNING
// --------------------------------------------------

async function startIncremental(manifest, shards) {
  const files = sortFiles(await discoverIncremental());

  if (!files.length) {
    log('No eligible root files found.');
    return;
  }

  const indexes = shards
    .map(shard => shard.index);

  const firstIndex = Math.max(0, ...indexes) + 1;

  const count = Math.ceil(files.length / CAPACITY);

  const names = Array.from(
    { length: count },
    (_, i) => makeShardName(firstIndex + i)
  );

  const plan = distribute(files, names);

  for (const shard of plan.shards) {
    try {
      await fs.access(path.join(CWD, shard.name));
      fail('Planned shard directory already exists.', {
        shard: shard.name
      });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  log(`Discovered ${files.length} files.`);
  log(`Planned ${count} shards.`);

  const operation = {
    id: nextOperationId(),
    type: 'incremental',
    stage: 'moving',
    createdAt: new Date().toISOString(),
    files: plan.files,
    shards: plan.shards,
    oldShardDirs: []
  };

  manifest.pendingOperation = operation;
  await saveManifest(manifest);

  await ensureJournal();
  await executeOperation(manifest);
}

async function startGlobal(manifest, shards) {
  const files = sortFiles(await discoverGlobal(shards));

  const count = Math.ceil(files.length / CAPACITY);

  const names = Array.from(
    { length: count },
    (_, i) => makeShardName(i + 1)
  );

  const plan = distribute(files, names);

  for (const name of names) {
    try {
      await fs.access(path.join(CWD, name));
      fail('New global shard directory already exists.', {
        shard: name
      });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  log(`Discovered ${files.length} files globally.`);
  log(`Planned ${count} shards.`);

  const operation = {
    id: nextOperationId(),
    type: 'global',
    stage: 'moving',
    createdAt: new Date().toISOString(),
    files: plan.files,
    shards: plan.shards,
    oldShardDirs: shards.map(shard => shard.name)
  };

  manifest.pendingOperation = operation;
  await saveManifest(manifest);

  await ensureJournal();
  await executeOperation(manifest);
}

// --------------------------------------------------
// DRY RUN
// --------------------------------------------------

async function dryRun() {
  const shards = await listShardDirectories();
  const files = sortFiles(await discoverIncremental());

  console.log('\nIncremental dry run');
  console.log('-------------------');
  console.log(`Eligible files: ${files.length}`);
  console.log(`Shard capacity: ${CAPACITY}`);
  console.log(`Required shards: ${Math.ceil(files.length / CAPACITY)}`);

  if (!files.length) return;

  const indexes = shards
    .map(shard => shard.index);

  const firstIndex = Math.max(0, ...indexes) + 1;

  for (
    let i = 0;
    i < Math.ceil(files.length / CAPACITY);
    i++
  ) {
    const name = makeShardName(firstIndex + i);
    const amount = Math.min(
      CAPACITY,
      files.length - i * CAPACITY
    );

    console.log(`${name}: ${amount} files`);
  }
}

// --------------------------------------------------
// CLI
// --------------------------------------------------

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
      fail('--help cannot be combined with other arguments.');
    }

    help();
    return;
  }

  const allowed = [
    '--dry-run',
    '--apply',
    '--apply-global'
  ];

  if (
    args.length !== 1 ||
    !allowed.includes(args[0])
  ) {
    fail('Use exactly one valid operational flag.');
  }

  const mode = args[0];

  if (mode === '--dry-run') {
    const manifest = await readManifest();

    if (manifest?.pendingOperation) {
      log(
        'An interrupted operation exists. ' +
        'Dry-run will not modify or resume it.'
      );
      return;
    }

    await dryRun();
    return;
  }

  await acquireLock();

  try {
    const shards = await listShardDirectories();

    let manifest = await readManifest();

    if (manifest?.pendingOperation) {
      await ensureJournal();

      log('Interrupted operation detected.');
      await executeOperation(manifest);
      return;
    }

    if (!manifest) {
      manifest = await rebuildManifest(shards);
      await saveManifest(manifest);
    } else {
      await validateManifest(manifest, shards);
    }

    await ensureJournal();

    if (mode === '--apply') {
      await startIncremental(manifest, shards);
    } else {
      await startGlobal(manifest, shards);
    }
  } finally {
    await releaseLock();
  }
}

// --------------------------------------------------
// SIGNAL HANDLING
// --------------------------------------------------

export async function runSharder(args = process.argv.slice(2)) {
  const handleInterrupt = () => {
    if (stopRequested) return;

    stopRequested = true;
    log('Graceful exit requested. Finishing current file operation.');
  };

  const handleTermination = () => {
    if (stopRequested) return;

    stopRequested = true;
    log('Termination requested. Finishing current file operation.');
  };

  process.on('SIGINT', handleInterrupt);
  process.on('SIGTERM', handleTermination);

  try {
    await main(args);
  } catch (err) {
    if (err instanceof GracefulStop || stopRequested) {
      log('Operation interrupted. Progress preserved for recovery.');
      process.exitCode = 130;
      return;
    }

    error(err.message);

    if (err.details && Object.keys(err.details).length) {
      console.error(err.details);
    }

    error('Operation aborted. Inspect the filesystem before retrying.');
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleTermination);
  }
}
