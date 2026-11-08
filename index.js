#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { scrapeImages } from './src/features/scraper/main.js';
import { runSharder } from './src/features/sharder/shard.js';

await yargs(hideBin(process.argv))
  .scriptName('janitor')
  .usage('$0 <cmd> [args]')
  .command(
    'greet [name]',
    'Menyapa seseorang',
    (yargs) => {
      return yargs.positional('name', {
        describe: 'Nama yang ingin disapa',
        default: 'Dunia',
      });
    },
    (argv) => {
      console.log(`Halo, ${argv.name}!`);
    }
  )
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
