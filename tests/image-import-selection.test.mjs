import assert from 'node:assert/strict';
import test from 'node:test';
import { planImageImport, selectImageImportEntries } from '../shared/image-import-selection.mjs';

const row = (code, extras = {}) => ({ values: { code, count: 1 }, errors: [], ...extras });
const target = (id, code, extras = {}) => ({ id, code, minimumCount: 0, revision: id, ...extras });

test('partial selection reserves literal codes and assigns unique suffixes without changing original rows', () => {
  const rows = [row('A001'), row('A001_2'), row('A001'), row('C01', { errors: ['图片无效'] })];
  const targets = [target('existing', 'A1')];
  assert.deepEqual(planImageImport(rows, targets).map(({ action, finalCode }) => [action, finalCode]), [
    ['rename', 'A001_3'], ['add', 'A001_2'], ['rename', 'A001_4'], ['skip', undefined],
  ]);
  const entries = selectImageImportEntries({ rows, targets, errors: [] }, [{ index: 2, action: 'rename' }]);
  assert.deepEqual(entries.map(entry => entry.values.code), ['A001_3']);
  assert.equal(rows[2].values.code, 'A001');
  assert.throws(() => selectImageImportEntries({ rows, targets, errors: [] }, [{ index: 3, action: 'add' }]), /冲突尚未处理/);
});

test('a directory has one owner and overwrite requires an available unambiguous target', () => {
  const rows = [row('A01', { folderKey: 'used' }), row('B01', { folderKey: 'new' }), row('B02', { folderKey: 'new' })];
  const targets = [target('one', 'A01', { folderKey: 'used' })];
  assert.deepEqual(planImageImport(rows, targets).map(item => item.action), ['skip', 'add', 'skip']);
  assert.deepEqual(planImageImport(rows, targets, { 0: 'overwrite', 1: 'skip' }).map(item => item.action), ['overwrite', 'skip', 'add']);
  assert.equal(planImageImport(rows, [{ ...targets[0], busy: true }], { 0: 'overwrite' })[0].action, 'skip');
  assert.equal(planImageImport(rows, [{ ...targets[0], minimumCount: 2 }], { 0: 'overwrite' })[0].action, 'skip');
  assert.deepEqual(planImageImport(rows, [...targets, target('two', 'A1')])[0].options, []);
});
