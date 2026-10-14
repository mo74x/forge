import { z } from 'zod';

export const CanonicalFieldEnum = z.enum([
  'propertyId',
  'unitId',
  'guestName',
  'guestEmail',
  'checkIn',
  'checkOut',
  'status',
  'totalAmount',
  'currency',
]);
export type CanonicalFieldName = z.infer<typeof CanonicalFieldEnum>;

export const TransformSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('identity'),
  }),
  z.object({
    kind: z.literal('isoDate'),
    inputFormat: z.enum(['ISO_STRING', 'YYYY_MM_DD', 'EPOCH_SECONDS', 'EPOCH_MS', 'YMD_OBJECT']),
    timezone: z.string().optional(),
  }),
  z.object({
    kind: z.literal('ymdObjectToIso'),
    yearKey: z.string().default('y'),
    monthKey: z.string().default('m'),
    dayKey: z.string().default('d'),
  }),
  z.object({
    kind: z.literal('isoToYmdObject'),
    yearKey: z.string().default('y'),
    monthKey: z.string().default('m'),
    dayKey: z.string().default('d'),
  }),
  z.object({
    kind: z.literal('centsToDecimal'),
    scale: z.number().int().min(0).max(4).default(2),
  }),
  z.object({
    kind: z.literal('decimalToCents'),
    scale: z.number().int().min(0).max(4).default(2),
  }),
  z.object({
    kind: z.literal('decimalStringToNumber'),
  }),
  z.object({
    kind: z.literal('numberToDecimalString'),
    decimals: z.number().int().default(2),
  }),
  z.object({
    kind: z.literal('uppercase'),
  }),
  z.object({
    kind: z.literal('enumMap'),
    map: z.record(z.string(), z.string()),
    onUnknown: z.enum(['error', 'default', 'flag']),
    defaultValue: z.string().optional(),
  }),
  z.object({
    kind: z.literal('concat'),
    paths: z.array(z.string()).min(2),
    separator: z.string().default(' '),
  }),
  z.object({
    kind: z.literal('splitIndex'),
    separator: z.string().default(' '),
    index: z.number().int().min(0),
    joinRemainder: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('custom'),
    reason: z.string().min(5),
    code: z.string().min(1), 
  }),
]);
export type TransformSpec = z.infer<typeof TransformSpecSchema>;

export const FieldMappingSchema = z.object({
  canonicalField: CanonicalFieldEnum,
  source: z.object({
    path: z.string().startsWith('$.', 'Path must be a valid JSONPath starting with "$."'),
    fallbackPaths: z.array(z.string().startsWith('$.')).default([]),
  }),
  transform: TransformSpecSchema,
  required: z.boolean(),
  confidence: z.number().min(0).max(1).default(0), // Overwritten deterministically by Forge
  evidence: z.array(z.string()).default([]),
});
export type FieldMapping = z.infer<typeof FieldMappingSchema>;

export const ReverseFieldMappingSchema = z.object({
  targetPath: z.string().startsWith('$.'),
  canonicalField: CanonicalFieldEnum,
  transform: TransformSpecSchema,
});
export type ReverseFieldMapping = z.infer<typeof ReverseFieldMappingSchema>;

export const WebhookSpecSchema = z.object({
  algorithm: z.enum(['hmac-sha256', 'hmac-sha1-body', 'none']),
  signatureHeader: z.string().optional(),
  timestampHeader: z.string().optional(),
  bodySignatureKey: z.string().optional(),
  eventIdSource: z.object({
    location: z.enum(['header', 'body']),
    keyOrPath: z.string(),
  }),
  timestampSource: z.object({
    location: z.enum(['header', 'body']),
    keyOrPath: z.string(),
    format: z.enum(['EPOCH_SECONDS', 'ISO_STRING']),
  }),
});
export type WebhookSpec = z.infer<typeof WebhookSpecSchema>;

export const MappingSpecSchema = z.object({
  provider: z.string().regex(/^[a-z0-9_]+$/),
  entity: z.enum(['booking', 'property', 'transaction']).default('booking'),
  externalIdPath: z.string().startsWith('$.'),
  externalUpdatedAtPath: z.string().startsWith('$.'),
  fields: z.array(FieldMappingSchema),
  reverse: z.array(ReverseFieldMappingSchema),
  statusLossy: z.boolean().default(false),
  unmappedPolicy: z.literal('capture').default('capture'),
  webhook: WebhookSpecSchema,
});
export type MappingSpec = z.infer<typeof MappingSpecSchema>;