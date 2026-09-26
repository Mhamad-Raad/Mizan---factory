import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import type { Response } from 'express';
import { AllowWhenLocked, Public, SessionOnly } from '../common/decorators.js';
import { CSRF_COOKIE } from '../common/csrf.middleware.js';
import { ApiError } from '../common/errors.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { zodBody } from '../common/zod.pipe.js';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';
import { randomBytes } from 'node:crypto';

const loginSchema = z.object({
  username_or_phone: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
  is_shared_device: z.boolean().optional(),
  device_label: z.string().max(64).nullish(),
});

const changePasswordSchema = z.object({
  current: z.string().min(1).max(200),
  new: z.string().min(1).max(200),
});

/** The password unlocks the same session, keeping its drafts (2.8). */
const unlockSchema = z.object({
  password: z.string().min(1).max(200),
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Body(zodBody(loginSchema)) body: z.infer<typeof loginSchema>,
  ) {
    const ctx = {
      requestId: request.requestId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    };

    const result = await this.auth.login(body, ctx);

    response.cookie(SESSION_COOKIE, result.token, this.sessions.cookieOptions());
    // The CSRF cookie is deliberately readable by the client: that is what double-submit means.
    response.cookie(CSRF_COOKIE, randomBytes(24).toString('base64url'), {
      ...this.sessions.cookieOptions(),
      httpOnly: false,
    });
    return {
      user: result.user,
      permissions: result.permissions,
    };
  }

  @Post('logout')
  @SessionOnly()
  @AllowWhenLocked()
  @HttpCode(204)
  async logout(@Req() request: RequestWithContext, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(contextOf(request));
    response.clearCookie(SESSION_COOKIE, { path: '/' });
    response.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  @Get('me')
  @SessionOnly()
  @AllowWhenLocked()
  async me(@Req() request: RequestWithContext) {
    const session = request.session;
    if (!session) throw new ApiError('UNAUTHENTICATED');
    return this.auth.me(contextOf(request), session);
  }

  @Post('change-password')
  @SessionOnly()
  @AllowWhenLocked()
  @HttpCode(204)
  async changePassword(
    @Req() request: RequestWithContext,
    @Body(zodBody(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ) {
    await this.auth.changePassword(contextOf(request), body.current, body.new);
  }

  @Post('lock')
  @SessionOnly()
  @HttpCode(204)
  async lock(@Req() request: RequestWithContext) {
    await this.auth.lock(contextOf(request));
  }

  @Post('unlock')
  @SessionOnly()
  @AllowWhenLocked()
  @HttpCode(204)
  async unlock(
    @Req() request: RequestWithContext,
    @Body(zodBody(unlockSchema)) body: z.infer<typeof unlockSchema>,
  ) {
    const session = request.session;
    if (!session) throw new ApiError('UNAUTHENTICATED');
    await this.auth.unlock(contextOf(request), session, { password: body.password });
  }
}
