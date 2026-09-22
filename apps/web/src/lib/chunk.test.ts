import { describe, expect, it, vi } from 'vitest';
import { loadTwice } from './chunk.js';

describe('a screen that has to arrive over the connection of NFR-03', () => {
  it('asks a second time, because React.lazy never will', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('the screen');

    await expect(loadTwice(load, 0)).resolves.toBe('the screen');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not ask a third time — twice is a dropout, three times is a wish', async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('gone'));

    await expect(loadTwice(load, 0)).rejects.toThrow('gone');
    expect(load).toHaveBeenCalledTimes(2);
    // And the rejection reaches the boundary, which is what keeps the failure on one screen
    // instead of unmounting the whole application.
  });

  it('asks once when the first answer arrives', async () => {
    const load = vi.fn<() => Promise<string>>().mockResolvedValue('the screen');

    await expect(loadTwice(load, 0)).resolves.toBe('the screen');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
