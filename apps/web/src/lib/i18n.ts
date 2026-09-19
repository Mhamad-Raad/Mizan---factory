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

import arCommon from '@mizan/i18n/locales/ar-IQ/common.json';
import arGlossary from '@mizan/i18n/locales/ar-IQ/glossary.json';
import arErrors from '@mizan/i18n/locales/ar-IQ/errors.json';
import arAuth from '@mizan/i18n/locales/ar-IQ/auth.json';
import arUsers from '@mizan/i18n/locales/ar-IQ/users.json';
import arPermissions from '@mizan/i18n/locales/ar-IQ/permissions.json';
import arHistory from '@mizan/i18n/locales/ar-IQ/history.json';
import arSettings from '@mizan/i18n/locales/ar-IQ/settings.json';

import enCommon from '@mizan/i18n/locales/en/common.json';
import enGlossary from '@mizan/i18n/locales/en/glossary.json';
import enErrors from '@mizan/i18n/locales/en/errors.json';
import enAuth from '@mizan/i18n/locales/en/auth.json';
import enUsers from '@mizan/i18n/locales/en/users.json';
import enPermissions from '@mizan/i18n/locales/en/permissions.json';
import enHistory from '@mizan/i18n/locales/en/history.json';
import enSettings from '@mizan/i18n/locales/en/settings.json';

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
