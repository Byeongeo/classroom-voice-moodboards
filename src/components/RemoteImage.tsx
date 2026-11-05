import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import '../remoteImage.css';

type Props = ImgHTMLAttributes<HTMLImageElement> & {
  /** Keep links outside the retry control; never nest a button in an anchor. */
  href?: string;
  wrapperClassName?: string;
  compact?: boolean;
};
type Failure = 'checking' | 'access' | 'missing' | 'temporary' | 'network' | 'invalid';
const failureText: Record<Failure, string> = {
  checking: '이미지 연결 상태를 확인하고 있습니다.',
  access: '로그인이 만료되었거나 접근 권한이 없습니다. 로그인 상태를 확인해 주세요.',
  missing: '이미지를 찾을 수 없거나 접근 권한이 없습니다. 교사에게 확인해 주세요.',
  temporary: '이미지 저장소에 잠시 연결하지 못했습니다.',
  network: '이미지 연결이 끊겼습니다. 네트워크 상태를 확인해 주세요.',
  invalid: '이미지를 표시하지 못했습니다. 다시 불러오거나 원본을 확인해 주세요.',
};

function ImageRequest({src, alt = '', href, wrapperClassName = '', compact = false, onLoad, onError, onClick, onKeyDown, ...props}: Props) {
  const [phase, setPhase] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [retryStamp, setRetryStamp] = useState('');
  const [delayed, setDelayed] = useState(false);
  const [inView, setInView] = useState(props.loading !== 'lazy');
  const [failure, setFailure] = useState<Failure>('checking');
  const [retryQueued, setRetryQueued] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const mounted = useRef(true);
  const attemptId = useRef(0);
  const retriedAutomatically = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diagnostic = useRef<AbortController | null>(null);
  // Normal views retain their stable URL and cache entry. Only an explicit
  // retry gets a new URL, avoiding reuse of a browser's failed image resource.
  const fragmentAt = src?.indexOf('#') ?? -1;
  const sourcePath = fragmentAt >= 0 ? src!.slice(0, fragmentAt) : src;
  const fragment = fragmentAt >= 0 ? src!.slice(fragmentAt) : '';
  const requestSrc = attempt && sourcePath && !/^(?:data|blob):/i.test(sourcePath)
    ? sourcePath + (sourcePath.includes('?') ? '&' : '?') + '_image_retry=' + retryStamp + fragment : src;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (retryTimer.current) clearTimeout(retryTimer.current); diagnostic.current?.abort(); };
  }, []);
  useEffect(() => {
    if (props.loading !== 'lazy' || typeof IntersectionObserver === 'undefined') { setInView(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setInView(true); observer.disconnect(); }
    }, {rootMargin:'200px'});
    if (wrapper.current) observer.observe(wrapper.current);
    return () => observer.disconnect();
  }, [props.loading]);
  useEffect(() => {
    if (image.current?.complete && image.current.naturalWidth > 0) { setPhase('loaded'); setDelayed(false); }
  }, [attempt]);
  useEffect(() => {
    if (phase !== 'loading' || !inView) return;
    const timer = setTimeout(() => setDelayed(true), 15000);
    return () => clearTimeout(timer);
  }, [phase, attempt, inView]);

  function retry() {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null; diagnostic.current?.abort();
    attemptId.current++; setAttempt(attemptId.current);
    setRetryStamp(Date.now().toString(36) + '-' + attemptId.current);
    setPhase('loading'); setDelayed(false); setFailure('checking'); setRetryQueued(false);
  }
  async function diagnose(failedAttempt: number) {
    diagnostic.current?.abort();
    const controller = new AbortController(); diagnostic.current = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    let reason: Failure = 'network';
    try {
      const response = await fetch(requestSrc!, {method:'HEAD',credentials:'same-origin',cache:'no-store',signal:controller.signal});
      reason = response.status === 401 || response.status === 403 ? 'access'
        : response.status === 404 ? 'missing' : response.ok ? 'invalid' : 'temporary';
    } catch { /* A network failure has no HTTP status to inspect. */ }
    finally { clearTimeout(timeout); }
    if (!mounted.current || attemptId.current !== failedAttempt || diagnostic.current !== controller) return;
    diagnostic.current = null;
    setFailure(reason);
    // Authentication failures remain visible. Only one automatic retry is
    // allowed per mounted image, with jitter to avoid a classroom retry burst.
    if (reason !== 'access' && reason !== 'missing' && !retriedAutomatically.current) {
      retriedAutomatically.current = true; setRetryQueued(true);
      retryTimer.current = setTimeout(retry, 1000 + Math.random() * 900);
    }
  }
  const clickable = !!onClick && !href;
  const imageNode = <img {...props} key={attempt} ref={image} src={requestSrc} alt={alt}
    role={props.role || (clickable ? 'button' : undefined)} tabIndex={props.tabIndex ?? (clickable ? 0 : undefined)}
    onClick={onClick}
    onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented && clickable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.currentTarget.click(); } }}
    onLoad={event => { if (attemptId.current !== attempt) return; setPhase('loaded'); setDelayed(false); const pending = diagnostic.current; diagnostic.current = null; pending?.abort(); if (retryTimer.current) clearTimeout(retryTimer.current); setRetryQueued(false); onLoad?.(event); }}
    onError={event => { if (attemptId.current !== attempt) return; setPhase('failed'); setFailure('checking'); onError?.(event); void diagnose(attempt); }}/>;
  const showStatus = phase !== 'loaded';
  const compactFailure = failure === 'access' ? '로그인·권한을 확인하세요.' : failure === 'missing' ? '이미지·권한을 확인하세요.' : failure === 'checking' ? '연결 확인 중…' : '이미지 연결을 확인하세요.';
  return <span ref={wrapper} className={'remote-image ' + wrapperClassName} data-state={phase} aria-busy={phase === 'loading'}>
    {href ? <a className="remote-image-link" href={href} target="_blank" rel="noreferrer">{imageNode}</a> : imageNode}
    {showStatus && <span className="remote-image-status" role="status">
      {phase === 'loading' ? <><span className="remote-image-spinner" aria-hidden="true"/><span>{delayed ? (compact ? '전송이 지연되고 있습니다.' : '이미지 전송이 지연되고 있습니다. 연결 상태를 확인하거나 다시 불러와 주세요.') : (compact ? '불러오는 중…' : '이미지를 불러오는 중…')}</span></>
        : <span aria-label={failureText[failure]}>{compact ? compactFailure : failureText[failure]}{retryQueued && !compact && ' 잠시 후 한 번 다시 연결합니다.'}</span>}
      {(phase === 'failed' || delayed) && <button type="button" className="remote-image-retry" onClick={event => { event.preventDefault(); event.stopPropagation(); retry(); }}>{compact ? '다시 시도' : '이미지 다시 불러오기'}</button>}
    </span>}
  </span>;
}

export default function RemoteImage(props: Props) {
  // A source change starts a fresh request; normal workspace polling keeps the
  // same source and mounted element, including its already decoded image.
  return <ImageRequest key={props.src || ''} {...props}/>;
}
