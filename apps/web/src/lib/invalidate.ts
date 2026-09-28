import type { QueryClient } from '@tanstack/react-query';

/**
 * The screens that sum money over many records — Today, Reports, Accounts and the expense
 * lists behind them. Any write that moves money or stock refreshes them too, or they go on
 * showing yesterday's figure until somebody reloads. History comes with them: every write is a
 * row there (rule 3).
 */
export async function invalidateMoneyViews(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['reports'] }),
    queryClient.invalidateQueries({ queryKey: ['accounts'] }),
    queryClient.invalidateQueries({ queryKey: ['expenses'] }),
    invalidateHistory(queryClient),
  ]);
}

/**
 * History — the log and the "recent activity" on Me. Every write adds a row to it (rule 3), so
 * a write that moves no money still refreshes it, or History goes on without the change that was
 * just made.
 */
export async function invalidateHistory(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['history'] });
}
