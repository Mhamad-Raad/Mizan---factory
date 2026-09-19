import type { Currency } from '@mizan/money';
export interface DualAmountProps {
    amount_iqd: number;
    amount_usd_cents: number;
    /** The settlement currency, or the entered one where there is no counterparty. */
    primary?: Currency;
    /** `derived` marks the secondary figure with ≈ because it was converted, not stored. */
    kind?: 'stored' | 'derived';
    size?: 'normal' | 'large';
}
/**
 * The only way an amount is ever rendered (FR-1302, spec 2.3.6). A screen that shows a single
 * currency fails review, so there is deliberately no single-currency component to reach for.
 */
export declare function DualAmount({ amount_iqd, amount_usd_cents, primary, kind, size }: DualAmountProps): import("react").JSX.Element;
//# sourceMappingURL=DualAmount.d.ts.map