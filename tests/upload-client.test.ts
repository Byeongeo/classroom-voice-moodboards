import{afterEach,expect,it,vi}from'vitest';
import{sendUpload}from'../src/imageFiles';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('업로드 대기 응답은 같은 요청 번호와 원본으로 다시 시도한다',async()=>{
  vi.useFakeTimers();const fetchMock=vi.fn().mockResolvedValueOnce(Response.json({code:'UPLOAD_BUSY',error:'대기'},{status:429})).mockResolvedValueOnce(Response.json({imageId:'saved'},{status:201}));vi.stubGlobal('fetch',fetchMock);
  const file=new File(['original'],'그림.png',{type:'image/png'});const task=sendUpload('activity',file,'same-upload-id',file);await vi.runAllTimersAsync();await task;
  expect(fetchMock).toHaveBeenCalledTimes(2);for(const [,options]of fetchMock.mock.calls){expect(options.headers['X-Upload-ID']).toBe('same-upload-id');expect(options.body).toBe(file);}
});
it('한도·권한 같은 영구 오류는 계속 업로드하지 않고 사용자에게 알린다',async()=>{
  const fetchMock=vi.fn().mockResolvedValue(Response.json({code:'UPLOAD_LIMIT',error:'업로드 한도'},{status:409}));vi.stubGlobal('fetch',fetchMock);const file=new File(['original'],'그림.png',{type:'image/png'});
  await expect(sendUpload('activity',file,'same-upload-id',file)).rejects.toThrow('업로드 한도');expect(fetchMock).toHaveBeenCalledTimes(1);
});
