import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { decryptPayload, PayloadDecryptError } from './payload-crypto.util';

export const ENCRYPTED_HEADER = 'x-encrypted';

// Runs after Nest's built-in JSON body parser, before routing/validation —
// swaps req.body from the { payload: "<iv>.<ciphertext>" } envelope to the
// real decrypted object, so DTOs/controllers downstream see plain JSON as
// if nothing changed. Marks the request so EncryptedResponseInterceptor
// knows to encrypt the reply the same way.
//
// Deliberately responds directly (res.status().json()) instead of throwing
// a Nest HttpException: this runs as plain Express middleware via app.use(),
// outside Nest's own request-dispatch wrapping, so thrown errors here are
// NOT reliably caught by Nest's global exception filter — Express would
// fall back to its default (unstyled, non-JSON) error handler instead.
@Injectable()
export class EncryptedPayloadMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    if (req.headers[ENCRYPTED_HEADER] !== '1') {
      return next();
    }

    (req as Request & { isEncrypted?: boolean }).isEncrypted = true;

    const envelope = (req.body as { payload?: unknown } | undefined)?.payload;
    if (typeof envelope !== 'string') {
      res.status(400).json({ statusCode: 400, message: 'Missing encrypted payload' });
      return;
    }

    try {
      req.body = decryptPayload(envelope, req.method, req.path);
    } catch (err) {
      const message = err instanceof PayloadDecryptError ? err.message : 'Failed to decrypt payload';
      res.status(400).json({ statusCode: 400, message });
      return;
    }

    next();
  }
}
