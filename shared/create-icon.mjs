import {deflateSync} from 'node:zlib';
import {writeFileSync} from 'node:fs';
function crc32(buffer){let c=0xffffffff;for(const b of buffer){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc32(Buffer.concat([t,data])),data.length+8);return b;}
export function createIcon(file){
  const size=32,raw=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=y*(size*4+1)+1+x*4;let rgba=[28,38,32,255];
    if(x>=6&&x<=25&&y>=8&&y<=26)rgba=[223,237,227,255];
    if(x>=8&&x<=23&&y>=13&&y<=24)rgba=[28,38,32,255];
    if((x===10||x===21)&&y>=5&&y<=11)rgba=[101,219,177,255];
    if(y>=16&&y<=19&&x>=11&&x<=21)rgba=[101,219,177,255];
    raw.set(rgba,i);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  writeFileSync(file,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
}
