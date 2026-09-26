export type UserRole = 'admin' | 'employee';

export interface UserRow {
  id: string;
  username: string;
  phone: string | null;
  display_name: string;
  role: UserRole;
  password_hash: string;
  must_change_password: boolean;
  preset_key: string | null;
  preset_version: number | null;
  is_active: boolean;
  last_login_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  version: number;
}

/** What leaves the API. `password_hash` never appears in a response. */
export interface UserDto {
  id: string;
  username: string;
  phone: string | null;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  preset_key: string | null;
  last_login_at: string | null;
  version: number;
}

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    phone: row.phone,
    display_name: row.display_name,
    role: row.role,
    is_active: row.is_active,
    must_change_password: row.must_change_password,
    preset_key: row.preset_key,
    last_login_at: row.last_login_at?.toISOString() ?? null,
    version: row.version,
  };
}

/** The directory any signed-in user may read, for "Done by" and "Assigned to" pickers (2.7). */
export interface DirectoryEntryDto {
  id: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
}
