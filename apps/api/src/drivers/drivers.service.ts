import { Injectable } from '@nestjs/common';
import { AuditService, diffOf } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { DriversRepository } from './drivers.repository.js';
import type { DriverFilters, DriverListRow, DriverPatch, DriverRow } from './drivers.repository.js';

export interface DriverInput {
  name: string;
  phone?: string | null;
  car_number?: string | null;
  notes?: string | null;
  /** Saves a phone another driver already has, after the warning was seen (as in the Pallet system). */
  confirm_duplicate_phone?: boolean;
}

export interface DriverDto {
  id: string;
  name: string;
  phone: string | null;
  car_number: string | null;
  notes: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
  /** On the list only: the date of the driver's newest sale or purchase. */
  last_order_date?: string | null;
}

/**
 * Drivers (D-105): who takes an order to the company. A driver is a record like a company — a
 * name, a phone, a car number — created, edited and deactivated with History of every change;
 * never deleted, because the orders that name them keep naming them.
 */
@Injectable()
export class DriversService {
  constructor(
    private readonly database: Database,
    private readonly drivers: DriversRepository,
    private readonly audit: AuditService,
  ) {}

  async list(filters: DriverFilters): Promise<{ items: DriverDto[]; total: number }> {
    const { rows, total } = await this.drivers.list(filters);
    return { items: rows.map(toDriverDto), total };
  }

  async get(id: string): Promise<DriverDto> {
    const row = await this.drivers.findById(id);
    if (!row) throw ApiError.notFound();
    return toDriverDto(row);
  }

  async create(context: RequestContext, input: DriverInput): Promise<DriverDto> {
    const fields = cleaned(input);
    const created = await this.database.transaction(async (tx) => {
      await this.assertPhoneFree(fields.phone, null, input.confirm_duplicate_phone, tx);
      const row = await this.drivers.create({ ...fields, created_by: context.userId }, tx);
      await this.audit.record(
        context,
        {
          action: 'create',
          entity_type: 'driver',
          entity_id: row.id,
          entity_label: `Driver: ${row.name}`,
          changes: {
            name: { old: null, new: row.name },
            phone: { old: null, new: row.phone },
            car_number: { old: null, new: row.car_number },
          },
          related: { driver_id: row.id },
        },
        tx,
      );
      return row;
    });
    return toDriverDto(created);
  }

  async update(
    context: RequestContext,
    id: string,
    input: Partial<DriverInput> & { version: number },
  ): Promise<DriverDto> {
    const updated = await this.database.transaction(async (tx) => {
      const before = await this.drivers.lock(id, tx);
      if (!before) throw ApiError.notFound();

      const patch: DriverPatch = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
      if (input.car_number !== undefined) patch.car_number = input.car_number?.trim() || null;
      if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
      if (patch.name === '') throw requiredName();
      if (patch.phone !== undefined && patch.phone !== before.phone) {
        await this.assertPhoneFree(patch.phone, id, input.confirm_duplicate_phone, tx);
      }

      const row = await this.drivers.update(id, input.version, patch, context.userId, tx);
      if (!row) throw await this.versionConflict(id);

      const changes = diffOf({ ...before } as Record<string, unknown>, patch, [
        'name',
        'phone',
        'car_number',
        'notes',
      ]);
      if (Object.keys(changes).length > 0) {
        await this.audit.record(
          context,
          {
            action: 'update',
            entity_type: 'driver',
            entity_id: id,
            entity_label: `Driver: ${row.name}`,
            changes,
            related: { driver_id: id },
          },
          tx,
        );
      }
      return row;
    });
    return toDriverDto(updated);
  }

  /**
   * Deactivating a driver takes them off the order form's picker; the orders that already name
   * them keep doing so, and an order edited later may keep them (D-105).
   */
  async setActive(
    context: RequestContext,
    id: string,
    isActive: boolean,
    input: { version: number; note?: string | null },
  ): Promise<DriverDto> {
    const updated = await this.database.transaction(async (tx) => {
      const before = await this.drivers.lock(id, tx);
      if (!before) throw ApiError.notFound();
      if (before.is_active === isActive) return before;

      const row = await this.drivers.update(
        id,
        input.version,
        { is_active: isActive },
        context.userId,
        tx,
      );
      if (!row) throw await this.versionConflict(id);
      await this.audit.record(
        context,
        {
          action: 'status_change',
          entity_type: 'driver',
          entity_id: id,
          entity_label: `Driver: ${row.name}`,
          changes: { is_active: { old: before.is_active, new: isActive } },
          note: input.note?.trim() || null,
          related: { driver_id: id },
        },
        tx,
      );
      return row;
    });
    return toDriverDto(updated);
  }

  /**
   * The driver an order or a purchase is being saved with, held for the transaction so a deactivation cannot
   * slip in between the check and the save. A new choice must be an active driver; the driver a
   * document already had may stay on it after being deactivated (`current`).
   */
  async requireForDocument(
    tx: Db,
    id: string | null,
    current: string | null = null,
  ): Promise<DriverRow | null> {
    if (!id) return null;
    const row = await this.drivers.holdForOrder(id, tx);
    if (!row) {
      throw ApiError.validation([
        {
          path: 'driver_id',
          code: 'NOT_FOUND',
          message_key: 'errors:driver_not_found',
          params: {},
        },
      ]);
    }
    if (!row.is_active && id !== current) {
      throw ApiError.validation([
        {
          path: 'driver_id',
          code: 'INACTIVE',
          message_key: 'errors:driver_inactive',
          params: { name: row.name },
        },
      ]);
    }
    return row;
  }

  /** A driver's name for History and the order, without the lock (the order already holds it). */
  async nameOf(id: string | null, tx?: Db): Promise<string | null> {
    if (!id) return null;
    return (await this.drivers.findById(id, tx))?.name ?? null;
  }

  /**
   * A phone another driver already has is a warning the user answers, as in the Pallet system:
   * refused once with who has it, saved when the request says the warning was seen.
   */
  private async assertPhoneFree(
    phone: string | null,
    exceptId: string | null,
    confirmed: boolean | undefined,
    tx: Db,
  ): Promise<void> {
    if (!phone || confirmed) return;
    const others = await this.drivers.withPhone(phone, exceptId, tx);
    if (others.length === 0) return;
    throw ApiError.validation([
      {
        path: 'phone',
        code: 'DUPLICATE_PHONE',
        message_key: 'errors:driver_phone_duplicate',
        params: { drivers: others },
      },
    ]);
  }

  private async versionConflict(id: string): Promise<ApiError> {
    const current = await this.drivers.findById(id);
    return new ApiError('VERSION_CONFLICT', {
      entity: 'driver',
      version: current?.version ?? null,
    });
  }
}

function cleaned(input: DriverInput) {
  const name = input.name.trim();
  if (name === '') throw requiredName();
  return {
    name,
    phone: input.phone?.trim() || null,
    car_number: input.car_number?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

function requiredName(): ApiError {
  return ApiError.validation([
    {
      path: 'name',
      code: 'REQUIRED',
      message_key: 'errors:field.required',
      params: { field: 'name' },
    },
  ]);
}

function toDriverDto(row: DriverRow | DriverListRow): DriverDto {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    car_number: row.car_number,
    notes: row.notes,
    is_active: row.is_active,
    version: row.version,
    created_at: row.created_at.toISOString(),
    ...('last_order_date' in row ? { last_order_date: row.last_order_date } : {}),
  };
}
