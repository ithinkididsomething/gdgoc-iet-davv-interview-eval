import { useMemo, useState } from 'react';
import type { SortAccessor, SortDirection } from '../lib/sort';
import { sortRows } from '../lib/sort';

export interface SortState {
  sortKey: string | null;
  sortDir: SortDirection;
  toggleSort: (key: string) => void;
  setSort: (key: string | null, dir?: SortDirection) => void;
}

/** Client-side sorting state for a table. Sorting happens in memory, so it is instant. */
export function useSort<T>(
  rows: T[],
  getValue: SortAccessor<T>,
  initialKey: string | null = null,
  initialDir: SortDirection = 'asc',
): SortState & { sorted: T[] } {
  const [sortKey, setSortKey] = useState<string | null>(initialKey);
  const [sortDir, setSortDir] = useState<SortDirection>(initialDir);

  const toggleSort = (key: string) => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const setSort = (key: string | null, dir: SortDirection = 'asc') => {
    setSortKey(key);
    setSortDir(dir);
  };

  const sorted = useMemo(
    () => sortRows(rows, sortKey, sortDir, getValue),
    [rows, sortKey, sortDir, getValue],
  );

  return { sorted, sortKey, sortDir, toggleSort, setSort };
}

/**
 * A table header cell that toggles sorting. Shows an upward/downward arrow when
 * active and a neutral indicator otherwise.
 */
export function SortableTh({
  label,
  sortKey,
  state,
  className,
  title,
}: {
  label: React.ReactNode;
  sortKey: string;
  state: SortState;
  className?: string;
  title?: string;
}) {
  const active = state.sortKey === sortKey;
  return (
    <th
      className={className}
      title={title}
      aria-sort={active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className={`th-sort${active ? ' active' : ''}`} onClick={() => state.toggleSort(sortKey)}>
        <span>{label}</span>
        <span className="th-sort-icon" aria-hidden="true">
          {active ? (state.sortDir === 'asc' ? '\u2191' : '\u2193') : '\u2195'}
        </span>
      </button>
    </th>
  );
}
