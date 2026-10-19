/** A driver as the API sends one (D-105): who takes an order to the company. */
export interface DriverRow {
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

/** The car and the phone, as one quiet line under the name: "12 A 3456 · 0750 123 4567". */
export function driverCaption(driver: Pick<DriverRow, 'phone' | 'car_number'>): string | undefined {
  const parts = [driver.car_number, driver.phone].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
