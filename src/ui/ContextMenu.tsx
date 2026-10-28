import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';

export interface MenuEntry {
  label?: string;
  kbd?: string;
  onClick?: () => void;
  disabled?: boolean;
  sep?: boolean;
}

const useCtx = create<{ x: number; y: number; items: MenuEntry[] } | null>(() => null);

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuEntry[]) {
  e.preventDefault();
  useCtx.setState({ x: e.clientX, y: e.clientY, items }, true);
}

export function ContextMenuHost() {
  const menu = useCtx();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(menu.x, innerWidth - r.width - 6), y: Math.min(menu.y, innerHeight - r.height - 6) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      useCtx.setState(null, true);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && useCtx.setState(null, true);
    setTimeout(() => {
      window.addEventListener('pointerdown', close);
      window.addEventListener('blur', close);
    });
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);
  if (!menu) return null;
  return (
    <div ref={ref} className="menu ctx-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className="menu-item"
            disabled={it.disabled}
            onClick={() => {
              useCtx.setState(null, true);
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.kbd && <kbd>{it.kbd}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
