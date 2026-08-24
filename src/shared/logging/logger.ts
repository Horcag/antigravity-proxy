export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function write(level: LogLevel, message: string, args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const method = level === 'debug' ? console.debug : console[level];
  method(`[${timestamp}] [${level.toUpperCase()}] ${message}`, ...args);
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (process.env.AG_PROXY_LOG_LEVEL === 'debug') {
      write('debug', message, args);
    }
  },
  info(message: string, ...args: unknown[]): void {
    write('info', message, args);
  },
  warn(message: string, ...args: unknown[]): void {
    write('warn', message, args);
  },
  error(message: string, ...args: unknown[]): void {
    write('error', message, args);
  },
};
