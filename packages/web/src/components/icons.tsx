/**
 * Icon set.
 *
 * Hand-drawn on a 24×24 grid with a 1.75 stroke, round caps and round joins —
 * a single consistent weight so a row of icons reads as one family. Every icon
 * is `aria-hidden`; the accessible name always lives on the control that
 * contains it.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const SendIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 12 20 4.5 13.5 20l-2.4-6.1z" />
    <path d="m11.1 13.9 8.9-9.4" />
  </Icon>
);

export const PaperclipIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11.5 12.2 19.3a4.6 4.6 0 0 1-6.5-6.5l8.3-8.3a3.1 3.1 0 0 1 4.4 4.4l-8.3 8.3a1.5 1.5 0 0 1-2.2-2.2l7.6-7.6" />
  </Icon>
);

export const MicIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
  </Icon>
);

export const PhoneIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.2 4h3l1.5 4-2 1.4a11.5 11.5 0 0 0 5.9 5.9l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.2 6.2 2 2 0 0 1 6.2 4Z" />
  </Icon>
);

export const VideoIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="12.5" height="12" rx="3" />
    <path d="m15.5 11 5.5-3v8l-5.5-3z" />
  </Icon>
);

export const PhoneOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.2 4h3l1.5 4-2 1.4a11.5 11.5 0 0 0 5.9 5.9l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.2 6.2 2 2 0 0 1 6.2 4Z" />
    <path d="M3 3l18 18" />
  </Icon>
);

export const MicOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 6a3 3 0 0 1 6 0v5M9 11v.5a3 3 0 0 0 4.6 2.5" />
    <path d="M5.5 11a6.5 6.5 0 0 0 10.2 5.3M12 17.5V21M9 21h6M3 3l18 18" />
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.4M12 18.8v2.4M4.5 7.5l2.1 1.2M17.4 15.3l2.1 1.2M4.5 16.5l2.1-1.2M17.4 8.7l2.1-1.2" />
  </Icon>
);

export const ShieldIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z" />
  </Icon>
);

export const ShieldCheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);

export const LockIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4 2.8 20h18.4z" />
    <path d="M12 10v4M12 17h.01" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const DoubleCheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m2 12.5 4 4L14.5 8" />
    <path d="m9.5 16.5 8.5-8.5" />
  </Icon>
);

export const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Icon>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m14.5 5-7 7 7 7" />
  </Icon>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9.5 5 7 7-7 7" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 9.5 7 7 7-7" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);

export const MoreIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
);

export const ReplyIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 6 3.5 11 9 16v-3h4.5a5.5 5.5 0 0 1 5.5 5.5V20a7.5 7.5 0 0 0-7.5-7.5H9z" />
  </Icon>
);

export const ForwardIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 6l5.5 5L15 16v-3h-4.5A5.5 5.5 0 0 0 5 18.5V20a7.5 7.5 0 0 1 7.5-7.5H15z" />
  </Icon>
);

export const EditIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z" />
    <path d="m14.5 6.5 3.5 3.5" />
  </Icon>
);

export const TrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 6.5h15M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
    <path d="M6.5 6.5 7.5 20a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-13.5" />
  </Icon>
);

export const PinIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 3.5 20.5 9l-3 1-4 4-.5 4.5-6-6L11.5 12l4-4z" />
    <path d="m7.5 16.5-4 4" />
  </Icon>
);

export const BellIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 16V10a6 6 0 0 0-12 0v6l-1.5 2.5h15z" />
    <path d="M10 21h4" />
  </Icon>
);

export const BellOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 16V10a6 6 0 0 0-8.8-5.3M6 8.5V16l-1.5 2.5h13" />
    <path d="M10 21h4M3 3l18 18" />
  </Icon>
);

export const UsersIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9.5" cy="8.5" r="3.5" />
    <path d="M3.5 20a6 6 0 0 1 12 0" />
    <path d="M16.5 5.6a3.5 3.5 0 0 1 0 5.8M17.5 14.5a6 6 0 0 1 3 5.5" />
  </Icon>
);

export const UserIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.8 20.5a7.2 7.2 0 0 1 14.4 0" />
  </Icon>
);

export const LogOutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.5 4.5H18a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3.5" />
    <path d="M10 8.5 6.5 12l3.5 3.5M6.5 12H15" />
  </Icon>
);

export const DeviceIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="13" height="10" rx="2" />
    <path d="M6.5 19h6" />
    <rect x="17.5" y="9" width="4" height="10" rx="1.5" />
  </Icon>
);

export const PaletteIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-1 2-2s-.6-1.5-.6-2.2c0-.8.6-1.3 1.5-1.3H17a4 4 0 0 0 4-4c0-4-4-7.5-9-7.5Z" />
    <circle cx="8" cy="11" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="16" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
);

export const DatabaseIcon = (p: IconProps) => (
  <Icon {...p}>
    <ellipse cx="12" cy="6" rx="7.5" ry="3" />
    <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
    <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
  </Icon>
);

export const InfoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </Icon>
);

export const ArchiveIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="4.5" width="17" height="4" rx="1.5" />
    <path d="M5.5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5" />
    <path d="M10 12.5h4" />
  </Icon>
);

export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11M8 11.5l4 4 4-4" />
    <path d="M4.5 19.5h15" />
  </Icon>
);

export const PlayIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5.5 18 12 8 18.5z" fill="currentColor" />
  </Icon>
);

export const PauseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 5.5v13M15 5.5v13" strokeWidth={2.5} />
  </Icon>
);

export const SmileIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 14a4.5 4.5 0 0 0 7 0" />
    <circle cx="9.2" cy="9.8" r="1" fill="currentColor" stroke="none" />
    <circle cx="14.8" cy="9.8" r="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const BlockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6 6 12 12" />
  </Icon>
);

export const KeyIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="4.5" />
    <path d="m11.2 11.2 8.3 8.3M16.5 16.5l2-2M14 14l1.5-1.5" />
  </Icon>
);

export const OfflineIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 8.5a15 15 0 0 1 5-3M16.5 5.5a15 15 0 0 1 5 3M6.5 12.2a10 10 0 0 1 3-1.7M14.5 10.5a10 10 0 0 1 3 1.7M10.2 15.8a5 5 0 0 1 3.6 0M12 19.5h.01" />
    <path d="M3 3l18 18" />
  </Icon>
);
