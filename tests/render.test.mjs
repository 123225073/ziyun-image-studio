import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {renderMontage,runMedia,mediaDuration,subtitleCues,toSrt,resolveFfmpeg} from '../electron/render.mjs';
const ffmpeg=await resolveFfmpeg(process.cwd());
test('字幕按真实音频时长连续排布，长行分割且完整保留内容',()=>{const text='第一步先准备参考素材，然后填写提示词。第二步生成图片！';const cues=subtitleCues(text,8,2);assert.equal(cues[0].start,2);assert.equal(cues.at(-1).end,10);assert.equal(cues.map(c=>c.text).join(''),text);assert.match(toSrt(cues),/00:00:02,000 -->/);});
test('实际FFmpeg两段音频/图像合成含中文字幕，时长核对并输出清单',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ziyun-render-'));try{const image=path.join(dir,'source.png'),audio=path.join(dir,'audio.wav');await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=0x20675e:s=320x480','-frames:v','1',image]);await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1.2','-c:a','pcm_s16le',audio]);const result=await renderMontage({jobId:'real-test',name:'字幕验收',segments:[{section:'A',text:'第一段测试字幕。',paths:[image],audioPath:audio},{section:'B',text:'第二段连续声音。',paths:[image],audioPath:audio}],ratio:'9:16',subtitle:true,outputDir:dir},{ffmpegPath:ffmpeg});assert.ok((await fs.stat(result.localPath)).size>1000);assert.ok(Math.abs(await mediaDuration(ffmpeg,result.localPath)-2.4)<.3);assert.match(await fs.readFile(result.subtitlePath,'utf8'),/第一段/);const manifest=JSON.parse(await fs.readFile(path.join(dir,'real-test.json'),'utf8'));assert.equal(manifest.segments.length,2);}finally{await fs.rm(dir,{recursive:true,force:true});}});
test('配音缓存复用，重跑本地合成不重复请求TTS',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ziyun-audio-'));try{const image=path.join(dir,'a.png'),audio=path.join(dir,'a.wav');await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=s=64x64','-frames:v','1',image]);await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=duration=0.6',audio]);let calls=0,checkpoint={};const config={jobId:'reuse',segments:[{text:'缓存配音',paths:[image]}],outputDir:dir,subtitle:false};const ctx={ffmpegPath:ffmpeg,provider:{id:'test'},providerRunner:async()=>{calls++;return {localPath:audio};},onCheckpoint:v=>{checkpoint=structuredClone(v);}};await renderMontage(config,ctx);await renderMontage(config,{...ctx,checkpoint});assert.equal(calls,1);}finally{await fs.rm(dir,{recursive:true,force:true});}});
test('短开头加后续图片补足配音，输出真实1080P且不拖长开头',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ziyun-opening-'));try{const image=path.join(dir,'b.png'),opening=path.join(dir,'opening.mp4'),audio=path.join(dir,'a.wav');await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=s=64x64','-frames:v','1',image]);await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=160x240:d=1','-an','-c:v','libx264','-pix_fmt','yuv420p',opening]);await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=duration=3','-c:a','pcm_s16le',audio]);const result=await renderMontage({jobId:'head',segments:[{text:'一秒开头后是图片补足三秒音频。',paths:[image],audioPath:audio}],openingPath:opening,outputDir:dir,subtitle:false},{ffmpegPath:ffmpeg});assert.ok(Math.abs(result.duration-3)<.2);const info=await runMedia(ffmpeg,['-hide_banner','-i',result.localPath],{allowFailure:true});assert.match(info.stderr,/1080x1920/);}finally{await fs.rm(dir,{recursive:true,force:true});}});

test('保留完整片头原声，母带只放一次，计划镜头使用实际入点', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-preserve-opening-'));
  try {
    const opening = path.join(dir, 'opening.mp4');
    const footage = path.join(dir, 'footage.mp4');
    const narration = path.join(dir, 'narration.wav');
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x96:d=0.6', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', opening]);
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x96:d=2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', footage]);
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.8', '-c:a', 'pcm_s16le', narration]);
    const result = await renderMontage({
      jobId: 'original', outputDir: dir, ratio: '9:16', subtitle: true,
      openingPath: opening, openingAudioMode: 'original', masterAudioPath: narration, masterText: '正文旁白。',
      masterCues: [{ text: '正文', start: .1, end: .4 }, { text: '旁白。', start: .4, end: .7 }],
      segments: [{ section: 'A', text: '正文旁白。', duration: .8, shots: [{ path: footage, sourceIn: 1, duration: .8 }] }],
    }, { ffmpegPath: ffmpeg });
    assert.ok(Math.abs(result.duration - 1.4) < .15);
    const voices = result.timeline.clips.filter(clip => clip.track === 'voice');
    assert.deepEqual(voices.map(clip => clip.path), [opening, narration]);
    assert.ok(Math.abs(voices[1].start - .6) < .04);
    assert.equal(result.timeline.clips.filter(clip => clip.track === 'picture')[1].sourceIn, 1);
    const subtitle = result.timeline.clips.find(clip => clip.track === 'subtitle');
    assert.ok(Math.abs(subtitle.start - .7) < .04);
    assert.equal(subtitle.text, '正文旁白。');
    const sound = await runMedia(ffmpeg, ['-hide_banner', '-i', result.localPath, '-t', '0.4', '-vn', '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-'], { allowFailure: true });
    const crossing = Number(sound.stderr.match(/Zero crossings rate:\s*([\d.]+)/)?.[1]);
    assert.ok(crossing > .007 && crossing < .012, `片头应保留220Hz原音频，实际过零率 ${crossing}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('计划视频镜头超出源范围时明确报错，不循环口播素材补长', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-shot-range-'));
  try {
    const footage = path.join(dir, 'short.mp4');
    const audio = path.join(dir, 'audio.wav');
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=64x96:d=0.4', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', footage]);
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=0.8', '-c:a', 'pcm_s16le', audio]);
    await assert.rejects(renderMontage({ outputDir: dir, segments: [{ text: '正文', audioPath: audio, shots: [{ path: footage, sourceIn: .2, duration: .8 }] }] }, { ffmpegPath: ffmpeg }), /超出源视频/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
