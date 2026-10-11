import { STATUS_LABELS, type Status } from "@tracker/server/status";
import type { ReactNode } from "react";

export function StatusPill({ status }: { status: Status }) {
  return <span className={`pill pill-${status}`}>{STATUS_LABELS[status]}</span>;
}

function Icon({ children, size = 16, className }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number; className?: string };

export const ListIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </Icon>
);
export const InboxIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 9.5 3.6 3.5h8.8L14 9.5v3H2v-3Zm0 0h3.5l.8 1.5h3.4l.8-1.5H14" />
  </Icon>
);
export const SyncIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 8a5 5 0 0 1-8.9 3.1M3 8a5 5 0 0 1 8.9-3.1M12 2.5v2.6H9.4M4 13.5v-2.6h2.6" />
  </Icon>
);
export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2 13.5 13.5" />
  </Icon>
);
export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);
export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);
export const TrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </Icon>
);
export const UndoIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6.5h5.5a3 3 0 0 1 0 6H6M4 6.5 6.5 4M4 6.5 6.5 9" />
  </Icon>
);
export const ArrowIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" />
  </Icon>
);
export const ChevronsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3" />
  </Icon>
);
export const WarningIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.2v.1" />
  </Icon>
);
export const ExternalIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.5 3.5H3.5v9h9v-3M9.5 3.5h3v3M12.5 3.5 7.5 8.5" />
  </Icon>
);
export const GoogleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 8H8.5M14 8a6 6 0 1 1-1.8-4.3" />
  </Icon>
);
