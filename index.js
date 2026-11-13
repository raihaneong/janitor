#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { scrapeImages } from './src/features/scraper/main.js';
import { runSharder } from './src/features/sharder/shard.js';
import { runClock } from './src/features/clock/main.js';
import { zipFolder } from './src/features/zipper/main.js';

await yargs(hideBin(process.argv))
  .scriptName('janitor')
  .usage('$0 <cmd> [args]')
  .command(
    'greet [name]',
    'greets someone',
    (yargs) => {
      return yargs.positional('name', {
        describe: 'name',
        default: 'world',
      });
    },
    (argv) => {
      console.log(`Halo, ${argv.name}!`);
    }
  )
  .command('clock', 'Show a live clock', () => { }, () => runClock())
  .command(
    'scrape <url>',
    'Download images from an authorized page',
    (yargs) => {
      return yargs
        .positional('url', {
          describe: 'Page URL to scrape',
          type: 'string',
        })
        .option('output-dir', {
          describe: 'Directory for downloaded images',
          type: 'string',
          default: 'chapter_images',
        });
    },
    async (argv) => {
      await scrapeImages(argv.url, argv.outputDir);
    }
  )
  .command(
    'shard <mode>',
    'Preview or run file sharding',
    (yargs) => {
      return yargs.positional('mode', {
        describe: 'Operation to perform',
        choices: ['dry-run', 'apply', 'apply-global'],
      });
    },
    async (argv) => {
      await runSharder([`--${argv.mode}`]);
    }
  )
  .command(
    'zip <folder_name>',
    'Zip a pointed folder',
    (yargs) => {
      return yargs
        .positional('folder_name', {
          describe: 'Folder to zip',
          type: 'string',
        })
        .option('output', {
          describe: 'Output zip file name',
          type: 'string',
        });
    },
    async (argv) => {
      try {
        await zipFolder(argv.folder_name, { output: argv.output });
      } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        process.exitCode = 1;
      }
    }
  )
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Tampilkan log lebih detail',
  })
  .strictCommands()
  .strictOptions()
  .demandCommand(1, 'enter 1 command')
  .help()
  .alias('help', 'h')
  .parseAsync();
