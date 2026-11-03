export const IMAGE_PROMPT_RULES = {
  imageOptimize: '将原始要求改写为可直接交给图片模型的中文指令。结合参考提示词和项目规范，明确修改对象、位置、目标效果及保留内容。保留明确的数值、文字和禁止项。局部改图只改点名内容，保持其余布局、尺寸和样式。只输出可替换「用户要求」的正文，无需复述参考图和项目规范，也不要输出分辨率等技术参数。',
  imageDirected: '按本次补充方向改写原始要求，保留未被明确更新的约束、固定数值及文字。结合参考提示词和项目规范，把改动写成可执行的中文指令。只输出可替换「用户要求」的正文，无需复述参考图和项目规范，也不要输出分辨率等技术参数。',
};

export const H3_PROMPT_SECTIONS = {
  base: ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'],
  reference: ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'],
};

export function videoReferences(paths, mode) {
  const counts = { Picture: 0, Video: 0, Audio: 0 };
  return paths.map((path, index) => {
    const type = /\.(png|jpe?g|webp|gif|bmp)$/i.test(path) ? 'Picture' : /\.(mp3|wav)$/i.test(path) ? 'Audio' : 'Video';
    return { path, type, label: `<${type} ${++counts[type]}>`, role: mode === 'image' ? (index ? '尾帧' : '首帧') : '' };
  });
}

// MiniMax's official h3-prompt-writing skill, base-en.txt and ref-en.txt.
export function h3PromptRules(mode, count, duration) {
  const sections = H3_PROMPT_SECTIONS[mode === 'reference' ? 'reference' : 'base'];
  const structure = sections.map(section => `${section}: ...`).join('\n\n');
  const alignment = mode === 'image'
    ? count === 1
      ? '首行注明 <Picture 1> 来自 [Shot 1]，对齐 0.00 秒且完整作为首帧；正文从首帧连续发展。'
      : `首行用英文说明 Picture 1（Shot 1）对齐 0.00 秒，Picture 2（实际最后一镜）对齐 ${duration.toFixed(2)} 秒。正文描述两帧之间可见的连续变化。`
    : '';
  const reference = mode === 'reference'
    ? '定义实际使用的素材及用途。可用 <Subject N> 表示来自素材、需要跟踪的人物、物件或风格。各段编号必须一致。summary 写任务类型与目标；retention_analysis 逐项说明出现位置及保留、迁移或复用关系。视觉用 fully_preserved / partially_preserved / attribute_transfer / weak_reference，音频用 fully_copy / partially_copy / reference。'
    : '';
  return [
    '你为 MiniMax H3 编写视频生成提示词。仅输出可直接用于生成的纯文本，使用下列字段及顺序。正文用英文，保留原始台词、歌词及画面文字的语言和标点。',
    alignment, structure, reference,
    '按播放顺序写可见动作、主体、构图、环境、镜头和同步声音。首镜标为 [Shot 1]，后续换镜时间以 mm:ss.mmm 表示，严格递增且小于给定时长。说话人使用稳定的 (S1) 等编号，台词用 <d>[Language] 原台词</d>，画面文字用双引号。单列环境和动作声；没有配乐时将 non_diegetic_music 写为 N/A。',
    '保留用户明确的素材用途、禁止项及画面要求。素材清单只提供类型、顺序和角色，不代表看过或听过文件；不得编造素材细节或引用不存在的素材。补充合理的镜头表现时以用户要求为准。',
  ].filter(Boolean).join('\n\n');
}
