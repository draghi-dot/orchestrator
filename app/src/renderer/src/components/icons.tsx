import type { CSSProperties, ReactNode } from 'react'
export type IconName = 'projects' | 'setup' | 'arena' | 'findings' | 'dna' | 'settings' | 'arrow' | 'plus' | 'check' | 'close' | 'pause' | 'play' | 'stop' | 'download' | 'folder' | 'code' | 'link' | 'search' | 'refresh' | 'shield' | 'file' | 'bolt' | 'account' | 'builder' | 'researcher' | 'thinker' | 'reporter' | 'improver'
const paths: Record<IconName, ReactNode> = {
  builder: <><path d="M3 3h18v18H3Z"/><path d="M3 9h18M9 9v12M15 3v6M9 15h12"/></>,
  researcher: <><path d="M3 3h18v18H3Z"/><path d="M7 3v18M12 3v18M17 3v18"/><path d="M3 12h18" strokeWidth="3"/></>,
  thinker: <><path d="M3 3h18v18H3Z"/><path d="m3 21 18-18M3 13 10 6m4 15 7-7M3 5l18 16"/></>,
  reporter: <><path d="M3 3h18v18H3Z"/><path d="M7 7h10M7 12h10M7 17h6" strokeWidth="2.4"/></>,
  improver: <><path d="M3 3h18v18H3Z"/><path d="m3 17 6-6 4 4 8-8M15 7h6v6"/></>,
  projects: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7m-3.5-3.5v7"/></>,
  setup: <><path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 3v6m8 0v6m-6 0v6" strokeWidth="3.5"/></>,
  arena: <><path d="m5 4 7 4 7-4v11l-7 5-7-5Z"/><path d="m5 4 7 9 7-9M12 13v7"/></>,
  findings: <><path d="M5 3h10l4 4v14H5Z"/><path d="M14 3v5h5M9 12h6m-6 4h4"/></>,
  dna: <><path d="M5 2c0 10 14 10 14 20M19 2C19 12 5 12 5 22M6 5h12M8 9h8M8 15h8M6 19h12"/></>,
  settings: <><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6"/>, plus: <path d="M12 4v16M4 12h16"/>,
  check: <path d="m5 12 4 4 10-10"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
  pause: <path d="M8 5v14m8-14v14" strokeWidth="4"/>, play: <path d="m8 4 12 8-12 8Z"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1"/>,
  download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>,
  folder: <path d="M3 6V4h7l3 3h8v13H3V6Z"/>,
  code: <path d="m7 6-5 6 5 6m10-12 5 6-5 6M14 3l-4 18"/>,
  link: <><path d="m9 15 6-6m-5-3 2-2a5 5 0 0 1 7 7l-2 2m-3 5-2 2a5 5 0 0 1-7-7l2-2"/></>,
  search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
  refresh: <><path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/></>,
  shield: <><path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z"/><path d="m8 11 3 3 5-5"/></>,
  file: <><path d="M5 3h10l4 4v14H5Z"/><path d="M14 3v5h5"/></>,
  bolt: <path d="M13 2 4 14h7l-1 8 10-13h-7Z"/>,
  account: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
}
export function Icon({ name, size = 20, style, className }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true" style={style} className={className}>{paths[name]}</svg>
}
