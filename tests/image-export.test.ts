import{expect,it}from'vitest';
import{imageParts}from'../src/imageFiles';
import type{SavedImage}from'../shared/contracts';
it('큰 이미지 기록을 파일 누락·중복 없이 내려받을 묶음으로 나눈다',()=>{
  const images=Array.from({length:40},(_,i)=>({id:String(i),byte_size:4*1024*1024})as SavedImage);
  const parts=imageParts(images);expect(parts.length).toBe(3);expect(parts.flat()).toEqual(images);expect(parts.every(p=>p.reduce((n,i)=>n+i.byte_size,0)<=64*1024*1024)).toBe(true);expect(imageParts([])).toEqual([[]]);
});
