import { Button } from 'antd';
import { LogIn } from 'lucide-react';
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

  return <div className="login-launcher" data-open={open} ref={root}
    onPointerEnter={e => { if (e.pointerType === 'mouse') onOpenChange(true); }}
    onPointerLeave={e => {
      if (e.pointerType === 'mouse' && document.activeElement !== provider.current) onOpenChange(false);
    }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) onOpenChange(false); }}>
    <Button ref={trigger} className="login-button" icon={<LogIn size={16} />} loading={busy}
      aria-expanded={open} aria-controls="login-options"
      onPointerDown={e => { pointer.current = e.pointerType; }}
      onClick={e => onOpenChange(e.detail > 0 && pointer.current === 'mouse' || !open)}
      onKeyDown={e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        onOpenChange(true);
        requestAnimationFrame(() => provider.current?.focus());
      }}>登录</Button>
    <div className="login-options" id="login-options" role="group" aria-label="登录方式" inert={!open}>
      <button ref={provider} className="login-provider" type="button" aria-disabled={!available || busy}
        aria-label={local ? '使用本地开发账号登录' : '使用 Google 登录'}
        aria-describedby={notice ? 'login-notice' : undefined}
        onKeyDown={e => { if (e.key === 'ArrowRight') { e.preventDefault(); trigger.current?.focus(); } }}
        onClick={() => { if (available && !busy) onLogin(); }}>
        <img src={google} width={19} height={19} alt="" />
      </button>
    </div>
    {open && notice && <span className="login-notice" id="login-notice" role="status">{notice}</span>}
  </div>;
}
