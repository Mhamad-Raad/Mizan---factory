import { NestFactory } from '@nestjs/core';
import { MetadataScanner } from '@nestjs/core/metadata-scanner.js';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import {
  ADMIN_ONLY_KEY,
  PERMISSION_KEY,
  PUBLIC_KEY,
  SESSION_ONLY_KEY,
} from '../common/decorators.js';

export type RouteProtection =
  | { kind: 'permission'; key: string }
  | { kind: 'admin' }
  | { kind: 'session' }
  | { kind: 'public' }
  | { kind: 'none' };

export interface RouteInfo {
  controller: string;
  handler: string;
  method: string;
  path: string;
  protection: RouteProtection;
}

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

function join(...parts: string[]): string {
  const path = parts
    .filter((part) => part && part !== '/')
    .map((part) => part.replace(/^\/|\/$/g, ''))
    .join('/');
  return `/api/v1/${path}`.replace(/\/+$/, '') || '/api/v1';
}

/**
 * Every route in the application, with the decorator that protects it. Reading it from the
 * running container rather than from the source means a route cannot hide from the check by
 * being registered in an unusual way (rule 4, spec 2.6.2).
 */
export async function collectRoutes(): Promise<RouteInfo[]> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const scanner = new MetadataScanner();
    const controllers = [...(app as unknown as { container: { getModules(): Map<string, { controllers: Map<unknown, { metatype: new (...args: unknown[]) => unknown }> }> } }).container
      .getModules()
      .values()].flatMap((module) => [...module.controllers.values()]);

    const routes: RouteInfo[] = [];
    for (const wrapper of controllers) {
      const metatype = wrapper.metatype;
      if (!metatype) continue;
      const prototype = metatype.prototype as Record<string, unknown>;
      const controllerPath = (Reflect.getMetadata(PATH_METADATA, metatype) as string) ?? '';

      for (const handler of scanner.getAllMethodNames(prototype)) {
        const method = prototype[handler] as (...args: unknown[]) => unknown;
        const httpMethod = Reflect.getMetadata(METHOD_METADATA, method) as number | undefined;
        if (httpMethod === undefined) continue;
        const handlerPath = (Reflect.getMetadata(PATH_METADATA, method) as string) ?? '';

        const permission = Reflect.getMetadata(PERMISSION_KEY, method) as string | undefined;
        const adminOnly = Reflect.getMetadata(ADMIN_ONLY_KEY, method) as boolean | undefined;
        const sessionOnly = Reflect.getMetadata(SESSION_ONLY_KEY, method) as boolean | undefined;
        const isPublic = Reflect.getMetadata(PUBLIC_KEY, method) as boolean | undefined;

        const protection: RouteProtection = permission
          ? { kind: 'permission', key: permission }
          : adminOnly
            ? { kind: 'admin' }
            : sessionOnly
              ? { kind: 'session' }
              : isPublic
                ? { kind: 'public' }
                : { kind: 'none' };

        routes.push({
          controller: metatype.name,
          handler,
          method: METHOD_NAMES[httpMethod] ?? String(httpMethod),
          path: join(controllerPath, handlerPath),
          protection,
        });
      }
    }
    return routes.sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`));
  } finally {
    await app.close();
  }
}
