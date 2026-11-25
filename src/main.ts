import { ConfigError, loadConfig } from './config.ts';
import { DatabaseInUseError, NewerSchemaError } from './db/db.ts';
import { createService } from './service.ts';
import { errMessage, log, setLogLevel } from './util/log.ts';

/** Server entry point: reads the environment, migrates, listens, and shuts down cleanly on SIGTERM. */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${e.message}\nSee docs/configuration.md for every setting.\n`);
      process.exit(2);
    }
    throw e;
  }
  setLogLevel(config.logLevel);
  const service = await createService(config);
  await service.listen();

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    const force = setTimeout(() => {
      log.error('shutdown timed out, exiting');
      process.exit(1);
    }, 15_000);
    force.unref();
    service
      .close()
      .then(() => {
        log.info('stopped');
        process.exit(0);
      })
      .catch((e) => {
        log.error('error during shutdown', { error: errMessage(e) });
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((e) => {
  if (e instanceof DatabaseInUseError || /database is locked/i.test(errMessage(e))) {
    process.stderr.write('The database is locked by another process. Is another instance of the service running on the same data directory?\n');
    process.exit(3);
  }
  if (e instanceof NewerSchemaError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(4);
  }
  log.error('fatal', { error: errMessage(e), stack: e instanceof Error ? e.stack : undefined });
  process.exit(1);
});
