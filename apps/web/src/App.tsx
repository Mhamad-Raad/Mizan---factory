import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button, ErrorState, Skeleton } from '@mizan/ui';
import { ApiError, apiRequest } from './lib/api.js';
import { useApp } from './lib/store.js';
import type { SessionUser } from './lib/store.js';
import { LoginPage } from './pages/LoginPage.js';
import { LockPage } from './pages/LockPage.js';
import { ChangePasswordPage } from './pages/ChangePasswordPage.js';

/**
 * Every screen but the three the first paint needs is its own chunk (NFR-03: "initial
 * JavaScript ≤ 250 kB gzipped **with route-level code splitting**").
 *
 * Before this the login page downloaded the whole application — the nine reports, the damage
 * forms, the permission grid, the PIN pad — and Lighthouse on the reference profile of NFR-03
 * (400 kbps, 400 ms round trip, 4× CPU) measured a **7.6 second** first contentful paint
 * against a budget of five seconds to interactive, with 100 KiB of the bundle unused on that
 * screen. An employee signing in on the factory floor pays for screens they may not even have
 * permission to open (I6 load test).
 */
const MaterialsPage = lazy(() =>
  import('./pages/MaterialsPage.js').then((module) => ({ default: module.MaterialsPage })),
);
const MaterialDetailPage = lazy(() =>
  import('./pages/MaterialDetailPage.js').then((module) => ({
    default: module.MaterialDetailPage,
  })),
);
const NewMaterialPage = lazy(() =>
  import('./pages/NewMaterialPage.js').then((module) => ({ default: module.NewMaterialPage })),
);
const CustomersPage = lazy(() =>
  import('./pages/CustomersPage.js').then((module) => ({ default: module.CustomersPage })),
);
const CustomerDetailPage = lazy(() =>
  import('./pages/CustomerDetailPage.js').then((module) => ({
    default: module.CustomerDetailPage,
  })),
);
const NewCustomerPage = lazy(() =>
  import('./pages/NewCustomerPage.js').then((module) => ({ default: module.NewCustomerPage })),
);
const CompaniesPage = lazy(() =>
  import('./pages/CompaniesPage.js').then((module) => ({ default: module.CompaniesPage })),
);
const CompanyDetailPage = lazy(() =>
  import('./pages/CompanyDetailPage.js').then((module) => ({ default: module.CompanyDetailPage })),
);
const NewCompanyPage = lazy(() =>
  import('./pages/NewCompanyPage.js').then((module) => ({ default: module.NewCompanyPage })),
);
const PurchasesPage = lazy(() =>
  import('./pages/PurchasesPage.js').then((module) => ({ default: module.PurchasesPage })),
);
const PurchaseFormPage = lazy(() =>
  import('./pages/PurchaseFormPage.js').then((module) => ({ default: module.PurchaseFormPage })),
);
const PurchaseDetailPage = lazy(() =>
  import('./pages/PurchaseDetailPage.js').then((module) => ({
    default: module.PurchaseDetailPage,
  })),
);
const DamagesPage = lazy(() =>
  import('./pages/DamagesPage.js').then((module) => ({ default: module.DamagesPage })),
);
const DamageFormPage = lazy(() =>
  import('./pages/DamageFormPage.js').then((module) => ({ default: module.DamageFormPage })),
);
const DamageDetailPage = lazy(() =>
  import('./pages/DamageDetailPage.js').then((module) => ({ default: module.DamageDetailPage })),
);
const OrdersPage = lazy(() =>
  import('./pages/OrdersPage.js').then((module) => ({ default: module.OrdersPage })),
);
const OrderFormPage = lazy(() =>
  import('./pages/OrderFormPage.js').then((module) => ({ default: module.OrderFormPage })),
);
const OrderDetailPage = lazy(() =>
  import('./pages/OrderDetailPage.js').then((module) => ({ default: module.OrderDetailPage })),
);
const UsersPage = lazy(() =>
  import('./pages/UsersPage.js').then((module) => ({ default: module.UsersPage })),
);
const NewUserPage = lazy(() =>
  import('./pages/NewUserPage.js').then((module) => ({ default: module.NewUserPage })),
);
const UserDetailPage = lazy(() =>
  import('./pages/UserDetailPage.js').then((module) => ({ default: module.UserDetailPage })),
);
const HistoryPage = lazy(() =>
  import('./pages/HistoryPage.js').then((module) => ({ default: module.HistoryPage })),
);
const ReportsPage = lazy(() =>
  import('./pages/ReportsPage.js').then((module) => ({ default: module.ReportsPage })),
);
const ReportPage = lazy(() =>
  import('./pages/ReportPage.js').then((module) => ({ default: module.ReportPage })),
);
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage.js').then((module) => ({ default: module.DashboardPage })),
);
const SearchPage = lazy(() =>
  import('./pages/SearchPage.js').then((module) => ({ default: module.SearchPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage.js').then((module) => ({ default: module.SettingsPage })),
);
const FontCheckPage = lazy(() =>
  import('./pages/FontCheckPage.js').then((module) => ({ default: module.FontCheckPage })),
);
const ImportPage = lazy(() =>
  import('./pages/ImportPage.js').then((module) => ({ default: module.ImportPage })),
);

/**
 * Where a user lands after signing in: the first tab they may open, in the order the bottom
 * bar shows them (spec 2.10.1, 2.6.3). An admin holds every key, so they land on Orders.
 */
function landingFor(user: SessionUser | null, permissions: string[]): string {
  const may = (key: string) => user?.role === 'admin' || permissions.includes(key);
  if (may('orders.view')) return '/orders';
  if (may('materials.view')) return '/materials';
  if (may('customers.view')) return '/customers';
  if (may('companies.view')) return '/companies';
  if (may('damages.view')) return '/damages';
  if (may('purchases.view')) return '/purchases';
  if (user?.role === 'admin') return '/users';
  if (may('history.view')) return '/history';
  return '/settings';
}

/**
 * The identity of the *screen*, not of the record on it.
 *
 * One route is one lazy chunk, so `/companies/A` → `/companies/B` needs no new Suspense
 * boundary (the module is already there, and remounting would throw away the scroll position
 * for nothing), while `/companies` → `/companies/A` does.
 */
function routeKey(pathname: string): string {
  return pathname.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, ':id');
}

interface MeResponse {
  user: SessionUser;
  permissions: string[];
  is_locked: boolean;
}

/** The three keys of the PIN policy every signed-in user may read (D-038). */
interface PolicyResponse {
  pin_min_length_shared: number;
  pin_min_length_personal: number;
  allow_pin_switch_on_shared: boolean;
}

export function App() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useApp((state) => state.user);
  const isLocked = useApp((state) => state.isLocked);
  const setSession = useApp((state) => state.setSession);
  const clearSession = useApp((state) => state.clearSession);
  const setOnline = useApp((state) => state.setOnline);
  const setPreference = useApp((state) => state.setPreference);

  /** The offline indicator of FR-1305; reads fall back to what was already loaded. */
  useEffect(() => {
    const online = () => setOnline(true);
    const offline = () => setOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [setOnline]);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => apiRequest<MeResponse>('/auth/me'),
    retry: false,
    // Refreshed on focus and after any 403, so a permission change lands without a reload.
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (me.data)
      setSession({
        user: me.data.user,
        permissions: me.data.permissions,
        isLocked: me.data.is_locked,
      });
    if (me.error instanceof ApiError && me.error.status === 401) clearSession();
  }, [me.data, me.error, setSession, clearSession]);

  useEffect(() => {
    if (isLocked && location.pathname !== '/lock') navigate('/lock', { replace: true });
  }, [isLocked, location.pathname, navigate]);

  /**
   * The PIN policy, fetched while the session is *unlocked* and kept in this browser's
   * preferences, because the lock screen needs it when `GET /settings` would answer 423
   * (FR-106, D-038).
   */
  const policy = useQuery({
    queryKey: ['settings', 'pin-policy'],
    queryFn: () => apiRequest<PolicyResponse>('/settings'),
    enabled: Boolean(me.data) && !me.data?.is_locked,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!policy.data) return;
    const next = {
      shared: policy.data.pin_min_length_shared,
      personal: policy.data.pin_min_length_personal,
      switchOnShared: policy.data.allow_pin_switch_on_shared,
    };
    const current = useApp.getState().preferences.pinPolicy;
    if (
      current.shared !== next.shared ||
      current.personal !== next.personal ||
      current.switchOnShared !== next.switchOnShared
    ) {
      setPreference('pinPolicy', next);
    }
  }, [policy.data, setPreference]);

  if (me.isPending) {
    return (
      <main className="mz-main">
        <Skeleton lines={6} />
      </main>
    );
  }

  const signedIn = Boolean(user ?? me.data?.user);

  if (!signedIn) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (user?.must_change_password) {
    return (
      <Routes>
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route path="*" element={<Navigate to="/change-password" replace />} />
      </Routes>
    );
  }

  return (
    /*
     * A route's chunk may still be arriving: the skeleton is the same one the shell shows
     * while a query is in flight, so the transition reads as loading rather than as breakage.
     *
     * The boundary is keyed by path on purpose. React Router navigates inside a transition,
     * which by default keeps the *previous* screen on the glass until the new chunk has
     * arrived — half a second on the 400 kbps reference connection of NFR-03, during which a
     * thumb that has already tapped a customer is still tapping the list underneath. A new
     * boundary per path cannot show stale children, so the tap always lands somewhere that
     * says "loading"; when the chunk is already in memory, which is every visit after the
     * first, nothing suspends and no skeleton is seen at all.
     */
    <Suspense
      key={routeKey(location.pathname)}
      fallback={
        <main className="mz-main">
          <Skeleton lines={6} />
        </main>
      }
    >
      <Routes>
        <Route path="/lock" element={<LockPage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/orders/new" element={<OrderFormPage mode="create" />} />
        <Route path="/orders/:id" element={<OrderDetailPage />} />
        <Route path="/orders/:id/edit" element={<OrderFormPage mode="edit" />} />
        <Route path="/materials" element={<MaterialsPage />} />
        <Route path="/materials/new" element={<NewMaterialPage />} />
        <Route path="/materials/:id" element={<MaterialDetailPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/customers/new" element={<NewCustomerPage />} />
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
        <Route path="/companies" element={<CompaniesPage />} />
        <Route path="/companies/new" element={<NewCompanyPage />} />
        <Route path="/companies/:id" element={<CompanyDetailPage />} />
        <Route path="/purchases" element={<PurchasesPage />} />
        <Route path="/purchases/new" element={<PurchaseFormPage mode="create" />} />
        <Route path="/purchases/:id" element={<PurchaseDetailPage />} />
        <Route path="/purchases/:id/edit" element={<PurchaseFormPage mode="edit" />} />
        <Route path="/damages" element={<DamagesPage />} />
        <Route path="/damages/new" element={<DamageFormPage mode="create" />} />
        <Route path="/damages/:id" element={<DamageDetailPage />} />
        <Route path="/damages/:id/edit" element={<DamageFormPage mode="edit" />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/users/new" element={<NewUserPage />} />
        <Route path="/users/:id" element={<UserDetailPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/reports/:name" element={<ReportPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {/* A test fixture with a URL, deliberately not in the navigation (spec 3.7.1). */}
        <Route path="/font-check" element={<FontCheckPage />} />
        {/* Go-live import (FR-1312, Proposed — not requested); the API is admin-only. */}
        <Route path="/import" element={<ImportPage />} />
        {/* The home route sends each user to the first page they may open (spec 2.10.1). */}
        <Route
          path="/"
          element={<Navigate to={landingFor(user, me.data?.permissions ?? [])} replace />}
        />
        <Route
          path="*"
          element={
            <main className="mz-main">
              <ErrorState
                title={t('common:not_found_title')}
                body={t('common:not_found_body')}
                action={<Button onClick={() => navigate('/')}>{t('common:back')}</Button>}
              />
            </main>
          }
        />
      </Routes>
    </Suspense>
  );
}
