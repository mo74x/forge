export type DetectedQuirk =
  | 'ISO_DATE_STRING'
  | 'YYYY_MM_DD_STRING'
  | 'YMD_OBJECT'
  | 'EPOCH_SECONDS'
  | 'EPOCH_MS'
  | 'INTEGER_CENTS'
  | 'DECIMAL_MONEY_STRING'
  | 'CURRENCY_CODE_ISO3'
  | 'EMAIL_STRING'
  | 'ENUM_CANDIDATE'
  | 'SENSITIVE_REDACTED'
  | 'NONE';

export interface FieldProfile {
  path: string;
  presentCount: number;
  totalSamples: number;
  optional: boolean;
  inferredTypes: string[];
  quirk: DetectedQuirk;
  distinctValues: unknown[];
  sampleEvidence: string[];
  sensitive: boolean;
}

const SENSITIVE_KEY_PATTERNS = [/pin/i, /password/i, /secret/i, /token/i, /card/i, /cvv/i, /ssn/i];

export class QuirkDetector {
  static analyzeSamples(samples: Record<string, unknown>[]): Map<string, FieldProfile> {
    const totalSamples = samples.length;
    const rawMap = new Map<
      string,
      { count: number; types: Set<string>; values: unknown[]; evidence: string[] }
    >();

    // 1. Walk every sample payload and collect path statistics
    samples.forEach((sample, idx) => {
      this.walkPayload(sample, '$', (path, val) => {
        if (!rawMap.has(path)) {
          rawMap.set(path, { count: 0, types: new Set(), values: [], evidence: [] });
        }
        const entry = rawMap.get(path)!;
        entry.count++;
        entry.types.add(Array.isArray(val) ? 'array' : typeof val);
        entry.values.push(val);
        if (entry.evidence.length < 5) {
          entry.evidence.push(`sample-${idx + 1}: ${JSON.stringify(val)}`);
        }
      });
    });

    // 2. Classify quirks per path
    const profiles = new Map<string, FieldProfile>();

    for (const [path, stats] of rawMap.entries()) {
      const isSensitive = SENSITIVE_KEY_PATTERNS.some((re) => re.test(path));
      const nonNullValues = stats.values.filter((v) => v !== null && v !== undefined);
      const distinct = Array.from(new Set(nonNullValues.map((v) => JSON.stringify(v)))).map((s) =>
        JSON.parse(s)
      );

      const quirk = isSensitive
        ? 'SENSITIVE_REDACTED'
        : this.detectQuirk(path, nonNullValues, distinct);

      profiles.set(path, {
        path,
        presentCount: stats.count,
        totalSamples,
        optional: stats.count < totalSamples || stats.values.some((v) => v === null),
        inferredTypes: Array.from(stats.types),
        quirk,
        distinctValues: isSensitive ? ['[REDACTED]'] : distinct.slice(0, 10),
        sampleEvidence: isSensitive ? ['[REDACTED_SENSITIVE_FIELD]'] : stats.evidence,
        sensitive: isSensitive,
      });
    }

    return profiles;
  }

  private static walkPayload(
    current: unknown,
    currentPath: string,
    visitor: (path: string, val: unknown) => void
  ): void {
    if (current === null || current === undefined) {
      visitor(currentPath, null);
      return;
    }

    // Detect structured { y, m, d } date objects as a single composite node
    if (
      typeof current === 'object' &&
      !Array.isArray(current) &&
      'y' in current &&
      'm' in current &&
      'd' in current &&
      Object.keys(current).length === 3
    ) {
      visitor(currentPath, current);
      return;
    }

    if (typeof current !== 'object' || Array.isArray(current)) {
      visitor(currentPath, current);
      return;
    }

    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      this.walkPayload(v, `${currentPath}.${k}`, visitor);
    }
  }

  private static detectQuirk(path: string, values: unknown[], distinct: unknown[]): DetectedQuirk {
    if (values.length === 0) return 'NONE';

    // Check { y, m, d } composite date object
    if (
      values.every(
        (v) =>
          typeof v === 'object' &&
          v !== null &&
          typeof (v as any).y === 'number' &&
          typeof (v as any).m === 'number' &&
          typeof (v as any).d === 'number'
      )
    ) {
      return 'YMD_OBJECT';
    }

    // String-based checks
    if (values.every((v) => typeof v === 'string')) {
      const strVals = values as string[];

      if (strVals.every((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s))) {
        return 'ISO_DATE_STRING';
      }
      if (strVals.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))) {
        return 'YYYY_MM_DD_STRING';
      }
      if (strVals.every((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) {
        return 'EMAIL_STRING';
      }
      if (strVals.every((s) => /^[A-Za-z]{3}$/.test(s)) && /curr|code/i.test(path)) {
        return 'CURRENCY_CODE_ISO3';
      }
      if (strVals.every((s) => /^\d+\.\d{2}$/.test(s))) {
        return 'DECIMAL_MONEY_STRING';
      }
      if (/status|state|kind|type/i.test(path) && distinct.length <= 8) {
        return 'ENUM_CANDIDATE';
      }
    }

    // Number-based checks
    if (values.every((v) => typeof v === 'number')) {
      const numVals = values as number[];

      if (
        numVals.every((n) => Number.isInteger(n) && n > 100 && n % 50 === 0) ||
        /cents|minor/i.test(path)
      ) {
        return 'INTEGER_CENTS';
      }
      if (numVals.every((n) => n >= 1600000000 && n <= 2100000000)) {
        return 'EPOCH_SECONDS';
      }
      if (numVals.every((n) => n >= 1600000000000 && n <= 2100000000000)) {
        return 'EPOCH_MS';
      }
    }

    return 'NONE';
  }
}