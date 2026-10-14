import * as crypto from 'crypto';

export type CanonicalBookingStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'CHECKED_OUT'
  | 'CANCELLED';

export interface CanonicalBooking {
  id?: string;
  tenantId: string;
  propertyId: string;
  unitId: string;
  guestName: string;
  guestEmail?: string | null;
  checkIn: string;
  checkOut: string;
  status: CanonicalBookingStatus;
  totalAmount: number;
  currency: string;
}

export interface CanonicalEnvelope<T = unknown> {
  entityType: 'booking' | 'property' | 'transaction';
  externalId: string;
  externalUpdatedAt: Date;
  rawHash: string;
  data: T;
}

export function computeCanonicalHash(data: Record<string, unknown>): string {
  const json = JSON.stringify(data, Object.keys(data).sort());
  return crypto.createHash('sha256').update(json).digest('hex');
}
