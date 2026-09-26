/**
 * lucide-react ships icon `.d.ts` files but declares no `types`/`exports` entry that TypeScript's
 * resolver reaches from its `main`, so the package imports as `any` and the build complains. This
 * ambient module gives the resolver the shape it needs: every icon is a component that takes the
 * usual SVG props plus lucide's `size`, and that is all this app uses.
 */
declare module 'lucide-react' {
  import type { ComponentType, SVGProps } from 'react';

  export interface LucideProps extends SVGProps<SVGSVGElement> {
    size?: string | number;
    absoluteStrokeWidth?: boolean;
  }
  export type LucideIcon = ComponentType<LucideProps>;

  export const ArrowLeft: LucideIcon;
  export const ArrowRight: LucideIcon;
  export const ChevronRight: LucideIcon;
  export const Search: LucideIcon;
  export const Plus: LucideIcon;
  export const Check: LucideIcon;
  export const X: LucideIcon;
  export const Lock: LucideIcon;
  export const Unlock: LucideIcon;
  export const User: LucideIcon;
  export const Users: LucideIcon;
  export const History: LucideIcon;
  export const Settings: LucideIcon;
  export const Eye: LucideIcon;
  export const EyeOff: LucideIcon;
  export const AlertTriangle: LucideIcon;
  export const Clock: LucideIcon;
  export const RefreshCw: LucideIcon;
  export const Trash2: LucideIcon;
  export const LogOut: LucideIcon;
  export const Sun: LucideIcon;
  export const Moon: LucideIcon;
  export const Languages: LucideIcon;
  export const Monitor: LucideIcon;
  export const PanelLeft: LucideIcon;
  export const Type: LucideIcon;
  export const Shield: LucideIcon;
  export const ClipboardList: LucideIcon;
  export const Package: LucideIcon;
  export const Contact: LucideIcon;
  export const Building2: LucideIcon;
  export const ShoppingCart: LucideIcon;
  export const Ellipsis: LucideIcon;
  export const Filter: LucideIcon;
}
