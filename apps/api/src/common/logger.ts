import { ConsoleLogger } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';

/**
 * Structured logs (spec 2.13): one JSON object per line, carrying the request id so a user's
 * "reference" from an error screen leads straight to the line — and to the audit rows with the
 * same id. Passwords, tokens, PINs and note bodies are never logged.
 *
 * JSON rather than prose because these lines are read by a shipper years from now, not by the
 * person who wrote them.
 */
export class StructuredLogger extends ConsoleLogger implements LoggerService {
  private emit(level: string, message: unknown, context?: string, extra?: Record<string, unknown>): void {
    const line = {
      time: new Date().toISOString(),
      level,
      context: context ?? this.context ?? 'app',
      message: typeof message === 'string' ? message : JSON.stringify(message),
      ...extra,
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }

  override log(message: unknown, context?: string): void {
    this.emit('info', message, context);
  }

  override warn(message: unknown, context?: string): void {
    this.emit('warn', message, context);
  }

  override error(message: unknown, stack?: string, context?: string): void {
    this.emit('error', message, context, stack ? { stack } : undefined);
  }

  override debug(message: unknown, context?: string): void {
    if (process.env.NODE_ENV === 'production') return;
    this.emit('debug', message, context);
  }
}
