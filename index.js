#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

yargs(hideBin(process.argv))
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
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Tampilkan log lebih detail',
  })
  .demandCommand(1, 'enter 1 command')
  .help()
  .alias('help', 'h')
  .parse();
