import { PERMISSIONS, isPermissionKey, permission, permissionsOfPage } from './catalog.js';
import type { Page } from './catalog.js';
import { EXTRAS, PRESETS } from './presets.js';
import type { Extra, ExtraKey, Preset, PresetKey } from './presets.js';

export type PermissionSet = ReadonlySet<string>;

export function toSet(keys: Iterable<string>): Set<string> {
  return new Set(keys);
}

export function assertKnownKeys(keys: Iterable<string>): void {
  for (const key of keys) {
    if (!isPermissionKey(key)) throw new Error(`unknown permission key: ${key}`);
  }
}

/**
 * The transitive closure of `implies` (spec 1.5.2 rule 5, 2.6.1). Granting an action
 * grants the view of its page; the guard expands at check time so a stored set can never
 * be subtly incomplete.
 */
export function expandImplied(keys: Iterable<string>): Set<string> {
  const result = new Set<string>();
  const pending = [...keys];
  while (pending.length > 0) {
    const key = pending.pop() as string;
    if (result.has(key)) continue;
    if (!isPermissionKey(key)) continue;
    result.add(key);
    pending.push(...permission(key).implies);
  }
  return result;
}

/** Admins hold every key implicitly and store no rows (spec 2.6.1). */
export function hasPermission(effective: PermissionSet, key: string, role: 'admin' | 'employee' = 'employee'): boolean {
  if (role === 'admin') return true;
  return effective.has(key);
}

/** Which *other* granted keys force `key` to stay on, so a refusal can name them (FR-204). */
export function keysRequiring(keys: Iterable<string>, key: string): string[] {
  const granted = toSet(keys);
  return [...granted].filter((other) => other !== key && expandImplied([other]).has(key)).sort();
}

export interface SetKeyResult {
  keys: Set<string>;
  /** Keys switched on automatically, for the editor's inline note. */
  alsoGranted: string[];
  /** Keys switched off automatically (turning off a page's View turns off its actions). */
  alsoRevoked: string[];
  /** Set when the change was refused because another granted key implies this one. */
  blockedBy?: string[];
}

/**
 * The one function both editor modes go through (spec 2.6.5).
 *
 * Turning a key **on** turns on everything it implies. Turning a key **off** is refused
 * while another granted key still implies it — `purchases.create` implies bought prices,
 * so "sees bought prices" cannot simply be switched off. Turning off a page's `view`
 * turns off that page's actions (rule 5).
 */
export function setKey(current: Iterable<string>, key: string, on: boolean): SetKeyResult {
  if (!isPermissionKey(key)) throw new Error(`unknown permission key: ${key}`);
  const keys = toSet(current);

  if (on) {
    const before = toSet(keys);
    const expanded = expandImplied([...keys, key]);
    return {
      keys: expanded,
      alsoGranted: [...expanded].filter((k) => !before.has(k) && k !== key).sort(),
      alsoRevoked: [],
    };
  }

  const definition = permission(key);
  const alsoRevoked: string[] = [];

  // Rule 5 first: turning off a page's View turns off that page's actions. Those actions
  // imply the View, so the cascade has to happen *before* the refusal check, or a page
  // could never be switched off at all.
  if (key.endsWith('.view')) {
    for (const other of permissionsOfPage(definition.page)) {
      if (other.key !== key && keys.has(other.key)) {
        keys.delete(other.key);
        alsoRevoked.push(other.key);
      }
    }
  }

  // Now refuse only if something still standing — on another page — holds this key on.
  const blockedBy = keysRequiring(keys, key);
  if (blockedBy.length > 0) {
    for (const revoked of alsoRevoked) keys.add(revoked);
    return { keys, alsoGranted: [], alsoRevoked: [], blockedBy };
  }

  keys.delete(key);
  return { keys, alsoGranted: [], alsoRevoked: alsoRevoked.sort() };
}

export type ExtraState = 'on' | 'partly' | 'off';

/**
 * An extra is *on* only when every key of its group is granted, *partly* when some are
 * (the Sales preset grants customer balances but not company balances, so "Sees balances"
 * shows partly), and *off* when none are (spec 1.5.3, FR-204).
 */
export function extraState(keys: Iterable<string>, extra: ExtraKey | Extra): ExtraState {
  const definition = typeof extra === 'string' ? extraByKey(extra) : extra;
  const granted = expandImplied(keys);
  const held = definition.keys.filter((key) => granted.has(key)).length;
  if (held === definition.keys.length) return 'on';
  return held === 0 ? 'off' : 'partly';
}

export function extraByKey(key: ExtraKey): Extra {
  const found = EXTRAS.find((extra) => extra.key === key);
  if (!found) throw new Error(`unknown extra: ${key}`);
  return found;
}

export interface ApplyExtraResult extends SetKeyResult {
  state: ExtraState;
}

/** Toggling an extra applies `setKey` to each key of its group, collecting the notes. */
export function applyExtra(current: Iterable<string>, extra: ExtraKey, on: boolean): ApplyExtraResult {
  const definition = extraByKey(extra);
  let keys = toSet(current);
  const alsoGranted = new Set<string>();
  const alsoRevoked = new Set<string>();
  const blockedBy = new Set<string>();

  for (const key of definition.keys) {
    const result = setKey(keys, key, on);
    keys = result.keys;
    result.alsoGranted.forEach((k) => alsoGranted.add(k));
    result.alsoRevoked.forEach((k) => alsoRevoked.add(k));
    result.blockedBy?.forEach((k) => blockedBy.add(k));
  }

  const out: ApplyExtraResult = {
    keys,
    alsoGranted: [...alsoGranted].filter((k) => !definition.keys.includes(k)).sort(),
    alsoRevoked: [...alsoRevoked].filter((k) => !definition.keys.includes(k)).sort(),
    state: extraState(keys, definition),
  };
  if (blockedBy.size > 0) out.blockedBy = [...blockedBy].sort();
  return out;
}

export interface PresetDiff {
  granted: string[];
  revoked: string[];
}

/** Applying a preset replaces the set and shows a diff before saving (FR-105). */
export function applyPreset(current: Iterable<string>, preset: PresetKey): { keys: Set<string>; diff: PresetDiff } {
  const before = toSet(current);
  const keys = expandImplied(PRESETS[preset].keys);
  return {
    keys,
    diff: {
      granted: [...keys].filter((key) => !before.has(key)).sort(),
      revoked: [...before].filter((key) => !keys.has(key)).sort(),
    },
  };
}

/** True when the set is exactly the preset — the editor shows "(customised)" otherwise. */
export function matchesPreset(keys: Iterable<string>, preset: PresetKey): boolean {
  const expected = expandImplied(PRESETS[preset].keys);
  const actual = expandImplied(keys);
  return expected.size === actual.size && [...expected].every((key) => actual.has(key));
}

/**
 * "Customised in Advanced": true when the set cannot be described as the preset plus the
 * state of the six extras, which is when the simple editor must send the admin to the grid.
 */
export function isCustomisedBeyondExtras(keys: Iterable<string>, preset: PresetKey | null): boolean {
  const actual = expandImplied(keys);
  const base = preset ? expandImplied(PRESETS[preset].keys) : new Set<string>();
  // An extra brings its own implied keys with it — switching on "Can void" also switches on
  // "View purchases" — so the whole expansion of the extras counts as describable.
  const extraKeys = expandImplied(EXTRAS.flatMap((extra) => extra.keys));
  for (const key of actual) if (!base.has(key) && !extraKeys.has(key)) return true;
  for (const key of base) if (!actual.has(key) && !extraKeys.has(key)) return true;
  return false;
}

export function diffSets(before: Iterable<string>, after: Iterable<string>): PresetDiff {
  const from = toSet(before);
  const to = toSet(after);
  return {
    granted: [...to].filter((key) => !from.has(key)).sort(),
    revoked: [...from].filter((key) => !to.has(key)).sort(),
  };
}

export function groupByPage(keys: Iterable<string>): Map<Page, string[]> {
  const granted = toSet(keys);
  const grouped = new Map<Page, string[]>();
  for (const definition of PERMISSIONS) {
    if (!granted.has(definition.key)) continue;
    const list = grouped.get(definition.page) ?? [];
    list.push(definition.key);
    grouped.set(definition.page, list);
  }
  return grouped;
}

export type { Preset, PresetKey, Extra, ExtraKey };
