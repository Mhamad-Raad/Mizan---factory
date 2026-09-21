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

const passwordLoginSchema = z.object({
  username_or_phone: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
  is_shared_device: z.boolean().optional(),
  device_label: z.string().max(64).nullish(),
  /**
   * The ticket this browser already holds for this user, if any. Sent so the server can retire
   * it instead of leaving one live ticket per sign-in on the same tablet (FR-106).
   */
  replaces_ticket: z.string().max(200).nullish(),
});

/** The lock screen's quick sign-in: this browser's ticket plus the employee's PIN (FR-106). */
const pinLoginSchema = z.object({
  ticket: z.string().min(1).max(200),
  pin: z.string().regex(/^\d{4,6}$/),
  is_shared_device: z.boolean().optional(),
  device_label: z.string().max(64).nullish(),
  switch_from_session: z.boolean().optional(),
});

/** One route, two ways in (2.9.3): a username and password, or a ticket and a PIN. */
const loginSchema = z.union([passwordLoginSchema, pinLoginSchema]);

const pinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/).nullable(),
  current_password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  current: z.string().min(1).max(200),
  new: z.string().min(1).max(200),
});

/** Either credential unlocks the same session; the PIN is the fast one (2.8). */
const unlockSchema = z
  .object({
    password: z.string().min(1).max(200).optional(),
    pin: z.string().regex(/^\d{4,6}$/).optional(),
  })
  .refine((body) => Boolean(body.password) !== Boolean(body.pin), {
    message: 'exactly one of password or pin',
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

    // A PIN sign-in arrives with the previous employee's cookie still on the tablet — usually a
    // *locked* session, which is the whole point. The login route is public, so the guard has
    // resolved nothing: the handover resolves that cookie itself (2.8, `switch_from_session`).
    const result =
      'pin' in body
        ? await this.auth.loginWithPin(body, ctx, await this.previousSession(request))
        : await this.auth.login(body, ctx);

    response.cookie(SESSION_COOKIE, result.token, this.sessions.cookieOptions());
    // The CSRF cookie is deliberately readable by the client: that is what double-submit means.
    response.cookie(CSRF_COOKIE, randomBytes(24).toString('base64url'), {
      ...this.sessions.cookieOptions(),
      httpOnly: false,
    });
    return {
      user: result.user,
      permissions: result.permissions,
      // Handed over once, kept by this browser beside the display name, and the only reason a
      // PIN will work here for the next seven days (FR-106).
      device_ticket: 'ticket' in result ? result.ticket : undefined,
    };
  }

  private async previousSession(
    request: RequestWithContext,
  ): Promise<{ sessionId: string; userId: string } | null> {
    const token = (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token) return null;
    const session = await this.sessions.resolve(token);
    return session ? { sessionId: session.id, userId: session.user_id } : null;
  }

  /**
   * Set or clear one's own PIN (FR-106). Nobody may set anybody else's: a PIN is the thing that
   * proves it was *you* at the tablet, so an admin who could mint one could sign in as you.
   */
  @Post('pin')
  @SessionOnly()
  @HttpCode(204)
  async setPin(
    @Req() request: RequestWithContext,
    @Body(zodBody(pinSchema)) body: z.infer<typeof pinSchema>,
  ) {
    await this.auth.setPin(contextOf(request), body.pin, body.current_password);
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
    await this.auth.unlock(contextOf(request), session, { password: body.password, pin: body.pin });
  }
}
