import { describe, expect, it } from 'vitest';
import { chooseRate } from './BuyFields.js';

const t = (key: string) => key;
const today = { rate: '1310', source: 'global' as const, label: 'glossary:system_rate' };

describe('the rate of a buy or an order (D-092, D-101)', () => {
  it('opens on today\'s rate and sends nothing until a different figure is typed', () => {
    const untouched = chooseRate(today, null, null, 'order', t);
    expect(untouched.chosen).toEqual(today);
    expect(untouched.differs).toBe(false);

    expect(chooseRate(today, null, '1310.0000', 'order', t).differs).toBe(false);
    const changed = chooseRate(today, null, '1450', 'order', t);
    expect(changed.differs).toBe(true);
    expect(changed.chosen).toEqual({ rate: '1450', source: 'manual', label: 'order' });
  });

  it('opens an edited order on its own saved rate, never on today\'s', () => {
    const saved = { rate: '1300.0000', source: 'company' as const };
    const untouched = chooseRate(today, saved, null, 'order', t);
    expect(untouched.chosen).toEqual({ rate: '1300.0000', source: 'company', label: 'glossary:customer_rate' });
    expect(untouched.differs).toBe(false);

    // Today's figure on an old order is a change: it would re-value it, so it is sent.
    const toToday = chooseRate(today, saved, '1310', 'order', t);
    expect(toToday.differs).toBe(true);
    expect(toToday.chosen.source).toBe('manual');
  });

  it('never uses a half-typed rate', () => {
    for (const text of ['0', '.', '', '1310.']) {
      const result = chooseRate(today, null, text, 'order', t);
      expect(result.differs).toBe(false);
      expect(result.chosen.rate).toBe('1310');
    }
  });
});
