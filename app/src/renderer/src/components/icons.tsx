import {
  ArrowClockwise,
  ArrowLeft,
  ArrowSquareOut,
  BookOpenText,
  Bug,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  Circle,
  CircleNotch,
  Clock,
  Code,
  Copy,
  DownloadSimple,
  Eye,
  FileText,
  FileZip,
  Flask,
  FolderSimple,
  Funnel,
  GearSix,
  GithubLogo,
  Globe,
  GraduationCap,
  Hammer,
  Info,
  ListChecks,
  Lock,
  MagnifyingGlass,
  MinusCircle,
  Package,
  Pause,
  Play,
  Plus,
  Scales,
  SignOut,
  Stop,
  Terminal,
  User,
  Warning,
  WarningCircle,
  X,
  XCircle,
} from '@phosphor-icons/react'
import type { Role } from '../../../shared/domain'

/** One icon family (Phosphor, regular weight) used everywhere. */
export const I = {
  audits: ListChecks,
  projects: FolderSimple,
  findings: Bug,
  playbook: BookOpenText,
  settings: GearSix,
  plus: Plus,
  play: Play,
  pause: Pause,
  stop: Stop,
  refresh: ArrowClockwise,
  back: ArrowLeft,
  external: ArrowSquareOut,
  download: DownloadSimple,
  close: X,
  check: Check,
  checkCircle: CheckCircle,
  xCircle: XCircle,
  circle: Circle,
  spinner: CircleNotch,
  minusCircle: MinusCircle,
  warning: Warning,
  warningCircle: WarningCircle,
  info: Info,
  caretRight: CaretRight,
  caretDown: CaretDown,
  search: MagnifyingGlass,
  filter: Funnel,
  github: GithubLogo,
  zip: FileZip,
  sample: Package,
  code: Code,
  globe: Globe,
  lock: Lock,
  user: User,
  clock: Clock,
  terminal: Terminal,
  file: FileText,
  copy: Copy,
  eye: Eye,
  signOut: SignOut,
}

export const AGENT_ICON: Record<Role, typeof Hammer> = {
  builder: Hammer,
  researcher: Flask,
  thinker: Scales,
  reporter: FileText,
  improver: GraduationCap,
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <CircleNotch size={size} className="spinner" aria-hidden />
}

/** The Baton mark: a baton stroke with its tip, on a rounded square. */
export function BatonMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="brand__mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect width="24" height="24" rx="6.5" fill="var(--text)" />
      <path d="M6.6 17.4 15.6 8.4" stroke="var(--bg)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="17.2" cy="6.8" r="2.1" fill="var(--accent)" />
    </svg>
  )
}
