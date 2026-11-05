import test from 'node:test';
import assert from 'node:assert/strict';
import { planMontage, montageUtterances } from '../shared/montage-planner.mjs';

const assets = [
  { id: 'box', path: '/box.mp4', kind: 'video', name: '产品演示', category: '收纳箱', productId: 'box-a', shots: [
    { id: 'fold', sourceIn: 0, duration: 5, description: '收纳箱折叠收起来很薄', tags: ['折叠'], analysis: 'visual' },
    { id: 'unfold', sourceIn: 5, duration: 5, description: '收纳箱展开并放入衣服', tags: ['展开', '衣服'], analysis: 'visual' },
    { id: 'panel', sourceIn: 10, duration: 5, description: '透明面板可以找东西', analysis: 'manual' },
  ] },
  { id: 'wrong-product', path: '/wrong.mp4', kind: 'video', name: '收纳箱', productId: 'box-b', shots: [
    { id: 'wrong', sourceIn: 0, duration: 20, description: '收纳箱折叠展开衣服透明面板找东西', analysis: 'visual' },
  ] },
];

test('按实际旁白分句选择多个有来源范围的镜头，并排除错误产品', () => {
  const result = planMontage({ productId: 'box-a', segments: [{ section: 'A', text: '折叠收起来很薄，展开并放入衣服，透明面板找东西。', duration: 12, audioCues: [
    { text: '折叠收起来很薄，', start: 0, end: 3 },
    { text: '展开并放入衣服，', start: 3, end: 7 },
    { text: '透明面板找东西。', start: 7, end: 12 },
  ] }] }, { assets });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.segments[0].shots.map(shot => shot.id), ['fold', 'unfold', 'panel']);
  assert.deepEqual(result.segments[0].shots.map(shot => shot.duration), [3, 4, 5]);
  assert.equal(result.segments[0].shots[2].sourceIn, 10);
  assert.ok(result.segments[0].shots.every(shot => !shot.needsReview));
});

test('无配音实际时长时返回待配音，缺素材时不混入无关镜头', () => {
  const pending = planMontage({ segments: [{ section: 'A', text: '折叠' }] }, { assets });
  assert.equal(pending.segments[0].shots.length, 0);
  assert.match(pending.missing[0].reason, /实际时长/);
  const missing = planMontage({ segments: [{ section: 'B', text: '操作电梯控制柜。', duration: 4 }] }, { assets });
  assert.equal(missing.segments[0].shots.length, 0);
  assert.equal(missing.missing.length, 1);
});

test('手工锁定的有效镜头保持不变，过期锁定范围提示修正', () => {
  const shot = { id: 'fold', path: '/box.mp4', sourceIn: 1, duration: 3, text: '折叠收起来很薄。', locked: true };
  const result = planMontage({ segments: [{ text: shot.text, duration: 3, shots: [shot] }] }, { assets });
  assert.deepEqual(result.segments[0].shots, [shot]);
  const invalid = planMontage({ segments: [{ text: shot.text, duration: 3, shots: [{ ...shot, sourceIn: 4 }] }] }, { assets });
  assert.match(invalid.missing[0].reason, /超出/);
});

test('目录和文件名命中保留需要预览状态', () => {
  const result = planMontage({ segments: [{ text: '透明面板。', duration: 3 }] }, { assets: [
    { id: 'image', path: '/photo.png', name: '透明面板', kind: 'image', shots: [{ id: 'photo', sourceIn: 0, duration: 0, analysis: 'unreviewed' }] },
  ] });
  assert.equal(result.segments[0].shots[0].needsReview, true);
  assert.match(result.warnings[0], /预览确认/);
});

test('识别为说话人的画面仍需确认，不把静音配旁白当作口型同步', () => {
  const speaking = structuredClone(assets[0]);
  speaking.shots[0].speaking = true;
  const result = planMontage({ segments: [{ text: '折叠收起来很薄。', duration: 3 }] }, { assets: [speaking] });
  assert.equal(result.segments[0].shots[0].needsReview, true);
  assert.match(result.warnings[0], /没有重做口型/);
});

test('用户显式手选图片可以作为旧公式素材使用，并标记内容需确认', () => {
  const chosen = { id: 'chosen', path: '/manual.png', name: 'IMG_001', kind: 'image', shots: [{ id: 'manual', path: '/manual.png', sourceIn: 0, duration: 0, analysis: 'unreviewed' }] };
  const result = planMontage({ segments: [{ text: '介绍这件产品。', paths: ['/manual.png'], duration: 8 }] }, { assets: [chosen] });
  assert.deepEqual(result.missing, []);
  assert.equal(result.segments[0].shots[0].duration, 8);
  assert.equal(result.segments[0].shots[0].needsReview, true);
  assert.match(result.segments[0].shots[0].reason, /用户手选/);
});

test('同类合格候选通过变体序号生成不同方案，并保留原自动选择范围', () => {
  const variants = ['one', 'two', 'three'].map(id => ({ id, path: `/${id}.png`, kind: 'image', name: id, shots: [{ id, sourceIn: 0, duration: 0, description: '透明面板找东西', analysis: 'visual' }] }));
  const config = { segments: [{ text: '透明面板找东西。', duration: 2 }] };
  const first = planMontage(config, { assets: variants });
  const second = planMontage({ ...config, segments: first.segments, seed: 1 }, { assets: variants });
  assert.notEqual(first.signature, second.signature);
  assert.deepEqual(first.segments[0].paths, []);
});

test('语义模型可推荐无字面重合的真实镜头，仍保留来源与口播确认', () => {
  const visual = structuredClone(assets[0]);
  visual.shots[0].description = '容器压扁后的侧面';
  visual.shots[0].tags = [];
  visual.shots[0].speaking = true;
  const text = '折起来不占空间。';
  const result = planMontage({ productId: 'box-a', segments: [{ section: 'A', text, duration: 3 }], semanticMatches: [{ section: 'A', text, shotIds: ['fold'] }] }, { assets: [visual] });
  assert.deepEqual(result.missing, []);
  assert.equal(result.segments[0].shots[0].id, 'fold');
  assert.equal(result.segments[0].shots[0].path, '/box.mp4');
  assert.equal(result.segments[0].shots[0].needsReview, true);
  assert.match(result.segments[0].shots[0].reason, /句意推荐/);
});

test('模型明确无匹配或返回幻觉ID时，不退回字面匹配填入无关素材', () => {
  const text = '折叠收起来很薄。';
  for (const semanticMatches of [[], [{ section: 'A', text, shotIds: [] }], [{ section: 'A', text, shotIds: ['invented-file'] }]]) {
    const result = planMontage({ segments: [{ section: 'A', text, duration: 3 }], semanticMatches }, { assets });
    assert.equal(result.segments[0].shots.length, 0);
    assert.equal(result.missing.length, 1);
  }
});

test('语义推荐无法越过产品、用户选择范围和素材时长约束', () => {
  const text = '折叠收起来很薄。';
  const wrong = planMontage({ productId: 'box-a', segments: [{ section: 'A', text, duration: 3 }], semanticMatches: [{ section: 'A', text, shotIds: ['wrong'] }] }, { assets });
  assert.equal(wrong.segments[0].shots.length, 0);
  const scoped = planMontage({ segments: [{ section: 'A', text, duration: 3, assetIds: ['box'] }], semanticMatches: [{ section: 'A', text, shotIds: ['wrong'] }] }, { assets });
  assert.equal(scoped.segments[0].shots.length, 0);
  const short = planMontage({ segments: [{ section: 'A', text, duration: 8 }], semanticMatches: [{ section: 'A', text, shotIds: ['fold'] }] }, { assets });
  assert.equal(short.segments[0].shots[0].duration, 5);
  assert.equal(short.missing.length, 1);
});

test('语义空结果仍尊重用户手选，导出的分句使用真实配音时间', () => {
  const segment = { section: 'A', text: '透明面板。方便取物。', duration: 4, paths: ['/manual.png'], audioCues: [{ text: '透明面板。', start: 0, end: 1.2 }, { text: '方便取物。', start: 1.3, end: 3.9 }] };
  assert.deepEqual(montageUtterances(segment), [{ text: '透明面板。', start: 0, end: 1.3 }, { text: '方便取物。', start: 1.3, end: 4 }]);
  const manual = { id: 'image', path: '/manual.png', name: 'IMG_001', kind: 'image', shots: [{ id: 'manual', sourceIn: 0, duration: 0, analysis: 'unreviewed' }] };
  const result = planMontage({ segments: [segment], semanticMatches: [{ section: 'A', text: segment.text, shotIds: [] }] }, { assets: [manual] });
  assert.deepEqual(result.missing, []);
  assert.ok(result.segments[0].shots.every(shot => shot.needsReview));
});
