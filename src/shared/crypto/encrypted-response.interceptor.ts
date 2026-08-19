import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';
import { encryptPayload } from './payload-crypto.util';

// Wraps the controller's normal JSON return value into the same
// { payload: "<iv>.<ciphertext>" } envelope, only for requests the
// EncryptedPayloadMiddleware marked as encrypted — everything else passes
// through untouched, so this is safe to register globally while only wall
// service (the pilot) actually sends encrypted requests.
@Injectable()
export class EncryptedResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { isEncrypted?: boolean }>();
    if (!req.isEncrypted) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => ({ payload: encryptPayload(data ?? {}, req.method, req.path) })),
    );
  }
}
