import fs from 'fs';
import path from 'path';
import config from './config';

function createDirs() {
  for (const [name, dir] of Object.entries(config)) {
    if (!dir) {
      console.error(`Missing config value: ${name}`);
      continue;
    }
    fs.mkdirSync(path.resolve(dir), { recursive: true });
  }
}

module.exports = createDirs;