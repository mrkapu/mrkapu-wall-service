import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { encryptPayload } from './payload-crypto.util';

// Global catch-all so encrypted requests still get an encrypted response
// even when the handler throws (validation errors, business-logic
// BadRequestExceptions, etc.) — NestInterceptor.intercept()'s map() only
// runs on the success path, so EncryptedResponseInterceptor alone would
// miss every error response for an encrypted request. The HTTP status
// code itself is always sent in the clear (needed for transport-level
// logic like 401-triggered token refresh on the client) — only the JSON
// body is encrypted.
//
// For non-encrypted requests this reproduces Nest's default exception
// response shape ({statusCode, message, error}), since registering a
// catch-all filter replaces Nest's built-in one entirely.
@Catch()
export class EncryptedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(EncryptedExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { isEncrypted?: boolean }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { statusCode: status, message: 'Internal server error' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      body = typeof response === 'string'
        ? { statusCode: status, message: response }
        : { statusCode: status, ...(response as Record<string, unknown>) };
    } else {
      this.logger.error((exception as Error)?.stack ?? exception);
    }

    if (req.isEncrypted) {
      res.status(status).json({ payload: encryptPayload(body, req.method, req.path) });
      return;
    }

    res.status(status).json(body);
  }
}
