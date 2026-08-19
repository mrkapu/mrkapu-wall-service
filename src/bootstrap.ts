import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { json } from 'express';
import type { Express } from 'express';
import { AppModule } from './app.module';
import { ENCRYPTED_HEADER, EncryptedPayloadMiddleware } from './shared/crypto/encrypted-payload.middleware';
import { EncryptedResponseInterceptor } from './shared/crypto/encrypted-response.interceptor';
import { EncryptedExceptionFilter } from './shared/crypto/encrypted-exception.filter';

export async function createApp(expressApp?: Express) {
  const app = expressApp
    ? await NestFactory.create(AppModule, new ExpressAdapter(expressApp))
    : await NestFactory.create(AppModule);

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:4000',
      'http://localhost:7070',
      'http://127.0.0.1:7070',
      'http://127.0.0.1:4000',
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', ENCRYPTED_HEADER],
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  // Nest's own default body-parser is registered internally during
  // app.init() below — which runs after this function's app.use() calls,
  // so it would run AFTER (not before) our encryption middleware, leaving
  // req.body as an unparsed raw Buffer when the latter needs it as JSON.
  // Registering our own json() parser here, ahead of it, fixes the order;
  // Nest's later parser is a safe no-op once req.body is already parsed.
  app.use(json());
  const encryptedPayloadMiddleware = new EncryptedPayloadMiddleware();
  app.use((req: Parameters<EncryptedPayloadMiddleware['use']>[0], res: Parameters<EncryptedPayloadMiddleware['use']>[1], next: Parameters<EncryptedPayloadMiddleware['use']>[2]) =>
    encryptedPayloadMiddleware.use(req, res, next),
  );
  app.useGlobalInterceptors(new EncryptedResponseInterceptor());
  app.useGlobalFilters(new EncryptedExceptionFilter());

  await app.init();
  return app;
}
