import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { COMMON_PASSWORDS } from './common-passwords.js';

/** Argon2id with the parameters of specification 2.8: 64 MB, 3 iterations, parallelism 1. */
export const ARGON2_OPTIONS = {
  algorithm: 2 as const, // Argon2id
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
};

export interface PasswordProblem {
  code: 'TOO_SHORT' | 'TOO_COMMON' | 'IS_USERNAME';
  message_key: string;
}

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Password rules (FR-108): at least 8 characters, no composition rules — a long phrase beats
 * a short one with a symbol — but the most common passwords and the username itself are
 * refused, because those are what an attacker tries first.
 */
export function checkPasswordRules(password: string, username: string): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { code: 'TOO_SHORT', message_key: 'errors:field.too_short' };
  }
  if (password.toLowerCase() === username.toLowerCase()) {
    return { code: 'IS_USERNAME', message_key: 'errors:field.password_is_username' };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { code: 'TOO_COMMON', message_key: 'errors:field.password_too_common' };
  }
  return null;
}

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, ARGON2_OPTIONS);
  }

  async verify(storedHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(storedHash, plain, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }

  /**
   * A temporary password the admin can read out once (FR-108, FR-201). Readable, but drawn
   * from `crypto.randomInt`, never `Math.random`: this string is a credential, and
   * `Math.random` is predictable from previous outputs.
   *
   * Three words from a 24-word list plus four digits is about 32 bits of entropy, which is
   * ample for a one-use password that must be changed at first sign-in and is protected by
   * the five-attempt lockout.
   */
  generateTemporary(): string {
    const words = [
      'balance', 'copper', 'ledger', 'market', 'orange', 'pencil', 'silver', 'window',
      'anchor', 'basket', 'candle', 'desert', 'engine', 'forest', 'garden', 'harbour',
      'island', 'jacket', 'kettle', 'lantern', 'meadow', 'needle', 'pepper', 'quarry',
    ];
    const pick = () => words[randomInt(words.length)] as string;
    return `${pick()}-${pick()}-${pick()}-${randomInt(1000, 10_000)}`;
  }
}
