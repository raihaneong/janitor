import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import extract from 'extract-zip';
import yauzl from 'yauzl';

function log(message, toError = false) {
  (toError ? console.error : console.log)(`[${toError ? 'ERROR' : 'INFO'}] ${message}`);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

async function walkFiles(dir, rootDir = dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full, rootDir)));
    } else {
      const stat = await fs.promises.stat(full);
      files.push({
        name: path.relative(rootDir, full).split(path.sep).join('/'),
        size: stat.size,
      });
    }
  }

  return files;
}

export async function zipFolder(folderName, options = {}) {
  const CWD = process.cwd();
  const source = path.resolve(CWD, folderName);

  const stat = await fs.promises.stat(source).catch(() => null);

  if (!stat) {
    throw new Error(`Folder not found: ${folderName}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Not a folder: ${folderName}`);
  }

  const outputName =
    options.output || `${path.basename(source)}.zip`;
  const outputPath = path.resolve(CWD, outputName);

  if (outputPath === source || outputPath.startsWith(source + path.sep)) {
    throw new Error('Output zip must not be inside the target folder');
  }

  if (!options.apply) {
    const files = await walkFiles(source);
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    log(
      `[DRY-RUN] Would compress ${path.relative(CWD, source)} -> ${path.relative(CWD, outputPath)} ` +
      `(${files.length} files, ${formatSize(totalSize)}). Use --apply to execute.`
    );

    for (const file of files) {
      console.log(`  ${file.name} (${formatSize(file.size)})`);
    }

    return;
  }

  const output = fs.createWriteStream(outputPath);
  const archive = new ZipArchive({ zlib: { level: options.level ?? 9 } });

  const closed = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
  });

  archive.on('warning', (err) => {
    log(err.message, true);
  });

  archive.on('error', (err) => {
    log(err.message, true);
  });

  archive.pipe(output);
  archive.directory(source, path.basename(source));

  await archive.finalize();
  await closed;

  const size = (archive.pointer() / 1024 / 1024).toFixed(2);
  log(`Created ${path.relative(CWD, outputPath)} (${size} MB)`);
}

export async function unzipFile(zipFileName, options = {}) {
  const CWD = process.cwd();
  const source = path.resolve(CWD, zipFileName);

  const stat = await fs.promises.stat(source).catch(() => null);

  if (!stat) {
    throw new Error(`Zip file not found: ${zipFileName}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Not a file: ${zipFileName}`);
  }

  const baseName = path.basename(source).replace(/\.zip$/i, '');
  const outputDir = path.resolve(CWD, options.output || baseName);

  if (outputDir === source || outputDir.startsWith(source + path.sep)) {
    throw new Error('Target directory must not be inside the zip file');
  }

  const existing = await fs.promises.stat(outputDir).catch(() => null);
  if (existing && !existing.isDirectory()) {
    throw new Error(`Not a folder: ${path.relative(CWD, outputDir)}`);
  }

  const entries = await listZipEntries(source);

  if (!options.apply) {
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    const targetEmpty = !existing || (await fs.promises.readdir(outputDir)).length === 0;

    log(
      `[DRY-RUN] Would extract ${path.relative(CWD, source)} -> ${path.relative(CWD, outputDir)} ` +
      `(${entries.length} entries, ${formatSize(totalSize)}${targetEmpty ? '' : ', merges into existing folder'}). ` +
      `Use --apply to execute.`
    );

    for (const entry of entries) {
      console.log(`  ${entry.name} (${formatSize(entry.size)})`);
    }

    return;
  }

  await fs.promises.mkdir(outputDir, { recursive: true });
  await extract(source, { dir: outputDir });

  await flattenRootDir(outputDir);

  log(`Extracted ${path.relative(CWD, source)} -> ${path.relative(CWD, outputDir)}`);
}

async function flattenRootDir(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  if (entries.length !== 1 || !entries[0].isDirectory()) {
    return;
  }

  const inner = path.join(dir, entries[0].name);
  const children = await fs.promises.readdir(inner, { withFileTypes: true });

  for (const child of children) {
    await fs.promises.rename(
      path.join(inner, child.name),
      path.join(dir, child.name)
    );
  }

  await fs.promises.rmdir(inner);
}

function listZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipFile) => {
      if (err) return reject(new Error(`Cannot read zip: ${err.message}`));

      const entries = [];

      zipFile.on('entry', (entry) => {
        entries.push({ name: entry.fileName, size: entry.uncompressedSize });
        zipFile.readEntry();
      });

      zipFile.on('end', () => {
        if (entries.length === 0) {
          return reject(new Error('Zip file is empty'));
        }
        resolve(entries);
      });

      zipFile.on('error', (err) => reject(new Error(`Cannot read zip: ${err.message}`)));

      zipFile.readEntry();
    });
  });
}
