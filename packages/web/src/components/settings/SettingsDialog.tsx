/**
 * Settings.
 *
 * A sidebar of sections rather than one long scroll, so Security and Devices —
 * the two that matter most in a messenger like this — are one click away
 * rather than buried.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Modal } from '../primitives.tsx';
import {
  BellIcon,
  DatabaseIcon,
  DeviceIcon,
  InfoIcon,
  LockIcon,
  PaletteIcon,
  ShieldIcon,
  UserIcon,
} from '../icons.tsx';
import type { SettingsSection } from '../../store/ui.ts';
import { AccountSection } from './AccountSection.tsx';
import { PrivacySection } from './PrivacySection.tsx';
import { SecuritySection } from './SecuritySection.tsx';
import { NotificationsSection } from './NotificationsSection.tsx';
import { AppearanceSection } from './AppearanceSection.tsx';
import { DevicesSection } from './DevicesSection.tsx';
import { StorageSection } from './StorageSection.tsx';
import { AboutSection } from './AboutSection.tsx';

const SECTIONS: {
  id: SettingsSection;
  label: string;
  icon: ReactNode;
}[] = [
  { id: 'account', label: 'Account', icon: <UserIcon size={16} /> },
  { id: 'privacy', label: 'Privacy', icon: <LockIcon size={16} /> },
  { id: 'security', label: 'Security', icon: <ShieldIcon size={16} /> },
  { id: 'notifications', label: 'Notifications', icon: <BellIcon size={16} /> },
  { id: 'appearance', label: 'Appearance', icon: <PaletteIcon size={16} /> },
  { id: 'devices', label: 'Devices', icon: <DeviceIcon size={16} /> },
  { id: 'storage', label: 'Storage', icon: <DatabaseIcon size={16} /> },
  { id: 'about', label: 'About', icon: <InfoIcon size={16} /> },
];

export function SettingsDialog({
  open,
  section,
  onClose,
}: {
  open: boolean;
  section?: SettingsSection;
  onClose: () => void;
}) {
  const [active, setActive] = useState<SettingsSection>(section ?? 'account');

  useEffect(() => {
    if (open && section) setActive(section);
  }, [open, section]);

  return (
    <Modal open={open} onClose={onClose} title="Settings" size="full">
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="settings-nav-item"
              data-active={active === entry.id ? 'true' : undefined}
              aria-current={active === entry.id ? 'page' : undefined}
              onClick={() => setActive(entry.id)}
            >
              {active === entry.id ? (
                <motion.span
                  layoutId="settings-nav-indicator"
                  className="settings-nav-indicator"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              ) : null}
              <span className="settings-nav-icon">{entry.icon}</span>
              <span className="settings-nav-label">{entry.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          {/*
            An entrance animation only. A nested `AnimatePresence mode="wait"`
            here would hold its child until an exit completes — and while the
            whole dialog is itself exiting, that exit never arrives, leaving the
            modal permanently on screen.
          */}
          <motion.div
            key={active}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            {active === 'account' ? <AccountSection /> : null}
            {active === 'privacy' ? <PrivacySection /> : null}
            {active === 'security' ? <SecuritySection /> : null}
            {active === 'notifications' ? <NotificationsSection /> : null}
            {active === 'appearance' ? <AppearanceSection /> : null}
            {active === 'devices' ? <DevicesSection /> : null}
            {active === 'storage' ? <StorageSection /> : null}
            {active === 'about' ? <AboutSection /> : null}
          </motion.div>
        </div>
      </div>
    </Modal>
  );
}
