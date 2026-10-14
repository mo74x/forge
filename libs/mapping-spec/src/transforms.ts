import { TransformSpec } from './schema';

// Safely resolves a JSONPath like `$.primaryGuest.fullName` from an object.
export function getByPath(obj: unknown, jsonPath: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const cleanPath = jsonPath.replace(/^\$\.?/, '');
  if (!cleanPath) return obj;

  const segments = cleanPath.split('.');
  let current: any = obj;

  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

// Sets a deep value at a JSONPath like `$.primaryGuest.fullName` on a target object.
export function setByPath(target: Record<string, any>, jsonPath: string, value: unknown): void {
  const cleanPath = jsonPath.replace(/^\$\.?/, '');
  const segments = cleanPath.split('.');
  let current = target;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!(seg in current) || typeof current[seg] !== 'object' || current[seg] === null) {
      current[seg] = {};
    }
    current = current[seg];
  }

  current[segments[segments.length - 1]] = value;
}

// Collects all leaf paths in a partner payload that were NOT consumed by mapped paths
export function extractUnmappedMetadata(
  payload: Record<string, unknown>,
  mappedPaths: Set<string>,
  sensitivePatterns: RegExp[] = [/pin/i, /password/i, /secret/i, /token/i, /card/i, /cvv/i]
): Record<string, unknown> {
  const unmapped: Record<string, unknown> = {};

  function walk(current: unknown, currentPath: string) {
    if (current === null || current === undefined) return;

    if (typeof current !== 'object' || Array.isArray(current)) {
      if (!mappedPaths.has(currentPath)) {
        const isSensitive = sensitivePatterns.some((re) => re.test(currentPath));
        if (!isSensitive) {
          unmapped[currentPath] = current;
        }
      }
      return;
    }

    // If the entire object was consumed (e.g. $.checkInDate {y,m,d}), skip its children
    if (mappedPaths.has(currentPath)) return;

    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      walk(v, `${currentPath}.${k}`);
    }
  }

  walk(payload, '$');
  return unmapped;
}

// Executes a TransformSpec deterministically against a value and root object.
export function applyTransform(
  value: unknown,
  root: unknown,
  spec: TransformSpec
): unknown {
  switch (spec.kind) {
    case 'identity':
      return value ?? null;

    case 'uppercase':
      if (typeof value !== 'string') throw new Error(`Expected string for uppercase, got ${typeof value}`);
      return value.toUpperCase();

    case 'isoDate': {
      if (typeof value === 'string') {
        const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) return match[1];
        const parsed = new Date(value);
        if (isNaN(parsed.getTime())) throw new Error(`Invalid ISO date string: ${value}`);
        return parsed.toISOString().split('T')[0];
      }
      if (typeof value === 'number') {
        const ms = spec.inputFormat === 'EPOCH_SECONDS' ? value * 1000 : value;
        return new Date(ms).toISOString().split('T')[0];
      }
      throw new Error(`Unsupported value for isoDate: ${JSON.stringify(value)}`);
    }

    case 'ymdObjectToIso': {
      if (!value || typeof value !== 'object') {
        throw new Error(`Expected {y,m,d} object, got ${typeof value}`);
      }
      const obj = value as Record<string, number>;
      const y = obj[spec.yearKey];
      const m = obj[spec.monthKey];
      const d = obj[spec.dayKey];
      if (!y || !m || !d) throw new Error(`Missing y/m/d keys in ${JSON.stringify(value)}`);
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `${y}-${pad(m)}-${pad(d)}`;
    }

    case 'isoToYmdObject': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
        throw new Error(`Expected YYYY-MM-DD string, got ${value}`);
      }
      const [y, m, d] = value.split('T')[0].split('-').map(Number);
      return {
        [spec.yearKey]: y,
        [spec.monthKey]: m,
        [spec.dayKey]: d,
      };
    }

    case 'centsToDecimal': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Expected finite number for centsToDecimal, got ${value}`);
      }
      const factor = Math.pow(10, spec.scale);
      return Number((value / factor).toFixed(spec.scale));
    }

    case 'decimalToCents': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Expected finite number for decimalToCents, got ${value}`);
      }
      const factor = Math.pow(10, spec.scale);
      return Math.round(value * factor);
    }

    case 'decimalStringToNumber': {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new Error(`Expected string or number for decimalStringToNumber, got ${typeof value}`);
      }
      const num = typeof value === 'number' ? value : parseFloat(value);
      if (isNaN(num)) throw new Error(`Invalid numeric string: "${value}"`);
      return num;
    }

    case 'numberToDecimalString': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Expected number for numberToDecimalString, got ${value}`);
      }
      return value.toFixed(spec.decimals);
    }

    case 'enumMap': {
      const key = String(value);
      if (key in spec.map) {
        return spec.map[key];
      }
      if (spec.onUnknown === 'default' && spec.defaultValue !== undefined) {
        return spec.defaultValue;
      }
      throw new Error(`Unmapped enum value "${key}". Allowed: ${Object.keys(spec.map).join(', ')}`);
    }

    case 'concat': {
      const parts = spec.paths
        .map((p) => getByPath(root, p))
        .filter((v) => v !== undefined && v !== null && String(v).trim() !== '');
      return parts.join(spec.separator).trim();
    }

    case 'splitIndex': {
      if (typeof value !== 'string') return '';
      const tokens = value.trim().split(spec.separator);
      if (spec.joinRemainder) {
        return tokens.slice(spec.index).join(spec.separator) || 'Guest';
      }
      return tokens[spec.index] || 'Unknown';
    }

    case 'custom': {
      throw new Error('Custom transforms must be compiled or executed in Sandbox');
    }
  }
}