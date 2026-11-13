import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';

function log(message, toError = false) {
  (toError ? console.error : console.log)(`[${toError ? 'ERROR' : 'INFO'}] ${message}`);
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
