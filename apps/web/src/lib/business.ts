import { createContext, useContext } from 'react';

/**
 * The business as its receipts introduce it (D-108): a name, a phone, an address and a logo, set
 * by an admin in Settings — as in the Pallet system. Each is optional; a receipt with no name set
 * says the product's own name, as it always has.
 */
export interface Business {
  name: string | null;
  phone: string | null;
  address: string | null;
  /** The logo as a `data:` URL, so a printed page needs nothing more from the server. */
  logo: string | null;
}

export const NO_BUSINESS: Business = { name: null, phone: null, address: null, logo: null };

export const BUSINESS_QUERY_KEY = ['settings', 'business'] as const;

/** What the printed documents are headed with, handed down by the print host. */
export const BusinessContext = createContext<Business>(NO_BUSINESS);

export function useBusiness(): Business {
  return useContext(BusinessContext);
}

/** The largest a logo is kept at, in pixels on its longer side: plenty for a receipt's header. */
export const LOGO_MAX_SIDE = 480;
/** And in bytes once encoded — the server refuses anything larger. */
export const LOGO_MAX_BYTES = 256 * 1024;

/**
 * A picture the admin chose, made small enough for a receipt: drawn onto a canvas no larger than
 * `LOGO_MAX_SIDE`, as PNG (which keeps a transparent background) or — when that is too large, as
 * a photo is — as WebP, then JPEG. Rejects with `'too_large'` when nothing fits, `'unreadable'`
 * when the file is not a picture the browser can open.
 */
export async function shrinkLogo(file: File): Promise<string> {
  const source = await readImage(file);
  const scale = Math.min(1, LOGO_MAX_SIDE / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('unreadable');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  for (const [type, quality] of [
    ['image/png', undefined],
    ['image/webp', 0.9],
    ['image/jpeg', 0.85],
  ] as const) {
    // JPEG has no transparency, and a transparent corner would come out black: paper is white.
    if (type === 'image/jpeg') {
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    const url = canvas.toDataURL(type, quality);
    // A browser that cannot write the type hands back PNG instead; only the type asked for counts.
    if (!url.startsWith(`data:${type};`)) continue;
    if (bytesOf(url) <= LOGO_MAX_BYTES) return url;
  }
  throw new Error('too_large');
}

function readImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable'));
    };
    image.src = url;
  });
}

/** The decoded size of a base64 `data:` URL. */
export function bytesOf(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
