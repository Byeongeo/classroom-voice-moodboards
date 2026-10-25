import {afterEach,expect,it,vi} from 'vitest';
import {createSpeechSession,type SpeechRecognizer} from '../src/speech';
class Recognition implements SpeechRecognizer{
  static latest:Recognition;lang='';continuous=false;interimResults=false;onresult:any=null;onerror:any=null;onend:any=null;
  start=vi.fn();stop=vi.fn();abort=vi.fn();constructor(){Recognition.latest=this;}
}
afterEach(()=>vi.useRealTimers());
it('중간 인식 결과를 보여 주고 무음 종료 뒤 확정된 문장을 중복 없이 이어 쓴다',()=>{
  vi.useFakeTimers();const text=vi.fn(),recognized=vi.fn(),state=vi.fn(),error=vi.fn();
  const session=createSpeechSession({Constructor:Recognition,initialText:'기존 설명',initialRecognized:'이전 음성',onText:text,onRecognized:recognized,onState:state,onError:error});session.start();const r=Recognition.latest;
  expect(r.continuous).toBe(true);expect(r.interimResults).toBe(true);expect(r.lang).toBe('ko-KR');
  r.onresult({results:[Object.assign([{transcript:'파란 고양이'}],{isFinal:true}),Object.assign([{transcript:'한 마리'}],{isFinal:false})]});
  expect(text).toHaveBeenLastCalledWith('기존 설명 파란 고양이 한 마리');expect(recognized).toHaveBeenLastCalledWith('이전 음성 파란 고양이 한 마리');r.onend();vi.advanceTimersByTime(400);expect(r.start).toHaveBeenCalledTimes(2);
  r.onresult({results:[Object.assign([{transcript:'꽃 옆에 있어'}],{isFinal:true})]});expect(text).toHaveBeenLastCalledWith('기존 설명 파란 고양이 꽃 옆에 있어');
  session.stop();r.onend();vi.advanceTimersByTime(2000);expect(r.start).toHaveBeenCalledTimes(2);expect(state).toHaveBeenLastCalledWith('idle');expect(error).not.toHaveBeenCalled();
});
it('권한·네트워크 오류에는 재시작하지 않고 원인을 안내한다',()=>{
  vi.useFakeTimers();const error=vi.fn();const session=createSpeechSession({Constructor:Recognition,initialText:'',onText:vi.fn(),onState:vi.fn(),onError:error});session.start();const r=Recognition.latest;r.onerror({error:'network'});r.onend();vi.advanceTimersByTime(5000);expect(r.start).toHaveBeenCalledTimes(1);expect(error.mock.calls[0][0]).toContain('음성 인식 서버');
});
it('브라우저가 즉시 반복 종료하면 제한된 횟수만 복구하고 명확히 안내한다',()=>{
  vi.useFakeTimers();const error=vi.fn();const session=createSpeechSession({Constructor:Recognition,initialText:'',onText:vi.fn(),onState:vi.fn(),onError:error});session.start();const r=Recognition.latest;
  for(let i=0;i<6;i++){r.onend();vi.advanceTimersByTime(400);}expect(r.start).toHaveBeenCalledTimes(5);expect(error.mock.calls.at(-1)?.[0]).toContain('반복 종료');session.abort();
});
