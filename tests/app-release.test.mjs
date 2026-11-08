import test from 'node:test';
import assert from 'node:assert/strict';
import {checkAppRelease} from '../electron/app-release.mjs';

test('version check compares version components and uses only the public stable-release endpoint', async () => {
  const remote = tag_name => async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/123225073/ziyun-image-studio/releases/latest');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return {ok:true,json:async()=>({tag_name})};
  };
  assert.deepEqual(await checkAppRelease('0.5.4',remote('v0.5.10')),{latest:'0.5.10',comparison:'update'});
  assert.deepEqual(await checkAppRelease('0.5.4',remote('v0.5.4')),{latest:'0.5.4',comparison:'current'});
  assert.deepEqual(await checkAppRelease('0.5.4',remote('v0.5.3')),{latest:'0.5.3',comparison:'ahead'});
  await assert.rejects(checkAppRelease('0.5.4',remote('v0.5.5-beta')),/无法查询/);
  await assert.rejects(checkAppRelease('0.5.4',async()=>{throw new Error('offline')}),/无法查询/);
});

test('an exhausted public API quota falls back to the same repository release page', async () => {
  const urls=[];
  const result=await checkAppRelease('0.5.4',async (url,options)=>{
    urls.push(url);
    if(urls.length===1)return {ok:false,status:403};
    assert.equal(options.credentials,'omit');
    assert.equal(options.redirect,'manual');
    return {status:302,headers:new Headers({location:'https://github.com/123225073/ziyun-image-studio/releases/tag/v0.5.3'})};
  });
  assert.equal(urls[1],'https://github.com/123225073/ziyun-image-studio/releases/latest');
  assert.deepEqual(result,{latest:'0.5.3',comparison:'ahead'});
});
