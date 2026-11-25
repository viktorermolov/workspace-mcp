/**
 * Structured JSON logger. Never pass tokens, secrets or workspace content to it:
 * log identifiers, counts and outcomes only.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = (process.env.LOG_LEVEL as Level) || 'info';

export function setLogLevel(level: Level): void {
  threshold = level;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (order[level] < order[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
};

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
