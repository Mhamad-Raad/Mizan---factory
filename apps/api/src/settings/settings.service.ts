import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import { DEFAULT_SETTINGS, EDITABLE_KEYS, SETTING_SCHEMAS } from './settings.types.js';
import type { SettingKey, Settings } from './settings.types.js';

/**
 * The system settings (FR-1107).
 *
 * They are read from the database on every request that needs them, deliberately: a setting
 * like `allow_negative_stock` is a *rule*, and a cache — even a short one
 * — means a second API replica can keep applying the old rule after an admin changed it,
 * which is the defect the I0 review found in the permission cache. The read is a primary-key
 * scan of a table with a dozen rows, which PostgreSQL answers from shared buffers.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  async all(): Promise<Settings> {
    const { rows } = await this.database.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM settings',
    );
    const values = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    for (const row of rows) {
      const schema = SETTING_SCHEMAS[row.key as SettingKey];
      if (!schema) continue; // A key the code no longer knows: ignore rather than crash.
      const parsed = schema.safeParse(row.value);
      if (parsed.success) values[row.key] = parsed.data;
    }
    return values as Settings;
  }

  async get<K extends SettingKey>(key: K): Promise<Settings[K]> {
    return (await this.all())[key];
  }

  /** Every change is logged old → new (FR-1107, rule 3). */
  async update(context: RequestContext, patch: Partial<Settings>): Promise<Settings> {
    const before = await this.all();
    const changes: Record<string, { old: unknown; new: unknown }> = {};

    await this.database.transaction(async (tx) => {
      for (const [key, value] of Object.entries(patch)) {
        const settingKey = key as SettingKey;
        if (!EDITABLE_KEYS.includes(settingKey)) {
          throw ApiError.validation([
            {
              path: key,
              code: 'NOT_EDITABLE',
              message_key: 'errors:field.required',
              params: { field: key },
            },
          ]);
        }
        const schema = SETTING_SCHEMAS[settingKey];
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
          throw ApiError.validation([
            {
              path: key,
              code: 'INVALID',
              message_key: 'errors:field.required',
              params: { field: key },
            },
          ]);
        }
        if (before[settingKey] === parsed.data) continue;

        await tx.query(
          `INSERT INTO settings (key, value, created_by, updated_by)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
          [key, JSON.stringify(parsed.data), context.userId],
        );
        changes[key] = { old: before[settingKey], new: parsed.data };
      }

      if (Object.keys(changes).length > 0) {
        await this.audit.record(
          context,
          {
            action: 'settings_change',
            entity_type: 'settings',
            entity_id: 'system',
            entity_label: 'System settings',
            changes,
          },
          tx,
        );
      }
    });

    return this.all();
  }

  // ─────────────────────────── the business on its receipts (D-108) ───────────────────────────

  /** The name, phone, address and logo every receipt is headed with; the logo as a `data:` URL. */
  async business(): Promise<{ name: string | null; phone: string | null; address: string | null; logo: string | null }> {
    const [settings, logo] = await Promise.all([
      this.all(),
      this.database.query<{ media_type: string; data: Buffer }>('SELECT media_type, data FROM business_logo'),
    ]);
    const row = logo.rows[0];
    return {
      name: settings.business_name,
      phone: settings.business_phone,
      address: settings.business_address,
      logo: row ? `data:${row.media_type};base64,${row.data.toString('base64')}` : null,
    };
  }

  /**
   * The logo, replaced. The browser has already made it receipt-sized; here it is only checked to
   * be what it says — a PNG, JPEG or WebP by its first bytes, not by its label — and small enough.
   * History records that it changed, never the picture.
   */
  async setLogo(context: RequestContext, dataUrl: string): Promise<void> {
    const picture = pictureOf(dataUrl);
    await this.database.transaction(async (tx) => {
      const { rows } = await tx.query<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM business_logo) AS exists');
      await tx.query(
        `INSERT INTO business_logo (id, media_type, data, updated_by)
         VALUES (true, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET media_type = excluded.media_type, data = excluded.data,
                                        updated_at = now(), updated_by = excluded.updated_by`,
        [picture.mediaType, picture.data, context.userId],
      );
      await this.audit.record(
        context,
        {
          action: 'settings_change',
          entity_type: 'settings',
          entity_id: 'system',
          entity_label: 'System settings',
          changes: { business_logo: { old: Boolean(rows[0]?.exists), new: true } },
        },
        tx,
      );
    });
  }

  async removeLogo(context: RequestContext): Promise<void> {
    await this.database.transaction(async (tx) => {
      const { rowCount } = await tx.query('DELETE FROM business_logo');
      if (!rowCount) return;
      await this.audit.record(
        context,
        {
          action: 'settings_change',
          entity_type: 'settings',
          entity_id: 'system',
          entity_label: 'System settings',
          changes: { business_logo: { old: true, new: false } },
        },
        tx,
      );
    });
  }
}

/** The largest logo kept, decoded: the browser sends it far smaller (D-108). */
export const LOGO_MAX_BYTES = 256 * 1024;

const SIGNATURES: readonly { mediaType: string; matches: (data: Buffer) => boolean }[] = [
  { mediaType: 'image/png', matches: (data) => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mediaType: 'image/jpeg', matches: (data) => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
  {
    mediaType: 'image/webp',
    matches: (data) => data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/** A `data:` URL's picture, or a refusal naming the field: an unknown kind, a lie about the kind, too large. */
function pictureOf(dataUrl: string): { mediaType: string; data: Buffer } {
  const refuse = (code: string, messageKey: string) =>
    ApiError.validation([{ path: 'data_url', code, message_key: messageKey, params: {} }]);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw refuse('NOT_A_PICTURE', 'errors:logo_not_a_picture');
  const mediaType = match[1] as string;
  const data = Buffer.from(match[2] as string, 'base64');
  if (data.length === 0 || data.length > LOGO_MAX_BYTES) throw refuse('TOO_LARGE', 'errors:logo_too_large');
  const signature = SIGNATURES.find((candidate) => candidate.matches(data));
  if (!signature || signature.mediaType !== mediaType) throw refuse('NOT_A_PICTURE', 'errors:logo_not_a_picture');
  return { mediaType, data };
}
