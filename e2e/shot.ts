import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * One screenshot of a **settled** screen.
 *
 * Route splitting (I6) gave every screen a loading state of its own, and a skeleton holds still
 * — so `toHaveScreenshot`, which waits for two identical frames, is perfectly happy to
 * photograph one and write it as the baseline. It did: five of the regenerated baselines in the
 * typography pass were pictures of grey bars, and the checks that compared against them passed
 * for a week without looking at a single screen (I6 review, finding 2).
 *
 * So every screenshot goes through here, and here waits for the skeletons to be gone first.
 */
export async function shot(page: Page, name: string): Promise<void> {
  const skeletons = page.locator('.mz-skeleton');
  // Twice, with a pause: the first check can pass in the gap between a tap and the frame in
  // which React swaps the old screen for the loading state, and a photograph taken in that gap
  // is a picture of the screen the employee was leaving.
  await expect(skeletons).toHaveCount(0);
  await page.waitForTimeout(250);
  await expect(skeletons).toHaveCount(0);
  await expect(page).toHaveScreenshot(name, { fullPage: true });
}
