import { Button } from 'antd';
import { LogIn, SquareTerminal } from 'lucide-react';
import { useEffect, useRef } from 'react';
import google from './assets/google-g.png';

type Props = {
  open: boolean;
  local: boolean;
  busy: boolean;
  available: boolean;
  notice: string;
  onOpenChange: (open: boolean) => void;
  onLogin: () => void;
};

export function LoginOptions({ open, local, busy, available, notice, onOpenChange, onLogin }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const provider = useRef<HTMLButtonElement>(null);
  const pointer = useRef('');

  useEffect(() => {
    if (!open) return;
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) onOpenChange(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (root.current?.contains(document.activeElement)) trigger.current?.focus();
      onOpenChange(false);
    }
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, onOpenChange]);

  return <div className="login-launcher" ref={root}
    onPointerEnter={e => { if (e.pointerType === 'mouse') onOpenChange(true); }}
    onPointerLeave={e => {
      if (e.pointerType === 'mouse' && document.activeElement !== provider.current) onOpenChange(false);
    }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) onOpenChange(false); }}>
    <Button ref={trigger} className="login-button" icon={<LogIn size={16} />} loading={busy}
      aria-expanded={open} aria-controls={open ? 'login-options' : undefined}
      onPointerDown={e => { pointer.current = e.pointerType; }}
      onClick={e => onOpenChange(e.detail > 0 && pointer.current === 'mouse' || !open)}
      onKeyDown={e => {
        if (e.key !== 'ArrowDown') return;
        e.preventDefault();
        onOpenChange(true);
        requestAnimationFrame(() => provider.current?.focus());
      }}>登录</Button>
    {open && <div className="login-orbit" id="login-options" role="group" aria-label="登录方式">
      <button ref={provider} className="login-provider" type="button" aria-disabled={!available || busy}
        aria-label={local ? '使用本地开发账号登录' : '使用 Google 登录'}
        aria-describedby={notice ? 'login-notice' : undefined}
        onClick={() => { if (available && !busy) onLogin(); }}>
        <span className="provider-disc">{local
          ? <SquareTerminal size={23} strokeWidth={1.7} aria-hidden="true" />
          : <img src={google} width={24} height={24} alt="" />}</span>
        <span className="provider-caption">{local ? '本地账号' : 'Google'}</span>
      </button>
      {notice && <span className="login-notice" id="login-notice" role="status">{notice}</span>}
    </div>}
  </div>;
}
