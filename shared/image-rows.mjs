export const rowCategory = code => String(code || '').trim().match(/^[a-z]+/i)?.[0].toUpperCase() || '';
export function visibleImageRows(rows, { query = '', category = '', order = 'manual', selectedOnly = false, selected = [] } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const visible = rows.filter(row => (!needle || `${row.code} ${row.name}`.toLocaleLowerCase().includes(needle)) && (!category || (category === '#' ? !rowCategory(row.code) : rowCategory(row.code) === category)) && (!selectedOnly || selected.includes(row.id)));
  if (order !== 'manual') visible.sort((a,b) => (order === 'desc' ? -1 : 1) * String(a.code || '').localeCompare(String(b.code || ''), 'zh-CN', { numeric: true, sensitivity: 'base' }));
  return visible;
}
// Replace only the visible slots so filtering never moves hidden rows.
export function reorderVisibleRows(rows, visibleIds, source, target) {
  const order = [...visibleIds], from = order.indexOf(source), to = order.indexOf(target);
  if (from < 0 || to < 0) return rows.map(row => row.id);
  order.splice(from,1); order.splice(to,0,source);
  const selected = new Set(visibleIds); let index=0;
  return rows.map(row => selected.has(row.id) ? order[index++] : row.id);
}
