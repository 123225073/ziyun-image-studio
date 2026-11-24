export const rowCategory = code => String(code ?? '').trim().normalize('NFKC').match(/^\p{L}[\p{L}\p{M}]*/u)?.[0].toUpperCase() || '';

export function imageRowCategories(rows = []) {
  return [...new Set(rows.map(row => rowCategory(row.code)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

export function categoryOutputDirectory(category, settings) {
  return settings.imageCategoryDirectories?.[category] || settings.outputDir || '';
}

// Both the download button and the queue must agree on which jobs need a picker.
export function imageRowDestination(row, settings) {
  if (row.outputMode === 'source-children') return { mode: 'source-children' };
  if (row.rowOutputDir) return { mode: 'direct', root: row.rowOutputDir };
  const subdirectory = row.folderName?.trim();
  if (row.outputMode === 'system') {
    return { mode: subdirectory ? 'direct' : 'batch', root: settings.outputDir || '', subdirectory };
  }
  const category = rowCategory(row.code);
  const categoryRoot = category && settings.imageCategoryDirectories?.[category];
  if (categoryRoot || subdirectory) {
    return { mode: 'direct', root: categoryOutputDirectory(category, settings), subdirectory };
  }
  return { mode: 'batch', root: settings.outputDir || '' };
}
export const numberedRowCode = value => String(value ?? '').trim().normalize('NFKC')
  .match(/^(\p{L}[\p{L}\p{M}]*[\s._\-—–]*)?(\d+)(?:[.。]|(_\d+))?$/u);

// Continue the last row in the user's manual order. Sorting and filtering are
// presentation only and must not change which classification is continued.
export function nextImageRowCode(rows = []) {
  const parts = numberedRowCode(rows.at(-1)?.code);
  const prefix = parts?.[1]?.toUpperCase() || 'A';
  const width = Math.max(2, parts?.[2]?.length || 0);
  let number = parts ? BigInt(parts[2]) + 1n : 1n;
  const canonical = value => {
    const match = numberedRowCode(value);
    return match ? `${(match[1] || '').toUpperCase()}${BigInt(match[2])}${match[3] || ''}` : String(value || '').trim().toUpperCase();
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
