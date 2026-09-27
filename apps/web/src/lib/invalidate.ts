import type { QueryClient } from '@tanstack/react-query';

/**
 * The screens that sum money over many records — Today, Reports, Accounts and the expense
 * lists behind them. Any write that moves money or stock refreshes them too, or they go on
 * showing yesterday's figure until somebody reloads.
 */
export async function invalidateMoneyViews(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['reports'] }),
    queryClient.invalidateQueries({ queryKey: ['accounts'] }),
    queryClient.invalidateQueries({ queryKey: ['expenses'] }),
  ]);
}
