import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import { DEFAULT_SETTINGS, I0_EDITABLE_KEYS, SETTING_SCHEMAS } from './settings.types.js';
import type { SettingKey, Settings } from './settings.types.js';

@Injectable()
export class SettingsService {
  /** Settings are read on nearly every request; a short cache keeps that off the database. */
  private cache: { values: Settings; expiresAt: number } | null = null;
  private static readonly CACHE_MS = 5_000;

  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  async all(): Promise<Settings> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.values;

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
    const settings = values as Settings;
    this.cache = { values: settings, expiresAt: Date.now() + SettingsService.CACHE_MS };
    return settings;
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
        if (!I0_EDITABLE_KEYS.includes(settingKey)) {
          throw ApiError.validation([
            { path: key, code: 'NOT_EDITABLE', message_key: 'errors:field.required', params: { field: key } },
          ]);
        }
        const schema = SETTING_SCHEMAS[settingKey];
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
          throw ApiError.validation([
            { path: key, code: 'INVALID', message_key: 'errors:field.required', params: { field: key } },
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

    this.cache = null;
    return this.all();
  }
}
