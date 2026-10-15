// D1 allows at most 100 bound variables per SQL statement, so multi-row inserts go in chunks.
export const D1_MAX_VARIABLES = 100;

/** Splits rows so each insert binds at most 100 variables (`columns` = bound values per row). */
export function chunkRows<T>(rows: T[], columns: number): T[][] {
  const size = Math.max(1, Math.floor(D1_MAX_VARIABLES / columns));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
