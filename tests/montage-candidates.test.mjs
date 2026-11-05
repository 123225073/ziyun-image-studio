import test from 'node:test';
import assert from 'node:assert/strict';
import {splitTexts,batchCapacity,batchCombinationAt} from '../shared/montage-batch.mjs';

test('独立文案条目内部换行和竖线保持原文，不增加组合数量',()=>{
 const long='长文字'.repeat(300)+'\n这是同一条里的第二段。 | 竖线也是正文';
 const sections=[{section:'A',candidates:[long,'另一条'],paths:['A.png']},{section:'B',candidates:['结尾一\n继续结尾','结尾二'],paths:['B.png']}];
 assert.deepEqual(splitTexts(sections[0].candidates),[long,'另一条']);
 assert.equal(batchCapacity(sections),4);
 assert.equal(batchCombinationAt(sections,0).segments[0].text,long);
 assert.equal(batchCombinationAt(sections,0).masterText,long+'\n结尾一\n继续结尾');
});
test('旧换行配置按原语义迁移，空条目和完全重复条目不参与相乘',()=>{
 assert.deepEqual(splitTexts('旧一\n旧二\n---\n旧三'),['旧一','旧二','旧三']);
 assert.equal(batchCapacity([{section:'A',candidates:[' 一 ','','一','二\n同条']},{section:'B',candidates:['末尾']}]),2);
 assert.equal(batchCapacity([{section:'A',candidateMode:'files',candidates:['固定\n正文'],paths:['1.png','2.png']}]),2);
});
