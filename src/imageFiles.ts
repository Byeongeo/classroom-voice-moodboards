import type { SavedImage } from '../shared/contracts';
import { api, saveFile } from './api';

export async function validatedUpload(file:File):Promise<Blob>{
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('JPEG·PNG·WebP 이미지를 선택해 주세요.');
  if(file.size>4*1024*1024)throw new Error('업로드할 원본 이미지는 4MB 이하여야 합니다.');
  const image=await createImageBitmap(file);
  try{
    if(image.width>4096||image.height>4096)throw new Error('이미지의 가로·세로를 각각 4096픽셀 이하로 줄여 주세요.');
    return file; // Preserve the exact uploaded bytes for the immutable history.
  }finally{image.close();}
}
export async function sendUpload(activityId:string,file:File,id:string,blob:Blob){
  for(let attempt=0;attempt<16;attempt++){
    let response:Response;let result:{code?:string;error?:string};
    try{
      response=await fetch(`/api/activities/${activityId}/uploads`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':blob.type,'X-Upload-ID':id,'X-File-Name':encodeURIComponent(file.name)},body:blob});
      result=await response.json();
    }catch{
      if(attempt===15)throw new Error('연결이 불안정합니다. 원본 파일과 업로드 기록을 확인한 뒤 다시 시도해 주세요.');
      await new Promise(resolve=>setTimeout(resolve,1200+Math.random()*500));continue;
    }
    if(response.ok)return;
    if(attempt<15&&(((response.status===429||response.status===409)&&result.code==='UPLOAD_BUSY')||(response.status===503&&result.code==='UPLOAD_STORAGE_ERROR'))){await new Promise(resolve=>setTimeout(resolve,1200+Math.random()*500));continue;}
    throw new Error(result.error||'이미지를 올리지 못했습니다.');
  }
}
export async function allRecords<T>(activityId:string,kind:'records'|'image-actions'):Promise<T[]>{
  let next:{afterTime:number;afterId:string}|null=null;const rows:T[]=[];
  do{
    const query=next?'?'+new URLSearchParams({afterTime:String(next.afterTime),afterId:next.afterId}):'';
    const page=await api<{rows:T[];next:typeof next}>(`/api/activities/${activityId}/${kind}${query}`);rows.push(...page.rows);next=page.next;
  }while(next);
  return rows;
}
export async function imageBlob(image:SavedImage){const response=await fetch(image.imageUrl);if(!response.ok)throw new Error('저장된 이미지를 내려받지 못했습니다.');return response.blob();}
export async function downloadImage(image:SavedImage){saveFile(await imageBlob(image),`교실-이미지-${image.id}.${image.mime_type.split('/')[1]}`);}
export async function imageZip(images:SavedImage[],name:string,records?:Record<string,unknown>){
  const {default:JSZip}=await import('jszip');const zip=new JSZip();
  for(const image of images)zip.file(`images/${image.id}.${image.mime_type.split('/')[1]}`,await imageBlob(image));
  if(records)for(const [filename,data]of Object.entries(records))zip.file(filename,JSON.stringify(data,null,2));
  saveFile(await zip.generateAsync({type:'blob'}),name);
}
export function imageParts(images:SavedImage[],limit=64*1024*1024):SavedImage[][]{
  const parts:SavedImage[][]=[];let current:SavedImage[]=[];let bytes=0;
  for(const image of images){const size=image.byte_size||1024*1024;if(current.length&&bytes+size>limit){parts.push(current);current=[];bytes=0;}current.push(image);bytes+=size;}
  if(current.length||!parts.length)parts.push(current);return parts;
}
