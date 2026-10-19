import type { SVGProps } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ChartColumn,
  LayoutDashboard,
  ArrowRight,
  Building2,
  Check,
  ChevronRight,
  ClipboardList,
  Clock,
  Contact,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  Filter,
  History,
  Languages,
  Lock,
  LogOut,
  type LucideIcon,
  Monitor,
  Moon,
  Package,
  PanelLeft,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShoppingCart,
  Wallet,
  BanknoteArrowDown,
  BanknoteArrowUp,
  Sun,
  Trash2,
  Truck,
  Type,
  Unlock,
  User,
  Users,
  X,
} from 'lucide-react';

/**
 * The icon set (spec 2.10.6 point 2), drawn from lucide — the same family the item-management
 * system uses — behind this app's own stable names. A screen asks for `orders`, not for whichever
 * lucide glyph currently stands for it, so the mapping can change in one place. Every icon still
 * declares whether it mirrors in RTL: a back arrow does, a clock does not, and mirroring is one
 * CSS rule on `[data-mirror]`.
 */
export type IconName =
  | 'back'
  | 'download'
  | 'dashboard'
  | 'chart'
  | 'chevron'
  | 'next'
  | 'search'
  | 'plus'
  | 'check'
  | 'close'
  | 'lock'
  | 'unlock'
  | 'user'
  | 'users'
  | 'history'
  | 'settings'
  | 'eye'
  | 'eye-off'
  | 'warning'
  | 'clock'
  | 'refresh'
  | 'trash'
  | 'logout'
  | 'sun'
  | 'moon'
  | 'language'
  | 'monitor'
  | 'panel'
  | 'text'
  | 'shield'
  | 'orders'
  | 'materials'
  | 'customers'
  | 'companies'
  | 'drivers'
  | 'purchases'
  | 'accounts'
  | 'money-in'
  | 'money-out'
  | 'more'
  | 'filter'
  | 'print'
  | 'edit';

/** Icons that imply a direction, and therefore mirror (spec 2.10.6). */
export const MIRRORED_ICONS: ReadonlySet<IconName> = new Set<IconName>([
  'back',
  'chevron',
  'next',
  'logout',
  // A truck drives forward, which is the reading direction (D-105).
  'drivers',
]);

const ICONS: Record<IconName, LucideIcon> = {
  back: ArrowLeft,
  dashboard: LayoutDashboard,
  chart: ChartColumn,
  chevron: ChevronRight,
  next: ArrowRight,
  search: Search,
  plus: Plus,
  check: Check,
  close: X,
  lock: Lock,
  unlock: Unlock,
  user: User,
  users: Users,
  history: History,
  settings: Settings,
  eye: Eye,
  'eye-off': EyeOff,
  warning: AlertTriangle,
  clock: Clock,
  refresh: RefreshCw,
  trash: Trash2,
  logout: LogOut,
  sun: Sun,
  moon: Moon,
  language: Languages,
  monitor: Monitor,
  panel: PanelLeft,
  text: Type,
  shield: Shield,
  orders: ClipboardList,
  materials: Package,
  customers: Contact,
  companies: Building2,
  drivers: Truck,
  purchases: ShoppingCart,
  // The accountant's page (D-085): the cart belongs to Purchases now.
  accounts: Wallet,
  // Money coming to us and money leaving us (D-088); not mirrored — up and down are not sides.
  'money-in': BanknoteArrowDown,
  'money-out': BanknoteArrowUp,
  more: Ellipsis,
  filter: Filter,
  print: Printer,
  edit: Pencil,
  download: Download,
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 20, ...rest }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      width={size}
      height={size}
      strokeWidth={1.8}
      aria-hidden="true"
      focusable="false"
      data-mirror={MIRRORED_ICONS.has(name) ? 'true' : undefined}
      {...rest}
    />
  );
}
