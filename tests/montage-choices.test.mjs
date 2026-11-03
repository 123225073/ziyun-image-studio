import test from 'node:test';
import assert from 'node:assert/strict';
import { montageChoices, montageCapacity, montageCombinations } from '../src/montageChoices.js';

test('导入音频绑定当前选中文案，其他段仍可轮换，容量只计有效组合', () => {
  const sections = [
    { candidates: '你好\n再见', pick: 1, audioPath: 'C:/fixtures/goodbye.wav' },
    { candidates: '成果一\n成果二\n成果一', pick: 0, audioPath: '' },
    { candidates: '操作步骤', pick: 0, audioPath: '' },
    { candidates: '结束', pick: 0, audioPath: '' },
  ];
  const original = structuredClone(sections);
  const choices = montageChoices(sections);
  assert.equal(montageCapacity(choices), 2);
  assert.deepEqual(montageCombinations(choices, 20), [
    ['再见', '成果一', '操作步骤', '结束'],
    ['再见', '成果二', '操作步骤', '结束'],
  ]);
  assert.deepEqual(sections, original, '不能改写保存的候选文案或音频绑定');
});

test('所有段落导入音频时只输出一个组合，不重复交付同一成片', () => {
  const choices = montageChoices(['A', 'B', 'C', 'D'].map(section => ({
    candidates: `${section}原稿\n${section}选中稿`, pick: 1, audioPath: `C:/fixtures/${section}.wav`,
  })));
  assert.equal(montageCapacity(choices), 1);
  assert.deepEqual(montageCombinations(choices, 20), [['A选中稿', 'B选中稿', 'C选中稿', 'D选中稿']]);
});

test('无导入音频时从当前选择开始，候选去重后完整覆盖组合', () => {
  const choices = montageChoices([
    { candidates: 'A1\r\n---\r\nA2\r\nA1', pick: 1 },
    { candidates: 'B1\nB2', pick: 1 },
  ]);
  assert.equal(montageCapacity(choices), 4);
  assert.deepEqual(montageCombinations(choices, 3), [['A2', 'B2'], ['A1', 'B2'], ['A2', 'B1']]);
  const complete = montageCombinations(choices, 20);
  assert.equal(complete.length, 4);
  assert.equal(new Set(complete.map(row => JSON.stringify(row))).size, 4);
});

test('缺少一段文案时有效容量为零，缩短候选后过期选择不会产出undefined', () => {
  const empty = montageChoices([{ candidates: 'A' }, { candidates: ' \n ' }]);
  assert.equal(montageCapacity(empty), 0);
  assert.deepEqual(montageCombinations(empty, 20), []);
  const changed = montageChoices([{ candidates: '唯一文案', pick: 8, audioPath: 'C:/fixtures/audio.wav' }]);
  assert.deepEqual(montageCombinations(changed, 2), [['唯一文案']]);
});
