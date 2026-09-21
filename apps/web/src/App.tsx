import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button, ErrorState, Skeleton } from '@mizan/ui';
import { ApiError, apiRequest } from './lib/api.js';
import { useApp } from './lib/store.js';
import type { SessionUser } from './lib/store.js';
import { LoginPage } from './pages/LoginPage.js';
import { MaterialsPage } from './pages/MaterialsPage.js';
import { MaterialDetailPage } from './pages/MaterialDetailPage.js';
import { NewMaterialPage } from './pages/NewMaterialPage.js';
import { CustomersPage } from './pages/CustomersPage.js';
import { CustomerDetailPage } from './pages/CustomerDetailPage.js';
import { NewCustomerPage } from './pages/NewCustomerPage.js';
import { CompaniesPage } from './pages/CompaniesPage.js';
import { CompanyDetailPage } from './pages/CompanyDetailPage.js';
import { NewCompanyPage } from './pages/NewCompanyPage.js';
import { PurchasesPage } from './pages/PurchasesPage.js';
import { PurchaseFormPage } from './pages/PurchaseFormPage.js';
import { PurchaseDetailPage } from './pages/PurchaseDetailPage.js';
import { DamagesPage } from './pages/DamagesPage.js';
import { DamageFormPage } from './pages/DamageFormPage.js';
import { DamageDetailPage } from './pages/DamageDetailPage.js';
import { OrdersPage } from './pages/OrdersPage.js';
import { OrderFormPage } from './pages/OrderFormPage.js';
import { OrderDetailPage } from './pages/OrderDetailPage.js';
import { LockPage } from './pages/LockPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { NewUserPage } from './pages/NewUserPage.js';
import { UserDetailPage } from './pages/UserDetailPage.js';
import { HistoryPage } from './pages/HistoryPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ChangePasswordPage } from './pages/ChangePasswordPage.js';

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

interface MeResponse {
  user: SessionUser;
  permissions: string[];
  is_locked: boolean;
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
    if (me.data) setSession({ user: me.data.user, permissions: me.data.permissions, isLocked: me.data.is_locked });
    if (me.error instanceof ApiError && me.error.status === 401) clearSession();
  }, [me.data, me.error, setSession, clearSession]);

  useEffect(() => {
    if (isLocked && location.pathname !== '/lock') navigate('/lock', { replace: true });
  }, [isLocked, location.pathname, navigate]);

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
      <Route path="/settings" element={<SettingsPage />} />
      {/* The home route sends each user to the first page they may open (spec 2.10.1). */}
      <Route path="/" element={<Navigate to={landingFor(user, me.data?.permissions ?? [])} replace />} />
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
  );
}
