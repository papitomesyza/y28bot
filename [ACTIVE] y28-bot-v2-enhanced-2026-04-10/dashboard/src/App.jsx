import { useState, useEffect, useRef } from 'react';
import { login, fetchStatus, fetchLogs, fetchSettings, updateSetting } from './utils/api.js';
import Header from './components/Header.jsx';
import ErrorModal from './components/ErrorModal.jsx';
import LogsPanel from './components/LogsPanel.jsx';
import StatsRow from './components/StatsRow.jsx';
import LanesGrid from './components/LanesGrid.jsx';
import TradesTable from './components/TradesTable.jsx';
import CandlesGrid from './components/CandlesGrid.jsx';
import SettingsSidebar from './components/SettingsSidebar.jsx';


function LoginPage({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(password);
      onLogin();
    } catch (err) {
      setError('Invalid password');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="bg-card border border-border rounded p-8 w-full max-w-sm">
        <h1 className="text-textPrimary text-lg font-mono mb-1 text-center">
          y28 Polymarket Bot
        </h1>
        <p className="text-textSecondary text-xs text-center mb-6">SuperScalp Engine</p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-textPrimary font-mono placeholder-textSecondary focus:outline-none focus:border-green mb-4"
            autoFocus
          />
          {error && <p className="text-red text-xs mb-3">{error}</p>}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full bg-green text-bg font-mono text-sm py-2 rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}

function Dashboard() {
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const statusInterval = useRef(null);
  const logsInterval = useRef(null);

  useEffect(() => {
    fetchStatus().then(setStatus).catch(() => {});
    fetchLogs().then(setLogs).catch(() => {});
    fetchSettings().then(setSettings).catch(() => {});

    statusInterval.current = setInterval(() => {
      fetchStatus().then(setStatus).catch(() => {});
    }, 5000);

    logsInterval.current = setInterval(() => {
      fetchLogs().then(setLogs).catch(() => {});
    }, 3000);

    return () => {
      clearInterval(statusInterval.current);
      clearInterval(logsInterval.current);
    };
  }, []);

  const errors = logs.filter((l) => l.level === 'error');
  const [errorModalOpen, setErrorModalOpen] = useState(false);

  async function handleSaveSettings(changed) {
    const promises = Object.entries(changed).map(([key, value]) =>
      updateSetting(key, value)
    );
    await Promise.all(promises);
    fetchSettings().then(setSettings).catch(() => {});
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      <div className="w-full max-w-[1440px] mx-auto px-3 sm:px-6 py-4 sm:py-6 flex-1 flex flex-col gap-3 sm:gap-4">
        <Header
          status={status}
          errorCount={errors.length}
          onErrorOpen={() => setErrorModalOpen(true)}
          onSettingsOpen={() => setSettingsOpen(true)}
        />
        <StatsRow status={status} />
        <CandlesGrid />
        <LanesGrid status={status} />
        <TradesTable />
        <LogsPanel logs={logs} />
      </div>
      <SettingsSidebar
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
      />
      <ErrorModal errors={errors} isOpen={errorModalOpen} onClose={() => setErrorModalOpen(false)} />
      <footer className="text-center text-textSecondary text-xs py-4">
        a year28 development
      </footer>
    </div>
  );
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(() => !!localStorage.getItem('token'));

  if (!loggedIn) {
    return <LoginPage onLogin={() => setLoggedIn(true)} />;
  }

  return <Dashboard />;
}
