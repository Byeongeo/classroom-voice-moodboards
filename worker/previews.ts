import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { decode as decodePng } from 'fast-png';
import { ApiError, now, sql, type Env } from './env';
import { putObject, recordExistingObject } from './storage';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 2_000_000;
const MAX_PREVIEW_BYTES = 96 * 1024;
const EDGE = 512;
type Pixels = { width: number; height: number; data: Uint8Array };
type Preview = { bytes: Uint8Array; mime: 'image/jpeg'; width: number; height: number };

// Header parsing happens before any decoder allocation. We never need EXIF,
// text or colour-profile metadata in a small display copy.
function dimensions(bytes: Uint8Array, mime: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length >= 33 && bytes.subarray(0,8).every((b,i)=>b===[137,80,78,71,13,10,26,10][i]))
    return { width:view.getUint32(16), height:view.getUint32(20) };
  if (mime !== 'image/jpeg' || bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216) return null;
  let at = 2, size: { width:number; height:number } | null = null;
  while (at + 4 < bytes.length) {
    if (bytes[at++] !== 255) return null;
    while (at < bytes.length && bytes[at] === 255) at++;
    const marker=bytes[at++];
    if (marker === 0xda || marker === 0xd9) return size;
    if (marker===0x01 || marker>=0xd0 && marker<=0xd7) continue;
    if (at+2>bytes.length) return null;
    const length=view.getUint16(at);
    if (length<2 || at+length>bytes.length) return null;
    // Phone EXIF/XMP can rotate the browser's original image. This bounded
    // codec does not apply those transforms, so preserve the original view
    // rather than produce a misleading sideways preview or copy GPS metadata.
    if (marker===0xe1) return null;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length>=8)
      size = { width:view.getUint16(at+5),height:view.getUint16(at+3) };
    at += length;
  }
  return null;
}

function boundedPng(bytes: Uint8Array, width: number, height: number) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[bytes[25]];
  // Larger bit depths, interlaced and animated images keep their original.
  if (bytes[24]!==8 || bytes[26]!==0 || bytes[27]!==0 || bytes[28]!==0 || !channels) return null;
  const chunks: Uint8Array[]=[bytes.subarray(0,8)], data:Uint8Array[]=[];
  let at=8,count=0,ended=false;
  while (at+12<=bytes.length && ++count<=512) {
    const length=view.getUint32(at),end=at+12+length;
    if (end>bytes.length || length>MAX_SOURCE_BYTES) return null;
    const type=String.fromCharCode(...bytes.subarray(at+4,at+8));
    if (count===1 && (type!=='IHDR' || length!==13) || type==='IHDR' && count!==1) return null;
    if (type==='PLTE' && (!length || length>768 || length%3)) return null;
    // Colour-key transparency needs a separate transform; preserve its source.
    if (type==='tRNS' && (bytes[25]!==3 || length>256)) return null;
    if (type==='IEND' && length!==0) return null;
    if (type==='acTL' || type==='fcTL' || type==='fdAT' || type==='eXIf') return null;
    if (['IHDR','PLTE','tRNS','IDAT','IEND'].includes(type)) chunks.push(bytes.subarray(at,end));
    if (type==='IDAT') data.push(bytes.subarray(at+8,at+8+length));
    at=end;
    if (type==='IEND') { ended=true; break; }
  }
  if (!ended || !data.length) return null;
  const expected=(width*channels+1)*height;
  // Deflate bombs are bounded before the general PNG decoder can inflate.
  // Strip compressed ancillary text/ICC chunks as well, so those cannot bypass
  // the pixel-data bound when fast-png subsequently decodes the sanitised PNG.
  if (inflateSync(Buffer.concat(data),{maxOutputLength:expected}).length!==expected) return null;
  return Buffer.concat(chunks);
}

function pngPixels(bytes: Uint8Array, width: number, height: number): Pixels|null {
  const safe=boundedPng(bytes,width,height);
  if (!safe) return null;
  const decoded=decodePng(safe,{checkCrc:true});
  if (decoded.width!==width || decoded.height!==height || decoded.depth!==8) return null;
  const rgba=new Uint8Array(width*height*4);
  for (let i=0;i<width*height;i++) {
    const at=i*decoded.channels,out=i*4;
    if (decoded.palette) {
      const colour=decoded.palette[decoded.data[at]];
      if (!colour) return null;
      const alpha=colour[3] ?? 255;
      for (let c=0;c<3;c++) rgba[out+c]=Math.round((colour[c]*alpha+255*(255-alpha))/255);
    } else {
      const alpha=decoded.channels===2 ? decoded.data[at+1] : decoded.channels===4 ? decoded.data[at+3] : 255;
      for (let c=0;c<3;c++) {
        const value=decoded.data[at+(decoded.channels<=2 ? 0 : c)];
        rgba[out+c]=Math.round((value*alpha+255*(255-alpha))/255);
      }
    }
    rgba[out+3]=255;
  }
  return {width,height,data:rgba};
}

function resize(source: Pixels, edge: number): Pixels {
  const scale=Math.min(1,edge/Math.max(source.width,source.height));
  const width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale));
  const data=new Uint8Array(width*height*4);
  // Average each source pixel block rather than point-sampling thin lines/text.
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const x0=Math.floor(x/scale),x1=Math.min(source.width,Math.max(x0+1,Math.floor((x+1)/scale)));
    const y0=Math.floor(y/scale),y1=Math.min(source.height,Math.max(y0+1,Math.floor((y+1)/scale)));
    const total=(x1-x0)*(y1-y0),out=(y*width+x)*4;
    for (let c=0;c<3;c++) {let sum=0;for(let sy=y0;sy<y1;sy++)for(let sx=x0;sx<x1;sx++)sum+=source.data[(sy*source.width+sx)*4+c];data[out+c]=Math.round(sum/total);}
    data[out+3]=255;
  }
  return {width,height,data};
}

// Synchronous, bounded codec work cannot interleave six decoder allocations in
// a shared isolate. Only the small encoded result survives the next I/O await.
export function createPreview(bytes: Uint8Array, mime: string): Preview|null {
  if (!bytes.length || bytes.length>MAX_SOURCE_BYTES) return null;
  try {
    const size=dimensions(bytes,mime);
    if (!size || size.width<1 || size.height<1 || size.width*size.height>MAX_PIXELS) return null;
    const source=mime==='image/jpeg'
      ? decodeJpeg(bytes,{useTArray:true,maxResolutionInMP:MAX_PIXELS/1_000_000,maxMemoryUsageInMB:32,tolerantDecoding:false})
      : mime==='image/png' ? pngPixels(bytes,size.width,size.height) : null;
    if (!source) return null;
    let small=resize(source,EDGE),encoded=encodeJpeg(small,64).data;
    if (encoded.byteLength>MAX_PREVIEW_BYTES) encoded=encodeJpeg(small,45).data;
    if (encoded.byteLength>MAX_PREVIEW_BYTES) {small=resize(source,384);encoded=encodeJpeg(small,35).data;}
    if (encoded.byteLength>MAX_PREVIEW_BYTES) {small=resize(source,256);encoded=encodeJpeg(small,45).data;}
    if (encoded.byteLength>=bytes.byteLength || encoded.byteLength>MAX_PREVIEW_BYTES) return null;
    return {bytes:new Uint8Array(encoded),mime:'image/jpeg',width:small.width,height:small.height};
  } catch { return null; }
}

type PreviewRow={id:string;student_id:string;object_key:string;mime_type:string;byte_size:number;preview_status:string;preview_attempts:number};
const previewKey=(image:PreviewRow)=>`previews/${image.student_id}/${image.id}`;
async function ready(env:Env,image:PreviewRow,object:R2Object) {
  await recordExistingObject(env,previewKey(image),object.size);
  await sql(env,`UPDATE images SET preview_object_key=?,preview_mime_type=?,preview_byte_size=?,preview_status='ready',preview_lease_until=0,preview_updated_at=? WHERE id=?`,previewKey(image),object.httpMetadata?.contentType||'image/jpeg',object.size,now(),image.id).run();
}

// This helper is best effort: a display optimisation never turns a successful
// original generation/upload into a failed learning record.
export async function queuePreview(env:Env,imageId:string) {
  try {
    const timestamp=now();
    const claimed=await sql(env,`UPDATE images SET preview_status='queued',preview_lease_until=?,preview_updated_at=? WHERE id=? AND preview_attempts<2
      AND (preview_status='pending' OR (preview_status IN ('queued','processing') AND preview_lease_until<?)) RETURNING id`,timestamp+600000,timestamp,imageId,timestamp).first();
    if (!claimed) return;
    try {await env.JOBS.send({stage:'preview',imageId});}
    catch {await sql(env,"UPDATE images SET preview_status='pending',preview_lease_until=0,preview_updated_at=? WHERE id=? AND preview_status='queued'",now(),imageId).run();}
  } catch {console.warn(JSON.stringify({type:'preview_schedule_error'}));}
}

export async function runPreview(env:Env,imageId:string):Promise<'done'|'busy'> {
  const image=await sql(env,`UPDATE images SET preview_status='processing',preview_attempts=preview_attempts+1,preview_lease_until=?,preview_updated_at=? WHERE id=? AND preview_attempts<2
    AND (preview_status IN ('pending','queued') OR (preview_status='processing' AND preview_lease_until<?)) RETURNING id,student_id,object_key,mime_type,byte_size,preview_status,preview_attempts`,now()+120000,now(),imageId,now()).first<PreviewRow>();
  if (!image) {const current=await sql(env,'SELECT preview_status FROM images WHERE id=?',imageId).first<{preview_status:string}>();return current?.preview_status==='processing'?'busy':'done';}
  try {
    const checkpoint=await env.IMAGES.head(previewKey(image));
    if (checkpoint) {await ready(env,image,checkpoint);return 'done';}
    const original=await env.IMAGES.get(image.object_key);
    if (!original) throw new Error('PREVIEW_SOURCE_MISSING');
    let result:Preview|null=null;
    if (original.size<=MAX_SOURCE_BYTES && ['image/jpeg','image/png'].includes(image.mime_type)) result=createPreview(new Uint8Array(await original.arrayBuffer()),image.mime_type);
    else await original.body.cancel();
    if (!result) {await sql(env,"UPDATE images SET preview_status='skipped',preview_lease_until=0,preview_updated_at=? WHERE id=?",now(),image.id).run();return 'done';}
    const stored=await putObject(env,previewKey(image),result.bytes,result.bytes.byteLength,{httpMetadata:{contentType:result.mime},customMetadata:{imageId:image.id,derived:'display-preview-v1'}});
    if (!stored) throw new Error('PREVIEW_STORAGE_ERROR');
    await ready(env,image,stored);
    return 'done';
  } catch(error) {
    const status=error instanceof ApiError && error.code==='STORAGE_LIMIT'?'skipped':image.preview_attempts>=2?'failed':'pending';
    await sql(env,'UPDATE images SET preview_status=?,preview_lease_until=0,preview_updated_at=? WHERE id=?',status,now(),image.id).run();
    if (status==='pending') throw new Error('PREVIEW_RETRY');
    return 'done';
  }
}

export async function recoverPreviews(env:Env) {
  const timestamp=now();
  const rows=await sql(env,`SELECT id FROM images WHERE preview_attempts<2 AND (preview_status='pending' OR (preview_status IN ('queued','processing') AND preview_lease_until<?)) ORDER BY created_at DESC LIMIT 2`,timestamp).all<{id:string}>();
  for (const row of rows.results) await queuePreview(env,row.id);
}
