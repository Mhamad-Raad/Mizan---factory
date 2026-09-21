import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { LOCALES } from '@mizan/i18n';
import type { Locale } from '@mizan/i18n';

import ckbCommon from '@mizan/i18n/locales/ckb-IQ/common.json';
import ckbGlossary from '@mizan/i18n/locales/ckb-IQ/glossary.json';
import ckbErrors from '@mizan/i18n/locales/ckb-IQ/errors.json';
import ckbAuth from '@mizan/i18n/locales/ckb-IQ/auth.json';
import ckbUsers from '@mizan/i18n/locales/ckb-IQ/users.json';
import ckbPermissions from '@mizan/i18n/locales/ckb-IQ/permissions.json';
import ckbHistory from '@mizan/i18n/locales/ckb-IQ/history.json';
import ckbSettings from '@mizan/i18n/locales/ckb-IQ/settings.json';
import ckbMaterials from '@mizan/i18n/locales/ckb-IQ/materials.json';
import ckbCustomers from '@mizan/i18n/locales/ckb-IQ/customers.json';
import ckbOrders from '@mizan/i18n/locales/ckb-IQ/orders.json';
import ckbCompanies from '@mizan/i18n/locales/ckb-IQ/companies.json';
import ckbPurchases from '@mizan/i18n/locales/ckb-IQ/purchases.json';
import ckbDamages from '@mizan/i18n/locales/ckb-IQ/damages.json';
import ckbReports from '@mizan/i18n/locales/ckb-IQ/reports.json';
import ckbDashboard from '@mizan/i18n/locales/ckb-IQ/dashboard.json';
import ckbSearch from '@mizan/i18n/locales/ckb-IQ/search.json';

import arCommon from '@mizan/i18n/locales/ar-IQ/common.json';
import arGlossary from '@mizan/i18n/locales/ar-IQ/glossary.json';
import arErrors from '@mizan/i18n/locales/ar-IQ/errors.json';
import arAuth from '@mizan/i18n/locales/ar-IQ/auth.json';
import arUsers from '@mizan/i18n/locales/ar-IQ/users.json';
import arPermissions from '@mizan/i18n/locales/ar-IQ/permissions.json';
import arHistory from '@mizan/i18n/locales/ar-IQ/history.json';
import arSettings from '@mizan/i18n/locales/ar-IQ/settings.json';
import arMaterials from '@mizan/i18n/locales/ar-IQ/materials.json';
import arCustomers from '@mizan/i18n/locales/ar-IQ/customers.json';
import arOrders from '@mizan/i18n/locales/ar-IQ/orders.json';
import arCompanies from '@mizan/i18n/locales/ar-IQ/companies.json';
import arPurchases from '@mizan/i18n/locales/ar-IQ/purchases.json';
import arDamages from '@mizan/i18n/locales/ar-IQ/damages.json';
import arReports from '@mizan/i18n/locales/ar-IQ/reports.json';
import arDashboard from '@mizan/i18n/locales/ar-IQ/dashboard.json';
import arSearch from '@mizan/i18n/locales/ar-IQ/search.json';

import enCommon from '@mizan/i18n/locales/en/common.json';
import enGlossary from '@mizan/i18n/locales/en/glossary.json';
import enErrors from '@mizan/i18n/locales/en/errors.json';
import enAuth from '@mizan/i18n/locales/en/auth.json';
import enUsers from '@mizan/i18n/locales/en/users.json';
import enPermissions from '@mizan/i18n/locales/en/permissions.json';
import enHistory from '@mizan/i18n/locales/en/history.json';
import enSettings from '@mizan/i18n/locales/en/settings.json';
import enMaterials from '@mizan/i18n/locales/en/materials.json';
import enCustomers from '@mizan/i18n/locales/en/customers.json';
import enOrders from '@mizan/i18n/locales/en/orders.json';
import enCompanies from '@mizan/i18n/locales/en/companies.json';
import enPurchases from '@mizan/i18n/locales/en/purchases.json';
import enDamages from '@mizan/i18n/locales/en/damages.json';
import enReports from '@mizan/i18n/locales/en/reports.json';
import enDashboard from '@mizan/i18n/locales/en/dashboard.json';
import enSearch from '@mizan/i18n/locales/en/search.json';

/**
 * The catalogs are bundled, not fetched: a floor tablet on a bad connection must not be able
 * to render a screen of message keys. All three languages together are a few kilobytes.
 */
const resources = {
  'ckb-IQ': {
    common: ckbCommon,
    glossary: ckbGlossary,
    errors: ckbErrors,
    auth: ckbAuth,
    users: ckbUsers,
    permissions: ckbPermissions,
    history: ckbHistory,
    settings: ckbSettings,
    materials: ckbMaterials,
    customers: ckbCustomers,
    orders: ckbOrders,
    companies: ckbCompanies,
    purchases: ckbPurchases,
    damages: ckbDamages,
    reports: ckbReports,
    dashboard: ckbDashboard,
    search: ckbSearch,
  },
  'ar-IQ': {
    common: arCommon,
    glossary: arGlossary,
    errors: arErrors,
    auth: arAuth,
    users: arUsers,
    permissions: arPermissions,
    history: arHistory,
    settings: arSettings,
    materials: arMaterials,
    customers: arCustomers,
    orders: arOrders,
    companies: arCompanies,
    purchases: arPurchases,
    damages: arDamages,
    reports: arReports,
    dashboard: arDashboard,
    search: arSearch,
  },
  en: {
    common: enCommon,
    glossary: enGlossary,
    errors: enErrors,
    auth: enAuth,
    users: enUsers,
    permissions: enPermissions,
    history: enHistory,
    settings: enSettings,
    materials: enMaterials,
    customers: enCustomers,
    orders: enOrders,
    companies: enCompanies,
    purchases: enPurchases,
    damages: enDamages,
    reports: enReports,
    dashboard: enDashboard,
    search: enSearch,
  },
} as const;

export async function initI18n(locale: Locale): Promise<void> {
  await i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: false,
    supportedLngs: [...LOCALES],
    defaultNS: 'common',
    ns: Object.keys(resources['en']),
    nsSeparator: ':',
    keySeparator: false,
    interpolation: { escapeValue: false, prefix: '{{', suffix: '}}' },
    returnEmptyString: false,
  });
}

export { i18next };
