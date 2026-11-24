// Runs only in the local, sandboxed board renderer.
window.drawCoverBoard = async ({title, sources}) => {
  const images = await Promise.all(sources.map(async source => {
    const image = new Image();
    image.src = source.url;
    await image.decode();
    return image;
  }));
  const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
  const assets = sources.slice(1), columns = assets.length > 4 ? 3 : assets.length > 1 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(assets.length / columns));
  // The API accepts 16 inputs. At the limit include the last source at its
  // original dimensions below the guide, without discarding a detail image.
  const appendix = sources.length === 16 ? images.at(-1) : null;
  const H = Math.max(880, 180 + rows * 240), margin = 28, gap = 16, top = 130;
  canvas.width = Math.max(1440, appendix?.naturalWidth || 0);
  canvas.height = H + (appendix ? appendix.naturalHeight + 52 : 0);
  ctx.fillStyle = '#edf1ee'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  function line(text, x, y, width, size, color, bold = false) {
    ctx.font = (bold ? '600 ' : '') + size + 'px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = color;
    if (ctx.measureText(text).width > width) {
      let end = text.length;
      while (end > 0 && ctx.measureText(text.slice(0, end) + '…').width > width) end--;
      text = text.slice(0, end) + '…';
    }
    ctx.fillText(text, x, y);
  }
  line('组合素材参考 · 版式以原模板为准', margin, 49, 1370, 30, '#143e34', true);
  line('标题  ' + (title || '沿用模板原文'), margin, 99, 1370, 30, '#182622');
  function tile(i, x, y, w, h) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, w, h);
    line(sources[i].label, x + 14, y + 32, w - 28, 21, '#36564c', true);
    const image = images[i], iw = w - 20, ih = h - 55;
    const scale = Math.min(iw / image.naturalWidth, ih / image.naturalHeight);
    const dw = image.naturalWidth * scale, dh = image.naturalHeight * scale;
    ctx.drawImage(image, x + (w-dw)/2, y + 46 + (ih-dh)/2, dw, dh);
  }
  const leftWidth = assets.length ? 630 : 1440 - margin * 2;
  tile(0, margin, top, leftWidth, H-top-margin);
  const right = margin + leftWidth + gap, width = (1440-margin-right-(columns-1)*gap)/columns;
  const height = (H-top-margin-(rows-1)*gap)/rows;
  assets.forEach((_, i) => tile(i+1, right + (i%columns)*(width+gap), top + Math.floor(i/columns)*(height+gap), width, height));
  if (appendix) {
    line('原始尺寸附图 · ' + sources.at(-1).label, margin, H+34, canvas.width-margin*2, 24, '#36564c', true);
    ctx.drawImage(appendix,0,H+52);
  }
  return canvas.toDataURL('image/png').split(',')[1];
};
