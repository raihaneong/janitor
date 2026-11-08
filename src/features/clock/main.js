import { clearScreenDown, cursorTo } from 'node:readline';

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'full',
  timeStyle: 'medium',
});

export function runClock() {
  const { stdout } = process;

  if (!stdout.isTTY) {
    stdout.write(`${formatter.format(new Date())}\n`);
    return;
  }

  const render = () => {
    cursorTo(stdout, 0, 0);
    clearScreenDown(stdout);
    stdout.write(`JANITOR CLOCK\n${formatter.format(new Date())}\nPress Ctrl+C to exit`);
  };

  const stop = (exitCode) => {
    clearInterval(interval);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    stdout.write('\n');
    process.exitCode = exitCode;
  };

  const onInterrupt = () => stop(130);
  const onTerminate = () => stop(143);
  const interval = setInterval(render, 1000);

  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  render();
}