import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function Modal({title,onClose,children,className=''}:{title:string;onClose:()=>void;children:ReactNode;className?:string}){
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const node=dialog.current;const previous=document.activeElement as HTMLElement|null;node?.showModal();return()=>{node?.close();previous?.focus();};},[]);
  return createPortal(<dialog ref={dialog} className={'detail-dialog '+className} aria-label={title} onCancel={(event)=>{event.preventDefault();onClose();}} onClick={(event)=>{if(event.target===event.currentTarget)onClose();}}><div className="dialog-content"><div className="form-heading no-print"><h2>{title}</h2><button type="button" onClick={onClose} aria-label="창 닫기"><X size={20}/></button></div>{children}</div></dialog>,document.body);
}
