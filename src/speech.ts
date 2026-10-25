export type SpeechRecognizer = {lang:string;continuous:boolean;interimResults:boolean;start():void;stop():void;abort():void;onresult:((event:any)=>void)|null;onerror:((event:any)=>void)|null;onend:(()=>void)|null};
export type SpeechConstructor = new()=>SpeechRecognizer;
export type SpeechSession = {start():void;stop():void;abort():void};
const errors:Record<string,string>={
  'not-allowed':'마이크 권한이 거부되었습니다. 브라우저의 사이트 설정에서 마이크를 허용해 주세요.',
  'service-not-allowed':'이 브라우저에서 음성 인식 서비스를 사용할 수 없습니다. Chrome 또는 Edge에서 이 주소를 열어 보세요.',
  'audio-capture':'마이크를 찾지 못했습니다. 입력 장치와 다른 앱의 마이크 사용을 확인해 주세요.',
  network:'브라우저의 음성 인식 서버에 연결하지 못했습니다. 인터넷 연결을 확인하거나 Chrome·Edge에서 시도해 주세요.',
  'language-not-supported':'이 브라우저의 음성 인식 서비스가 한국어를 지원하지 않습니다. Chrome 또는 Edge에서 시도해 주세요.',
};
export function createSpeechSession({Constructor,initialText,initialRecognized='',onText,onRecognized,onState,onError}:{Constructor:SpeechConstructor;initialText:string;initialRecognized?:string;onText:(text:string)=>void;onRecognized?:(text:string)=>void;onState:(state:'listening'|'reconnecting'|'idle')=>void;onError:(message:string)=>void}):SpeechSession{
  const recognizer=new Constructor();recognizer.lang='ko-KR';recognizer.continuous=true;recognizer.interimResults=true;
  let wanted=false,aborted=false,base=initialText.trim(),heardBase=initialRecognized,finalText='',interimText='';
  let timer:ReturnType<typeof setTimeout>|undefined;let deadline:ReturnType<typeof setTimeout>|undefined;
  let starts:number[]=[];
  const fullText=()=>[base,finalText,interimText].filter(Boolean).join(' ').slice(0,1500);
  function clearTimers(){if(timer)clearTimeout(timer);if(deadline)clearTimeout(deadline);}
  function stopWithError(message:string){wanted=false;clearTimers();onState('idle');onError(message);}
  function begin(){
    if(!wanted||aborted)return;
    const now=Date.now();starts=starts.filter(value=>now-value<60000);
    if(starts.length>=5){stopWithError('브라우저가 음성 인식을 반복 종료했습니다. 마이크 권한을 확인하고 Chrome 또는 Edge에서 다시 시도해 주세요. 인식된 글은 남아 있습니다.');return;}
    starts.push(now);
    try{recognizer.start();onState('listening');}catch{stopWithError('음성 인식을 시작하지 못했습니다. Chrome·Edge와 마이크 설정을 확인해 주세요.');}
  }
  recognizer.onresult=event=>{
    if(aborted)return;
    const finals:string[]=[],interim:string[]=[];
    for(let i=0;i<event.results.length;i++){const text=event.results[i][0]?.transcript?.trim();if(text)(event.results[i].isFinal?finals:interim).push(text);}
    finalText=finals.join(' ');interimText=interim.join(' ');onText(fullText());onRecognized?.([heardBase,finalText,interimText].filter(Boolean).join(' ').slice(0,1500));
  };
  recognizer.onerror=event=>{
    if(aborted||(!wanted&&event.error==='aborted'))return;
    if(event.error==='no-speech')return; // Some browsers close on silence; bounded restart handles it.
    if(event.error==='aborted'){if(wanted)stopWithError('브라우저가 음성 인식을 중단했습니다. 인식된 글을 확인하고 다시 시작해 주세요.');return;}
    stopWithError(errors[event.error]||'음성 인식에 문제가 생겼습니다. 직접 입력으로도 참여할 수 있습니다.');
  };
  recognizer.onend=()=>{
    if(aborted)return;
    // Keep finalized phrases across service restarts; never duplicate accumulated results.
    base=[base,finalText].filter(Boolean).join(' ');heardBase=[heardBase,finalText].filter(Boolean).join(' ');finalText='';
    if(!wanted){interimText='';onState('idle');return;}
    interimText='';onText(base.slice(0,1500));onState('reconnecting');timer=setTimeout(begin,400);
  };
  return {
    start(){if(wanted||aborted)return;wanted=true;deadline=setTimeout(()=>{wanted=false;clearTimers();recognizer.stop();onState('idle');onError('5분 동안의 음성 입력을 마쳤습니다. 내용을 확인한 뒤 필요하면 다시 시작해 주세요.');},300000);begin();},
    stop(){wanted=false;clearTimers();try{recognizer.stop();}catch{}onState('idle');},
    abort(){aborted=true;wanted=false;clearTimers();recognizer.onresult=null;recognizer.onerror=null;recognizer.onend=null;try{recognizer.abort();}catch{}onState('idle');},
  };
}
