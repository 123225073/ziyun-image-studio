export const rowCategory = code => String(code || '').trim().match(/^[a-z]+/i)?.[0].toUpperCase() || '';
// Continue the last row in the user's manual order. Sorting and filtering are
// presentation only and must not change which classification is continued.
export function nextImageRowCode(rows = []) {
  const parts = String(rows.at(-1)?.code || '').trim().match(/^([a-z]*)(\d+)(?:[.。．]|_\d+)?$/i);
  const prefix = parts?.[1]?.toUpperCase() || 'A';
  const width = Math.max(2, parts?.[2]?.length || 0);
  let number = parts ? BigInt(parts[2]) + 1n : 1n;
  const canonical = value => {
    const match = String(value || '').trim().match(/^([a-z]+)(\d+)[.。．]?$/i);
    return match ? `${match[1].toUpperCase()}${BigInt(match[2])}` : String(value || '').trim().toUpperCase();
  };
  const occupied = new Set(rows.map(row => canonical(row.code)));
  while (occupied.has(`${prefix}${number}`)) number++;
  const code = `${prefix}${String(number).padStart(width, '0')}`;
  if (code.length > 40) throw new Error('上一行编号过长，无法继续递增，请先缩短编号。');
  return code;
}

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
