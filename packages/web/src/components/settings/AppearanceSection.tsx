import { useSession } from '../../store/session.ts';
import { Segmented, Toggle } from '../primitives.tsx';
import { Logo } from '../Logo.tsx';

const ACCENTS = [
  { id: 'aurora', label: 'Aurora', swatch: 'linear-gradient(135deg,#4c5bd4,#7c8cff,#5fe3e0)' },
  { id: 'ember', label: 'Ember', swatch: 'linear-gradient(135deg,#d4552b,#ff8a5c,#ffc76b)' },
  { id: 'moss', label: 'Moss', swatch: 'linear-gradient(135deg,#2a9463,#4fc98a,#b6e86a)' },
  { id: 'orchid', label: 'Orchid', swatch: 'linear-gradient(135deg,#8b45cc,#c47cff,#ff8ec9)' },
];

export function AppearanceSection() {
  const user = useSession((s) => s.user);
  const applyAppearance = useSession((s) => s.applyAppearance);

  if (!user) return null;
  const appearance = user.appearance;

  return (
    <div className="settings-section">
      <h3 className="settings-title">Appearance</h3>

      <section className="settings-block">
        <h4 className="settings-subtitle">Theme</h4>
        <Segmented
          label="Theme"
          value={appearance.theme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'System' },
          ]}
          onChange={(value) => void applyAppearance({ theme: value })}
        />
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Accent</h4>
        <p className="settings-hint">
          Repaints the mark, the outgoing bubbles and every focus ring.
        </p>
        <div className="accent-grid">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              className="accent-option"
              data-active={appearance.accent === accent.id ? 'true' : undefined}
              aria-pressed={appearance.accent === accent.id}
              onClick={() => void applyAppearance({ accent: accent.id })}
            >
              <span className="accent-swatch" style={{ background: accent.swatch }} />
              <span className="accent-label">{accent.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Message density</h4>
        <Segmented
          label="Message density"
          value={appearance.messageDensity}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
          onChange={(value) => void applyAppearance({ messageDensity: value })}
        />
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Text size</h4>
        <div className="font-scale-row">
          <span className="font-scale-small">A</span>
          <input
            type="range"
            min={0.85}
            max={1.3}
            step={0.05}
            value={appearance.fontScale}
            aria-label="Text size"
            className="range"
            onChange={(event) =>
              void applyAppearance({ fontScale: Number(event.target.value) })
            }
          />
          <span className="font-scale-large">A</span>
        </div>
      </section>

      <section className="settings-block">
        <Toggle
          label="Reduce motion"
          description="Removes transitions and the ambient animation. Your system setting is honoured too."
          checked={appearance.reducedMotion}
          onChange={(next) => void applyAppearance({ reducedMotion: next })}
        />
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">Preview</h4>
        <div className="appearance-preview">
          <div className="preview-header">
            <Logo size={22} />
            <span className="preview-title">Preview</span>
          </div>
          <div className="preview-thread">
            <div className="bubble-row">
              <div className="bubble" data-tail="true">
                <p className="bubble-text">This is how a received message looks.</p>
                <span className="bubble-meta">
                  <time>12:04</time>
                </span>
              </div>
            </div>
            <div className="bubble-row" data-mine="true">
              <div className="bubble" data-mine="true" data-tail="true">
                <p className="bubble-text">And this is one you sent. 🐺</p>
                <span className="bubble-meta">
                  <time>12:05</time>
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
