// Chromium displays EXIF-oriented JPEGs when drawing the selection, while
// Electron's nativeImage exposes the raw scanline order.
export function jpegOrientation(bytes) {
  if (bytes.length<4 || bytes.readUInt16BE(0)!==0xffd8) return 1;
  for (let offset=2; offset+4<=bytes.length && bytes[offset]===0xff;) {
    const marker=bytes[offset+1];
    if (marker===0xda || marker===0xd9) break;
    const length=bytes.readUInt16BE(offset+2), end=offset+2+length;
    if (length<2 || end>bytes.length) break;
    const tiff=offset+10;
    if (marker===0xe1 && tiff+8<=end && bytes.toString('ascii',offset+4,tiff)==='Exif\0\0') {
      const byteOrder=bytes.toString('ascii',tiff,tiff+2);
      if (byteOrder==='II' || byteOrder==='MM') {
        const view=new DataView(bytes.buffer,bytes.byteOffset+tiff,end-tiff);
        const little=byteOrder==='II';
        const ifd=view.getUint32(4,little);
        if (view.getUint16(2,little)===42 && ifd+2<=view.byteLength) {
          const entries=view.getUint16(ifd,little);
          for (let i=0; i<entries; i++) {
            const pos=ifd+2+i*12;
            if(pos+12>view.byteLength) break;
            if(view.getUint16(pos,little)===274 && view.getUint16(pos+2,little)===3 && view.getUint32(pos+4,little)===1) {
              const orientation=view.getUint16(pos+8,little);
              if(orientation>=1 && orientation<=8) return orientation;
            }
          }
        }
      }
    }
    offset=end;
  }
  return 1;
}

export function orientPixels(bitmap,width,height,orientation) {
  const swappable=orientation>=5;
  const displayWidth=swappable?height:width, displayHeight=swappable?width:height;
  const target=Buffer.allocUnsafe(bitmap.length);
  const source=new Uint32Array(bitmap.buffer,bitmap.byteOffset,width*height);
  const dest=new Uint32Array(target.buffer,target.byteOffset,width*height);
  const reflectX=[2,3,6,7].includes(orientation), reflectY=[3,4,7,8].includes(orientation);
  for(let y=0; y<height; y++) for(let x=0; x<width; x++) {
    const column=swappable?y:x, row=swappable?x:y;
    const dx=reflectX?displayWidth-1-column:column, dy=reflectY?displayHeight-1-row:row;
    dest[dy*displayWidth+dx]=source[y*width+x];
  }
  return {bitmap:target,width:displayWidth,height:displayHeight};
}
