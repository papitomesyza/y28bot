import { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

const LANES = [
  'BTC-5M', 'BTC-15M', 'ETH-5M', 'ETH-15M',
  'SOL-5M', 'SOL-15M', 'XRP-5M', 'XRP-15M',
];

const LOG_LEVELS = ['all', 'signals-only', 'errors-only'];

const TIER_LABELS = ['< $75', '$75 – $150', '$150 – $300', '$300+'];

function Toggle({ value, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        background: value ? '#00D341' : '#333',
        border: 'none',
        cursor: 'pointer',
        position: 'relative',
        transition: 'background 0.2s',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: value ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.2s',
        }}
      />
    </button>
  );
}

function NumberInput({ value, onChange, width = 60 }) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      style={{
        width,
        background: '#141414',
        border: '1px solid #1A1A1A',
        borderRadius: 4,
        color: '#fff',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13,
        padding: '4px 8px',
        outline: 'none',
      }}
      onFocus={(e) => { e.target.style.boxShadow = '0 0 0 1px #00D341'; }}
      onBlur={(e) => { e.target.style.boxShadow = 'none'; }}
    />
  );
}

function SectionHeader({ children }) {
  return (
    <div
      style={{
        color: '#888',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: 10,
        marginTop: 20,
      }}
    >
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 0',
      }}
    >
      <span style={{ color: '#ccc', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function buildDefaults() {
  return {
    dryRun: true,
    logLevel: 'all',
    irrevBase: 1.7,
    irrevStack2: 2.5,
    irrevStack3: 3.5,
    spreadScalpIrrev: 3.0,
    entryWindow5M: 210,
    entryWindow15M: 420,
    spreadScalpLastSeconds: 60,
    maxTradeSize: 20,
    maxLossPerTrade: 5,
    minShares: 5,
    minPoolBalance: 10,
    tier1: 8,
    tier2: 10,
    tier3: 12,
    tier4: 15,
    lanesEnabled: Object.fromEntries(LANES.map((l) => [l, true])),
    cbMaxLosses: 3,
    cbWindowHours: 1,
    cbPauseHours: 2,
  };
}

function mapServerSettings(server) {
  const d = buildDefaults();
  if (!server) return d;
  return {
    dryRun: server.dryRun ?? d.dryRun,
    logLevel: server.logLevel ?? d.logLevel,
    irrevBase: server.irrevThreshold ?? d.irrevBase,
    irrevStack2: server.irrevStack2 ?? d.irrevStack2,
    irrevStack3: server.irrevStack3 ?? d.irrevStack3,
    spreadScalpIrrev: server.spreadScalpIrrev ?? d.spreadScalpIrrev,
    entryWindow5M: server.entryWindow5M ?? d.entryWindow5M,
    entryWindow15M: server.entryWindow15M ?? d.entryWindow15M,
    spreadScalpLastSeconds: server.spreadScalpLastSeconds ?? d.spreadScalpLastSeconds,
    maxTradeSize: server.maxTradeSize ?? d.maxTradeSize,
    maxLossPerTrade: server.maxLossPerTrade ?? d.maxLossPerTrade,
    minShares: server.minShares ?? d.minShares,
    minPoolBalance: server.minPoolBalance ?? d.minPoolBalance,
    tier1: server.tier1 ?? d.tier1,
    tier2: server.tier2 ?? d.tier2,
    tier3: server.tier3 ?? d.tier3,
    tier4: server.tier4 ?? d.tier4,
    lanesEnabled: server.laneEnabled ?? d.lanesEnabled,
    cbMaxLosses: server.cbMaxLosses ?? d.cbMaxLosses,
    cbWindowHours: server.cbWindowHours ?? d.cbWindowHours,
    cbPauseHours: server.cbPauseHours ?? d.cbPauseHours,
  };
}

// Map local form keys back to server setting keys
const KEY_MAP = {
  dryRun: 'dryRun',
  logLevel: 'logLevel',
  irrevBase: 'irrevThreshold',
  irrevStack2: 'irrevStack2',
  irrevStack3: 'irrevStack3',
  spreadScalpIrrev: 'spreadScalpIrrev',
  entryWindow5M: 'entryWindow5M',
  entryWindow15M: 'entryWindow15M',
  spreadScalpLastSeconds: 'spreadScalpLastSeconds',
  maxTradeSize: 'maxTradeSize',
  maxLossPerTrade: 'maxLossPerTrade',
  minShares: 'minShares',
  minPoolBalance: 'minPoolBalance',
  tier1: 'tier1',
  tier2: 'tier2',
  tier3: 'tier3',
  tier4: 'tier4',
  lanesEnabled: 'laneEnabled',
  cbMaxLosses: 'cbMaxLosses',
  cbWindowHours: 'cbWindowHours',
  cbPauseHours: 'cbPauseHours',
};

export default function SettingsSidebar({ isOpen, onClose, settings, onSave }) {
  const [form, setForm] = useState(buildDefaults);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef(null);

  // Sync form when settings change from server
  useEffect(() => {
    setForm(mapServerSettings(settings));
  }, [settings]);

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setLane(lane, value) {
    setForm((prev) => ({
      ...prev,
      lanesEnabled: { ...prev.lanesEnabled, [lane]: value },
    }));
  }

  function handleSave() {
    // Compute changed settings
    const baseline = mapServerSettings(settings);
    const changed = {};
    for (const [localKey, serverKey] of Object.entries(KEY_MAP)) {
      const cur = form[localKey];
      const orig = baseline[localKey];
      if (typeof cur === 'object' && cur !== null) {
        if (JSON.stringify(cur) !== JSON.stringify(orig)) {
          changed[serverKey] = cur;
        }
      } else if (cur !== orig) {
        changed[serverKey] = cur;
      }
    }
    if (Object.keys(changed).length > 0) {
      onSave(changed);
    }
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 2000);
  }

  return (
    <>
      {/* Overlay */}
      {isOpen && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 998,
            transition: 'opacity 0.2s',
          }}
        />
      )}

      {/* Sidebar */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: 380,
          height: '100%',
          background: '#0A0A0A',
          borderLeft: '1px solid #1A1A1A',
          zIndex: 999,
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.2s ease',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #1A1A1A',
          }}
        >
          <span style={{ color: '#fff', fontSize: 16, fontWeight: 700 }}>Settings</span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              display: 'flex',
            }}
          >
            <X size={18} color="#888" />
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0 20px 20px',
          }}
        >
          {/* General */}
          <SectionHeader>General</SectionHeader>
          <Row label="Dry Run">
            <Toggle value={form.dryRun} onChange={(v) => set('dryRun', v)} />
          </Row>
          <Row label="Log Level">
            <select
              value={form.logLevel}
              onChange={(e) => set('logLevel', e.target.value)}
              style={{
                background: '#141414',
                border: '1px solid #1A1A1A',
                borderRadius: 4,
                color: '#fff',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                padding: '4px 8px',
                outline: 'none',
              }}
              onFocus={(e) => { e.target.style.boxShadow = '0 0 0 1px #00D341'; }}
              onBlur={(e) => { e.target.style.boxShadow = 'none'; }}
            >
              {LOG_LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </Row>

          {/* Irrev Thresholds */}
          <SectionHeader>Irrev Thresholds</SectionHeader>
          <Row label="Base (Stack 1)">
            <NumberInput value={form.irrevBase} onChange={(v) => set('irrevBase', v)} />
          </Row>
          <Row label="Stack 2">
            <NumberInput value={form.irrevStack2} onChange={(v) => set('irrevStack2', v)} />
          </Row>
          <Row label="Stack 3">
            <NumberInput value={form.irrevStack3} onChange={(v) => set('irrevStack3', v)} />
          </Row>
          <Row label="Spread Scalp">
            <NumberInput value={form.spreadScalpIrrev} onChange={(v) => set('spreadScalpIrrev', v)} />
          </Row>

          {/* Entry Windows */}
          <SectionHeader>Entry Windows</SectionHeader>
          <Row label="5M Window (s)">
            <NumberInput value={form.entryWindow5M} onChange={(v) => set('entryWindow5M', v)} />
          </Row>
          <Row label="15M Window (s)">
            <NumberInput value={form.entryWindow15M} onChange={(v) => set('entryWindow15M', v)} />
          </Row>
          <Row label="Spread Last (s)">
            <NumberInput value={form.spreadScalpLastSeconds} onChange={(v) => set('spreadScalpLastSeconds', v)} />
          </Row>

          {/* Allocation */}
          <SectionHeader>Allocation</SectionHeader>
          <Row label="Max Trade ($)">
            <NumberInput value={form.maxTradeSize} onChange={(v) => set('maxTradeSize', v)} />
          </Row>
          <Row label="Max Loss ($)">
            <NumberInput value={form.maxLossPerTrade} onChange={(v) => set('maxLossPerTrade', v)} />
          </Row>
          <Row label="Min Shares">
            <NumberInput value={form.minShares} onChange={(v) => set('minShares', v)} />
          </Row>
          <Row label="Min Pool ($)">
            <NumberInput value={form.minPoolBalance} onChange={(v) => set('minPoolBalance', v)} />
          </Row>

          {/* Compounding Tiers */}
          <SectionHeader>Compounding Tiers</SectionHeader>
          {[
            { key: 'tier1', label: TIER_LABELS[0] },
            { key: 'tier2', label: TIER_LABELS[1] },
            { key: 'tier3', label: TIER_LABELS[2] },
            { key: 'tier4', label: TIER_LABELS[3] },
          ].map(({ key, label }) => (
            <Row key={key} label={label}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <NumberInput value={form[key]} onChange={(v) => set(key, v)} width={50} />
                <span style={{ color: '#888', fontSize: 12 }}>%</span>
              </div>
            </Row>
          ))}

          {/* Lanes */}
          <SectionHeader>Lanes</SectionHeader>
          {LANES.map((lane) => (
            <Row key={lane} label={lane}>
              <Toggle
                value={form.lanesEnabled[lane] ?? true}
                onChange={(v) => setLane(lane, v)}
              />
            </Row>
          ))}

          {/* Circuit Breaker */}
          <SectionHeader>Spread Scalp Circuit Breaker</SectionHeader>
          <Row label="Max Losses">
            <NumberInput value={form.cbMaxLosses} onChange={(v) => set('cbMaxLosses', v)} />
          </Row>
          <Row label="Window (hrs)">
            <NumberInput value={form.cbWindowHours} onChange={(v) => set('cbWindowHours', v)} />
          </Row>
          <Row label="Pause (hrs)">
            <NumberInput value={form.cbPauseHours} onChange={(v) => set('cbPauseHours', v)} />
          </Row>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 20px', borderTop: '1px solid #1A1A1A' }}>
          <button
            onClick={handleSave}
            style={{
              width: '100%',
              background: '#00D341',
              color: '#000',
              fontFamily: 'JetBrains Mono, monospace',
              fontWeight: 700,
              fontSize: 14,
              padding: '10px 0',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Save Changes
          </button>
          {saved && (
            <div
              style={{
                textAlign: 'center',
                color: '#00D341',
                fontSize: 12,
                marginTop: 8,
                animation: 'fadeOut 2s forwards',
              }}
            >
              Saved!
            </div>
          )}
        </div>
      </div>

      {/* Fade-out keyframes */}
      <style>{`
        @keyframes fadeOut {
          0%, 70% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </>
  );
}
