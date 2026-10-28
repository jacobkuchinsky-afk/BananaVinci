import type { SVGProps } from 'react';

const paths: Record<string, string> = {
  select: 'M5 3l12 7-5.2 1.3L14.5 17l-2.4 1-2.6-5.6L5 15.5z',
  blade: 'M4 20L15 9M15 9l3-5 2 2-5 3zM4 20l3-1M9 3v4M3 9h4',
  slip: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4M10 6v12M14 6v12',
  magnet: 'M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4zM6 8h4M14 8h4',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  stop: 'M6 6h12v12H6z',
  start: 'M6 5v14M19 5L9 12l10 7z',
  end: 'M18 5v14M5 5l10 7-10 7z',
  prev: 'M15 5l-8 7 8 7',
  next: 'M9 5l8 7-8 7',
  loop: 'M17 2l3 3-3 3M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 01-4 4H4',
  marker: 'M6 3h12v13l-6 5-6-5z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.6 6.6A17 17 0 002 12s4 7 10 7a9.6 9.6 0 005.4-1.6M9.9 9.9a3 3 0 004.2 4.2',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
  unlock: 'M6 11h12v10H6zM8 11V7a4 4 0 017.5-2',
  speaker: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1.5 1.5 0 100-.01',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
  audio: 'M9 18V6l11-2v12M9 18a3 3 0 11-6 0 3 3 0 016 0zM20 16a3 3 0 11-6 0 3 3 0 016 0z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  shape: 'M4 4h9v9H4zM16 11a5 5 0 110 10 5 5 0 010-10z',
  solid: 'M4 4h16v16H4z',
  adjust: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 3v18M12 3a9 9 0 010 18',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  search: 'M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM20 20l-4.8-4.8',
  chevron: 'M6 9l6 6 6-6',
  reset: 'M4 12a8 8 0 108-8 8.6 8.6 0 00-6 2.5L4 8.5M4 4v4.5h4.5',
  close: 'M6 6l12 12M18 6L6 18',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  folder: 'M3 6h6l2 2h10v11H3z',
  export: 'M12 3v12M7 10l5 5 5-5M4 17v4h16v-4',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  split: 'M12 3v18M8 8l-4 4 4 4M16 8l4 4-4 4',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 015 .5c0 2-2.5 2-2.5 4M12 17h.01',
  sync: 'M20 11a8 8 0 00-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0014.3 4.9L20 16M20 20v-4h-4',
  group: 'M8 3h13v13H8zM5 7H3v14h14v-2',
  mic: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3M8 21h8',
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 15, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const filled = name === 'play' || name === 'pause' || name === 'stop' || name === 'start' || name === 'end' || name === 'solid';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect width="16" height="16" rx="3.5" fill="#1c1c1f" stroke="#34343a" />
      <path d="M3 10.5c3 2.4 8 1.4 10-5" stroke="#facc15" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <circle cx="13" cy="5" r="0.9" fill="#3b82f6" />
    </svg>
  );
}
