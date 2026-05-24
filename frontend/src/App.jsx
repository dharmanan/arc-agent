import React, { useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useSwitchChain } from 'wagmi';
import { SUPPORTED_CHAINS } from './lib/web3.js';
import { AgentProvider } from './providers/AgentProvider.jsx';
import DashboardTab from './components/DashboardTab.jsx';
import AgentTab from './components/AgentTab.jsx';
import BridgeTab from './components/BridgeTab.jsx';
import SwapTab from './components/SwapTab.jsx';
import JobsTab from './components/JobsTab.jsx';
import TasksTab from './components/TasksTab.jsx';
import DeFiTab from './components/DeFiTab.jsx';
import OracleTab from './components/OracleTab.jsx';
import TradeTab from './components/TradeTab.jsx';
import LandingPage from './components/LandingPage.jsx';
import { ChevronDown } from 'lucide-react';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', compactLabel: 'Dash' },
  { id: 'bridge',    label: 'Bridge' },
  { id: 'swap',      label: 'Swap' },
  { id: 'agent',     label: 'Agent' },
  { id: 'jobs',      label: 'Jobs' },
  { id: 'tasks',     label: 'Tasks' },
  { id: 'oracle',    label: 'Oracle' },
  { id: 'trade',     label: 'Trade' },
  { id: 'defi',      label: 'DeFi' },
];

function NetworkSwitcher() {
  const { chain } = useAccount();
  const { switchChain } = useSwitchChain();
  const [open, setOpen] = useState(false);

  const current = SUPPORTED_CHAINS.find(c => c.id === chain?.id);
  const currentLabel = current?.name ?? chain?.name ?? 'Switch Network';
  const mobileLabel = currentLabel;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex max-w-full items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-[13px] font-medium text-slate-700 transition hover:border-[#66D121]/40 hover:bg-arc-greenBg hover:text-arc-green sm:gap-2 sm:px-3 sm:text-sm"
      >
        <span className="h-2 w-2 rounded-full bg-arc-green" />
        <span className="hidden sm:inline">{currentLabel}</span>
        <span className="sm:hidden">{mobileLabel}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-2 w-44 rounded-xl border border-slate-200 bg-white p-1 shadow-card">
            {SUPPORTED_CHAINS.map(c => (
              <button
                key={c.id}
                onClick={() => { switchChain({ chainId: c.id }); setOpen(false); }}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
                  c.id === chain?.id
                    ? 'bg-arc-greenBg font-semibold text-arc-green'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${c.id === chain?.id ? 'bg-arc-green' : 'bg-slate-300'}`} />
                {c.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Header({ activeTab, setTab, onOpenLanding }) {
  const { isConnected } = useAccount();
  return (
    <header className="sticky top-0 z-30 overflow-x-hidden border-b border-slate-200 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl min-w-0 items-center justify-between gap-2 px-3 py-3 sm:gap-3 sm:px-6 lg:gap-4 lg:px-8">
        {/* Logo */}
        <button
          type="button"
          onClick={onOpenLanding}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-1 transition hover:bg-slate-100 md:flex-none"
        >
          <img
            src="/arc-logo-icon.png"
            alt=""
            className="h-8 w-auto shrink-0 object-contain sm:h-10 xl:h-11"
          />
          <span className="flex min-w-0 flex-col text-left font-extrabold leading-none tracking-tight text-slate-900 md:hidden">
            <span className="text-[0.76rem]">Arc</span>
            <span className="text-[0.76rem]">Machina</span>
          </span>
          <span className="hidden text-left font-extrabold tracking-tight text-slate-900 whitespace-nowrap lg:inline xl:hidden">Arc</span>
          <span className="hidden text-left font-extrabold tracking-tight text-slate-900 whitespace-nowrap xl:inline">Arc Machina</span>
        </button>

        {/* Tab navigation */}
        <nav className="hidden flex-1 items-center gap-1 pl-1 md:flex lg:gap-1.5">
          {TABS.map(({ id, label, compactLabel }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-lg whitespace-nowrap ${id === 'dashboard' ? 'px-2.5' : 'px-3'} py-2 text-sm font-semibold transition ${
                activeTab === id
                  ? 'border border-[#66D121]/40 bg-arc-greenBg text-arc-green shadow-sm'
                  : 'border border-transparent text-slate-600 hover:text-arc-green hover:bg-arc-greenBg/60'
              }`}
            >
              {compactLabel ? (
                <>
                  <span className="xl:hidden">{compactLabel}</span>
                  <span className="hidden xl:inline">{label}</span>
                </>
              ) : label}
            </button>
          ))}
        </nav>

        {/* Right: network switcher + connect */}
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 sm:gap-2">
          {isConnected && <NetworkSwitcher />}
          <ConnectButton
            accountStatus="avatar"
            chainStatus="none"
            showBalance={false}
          />
        </div>
      </div>

      {/* Mobile tabs */}
      <div className="overflow-x-auto px-3 pb-3 md:hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex min-w-max items-center gap-1.5">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition ${
                activeTab === id
                  ? 'border border-[#66D121]/40 bg-arc-greenBg text-arc-green'
                  : 'border border-transparent text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function AppContent() {
  const [tab, setTab] = useState('dashboard');
  const [showLanding, setShowLanding] = useState(true);

  const openApp = (nextTab = 'dashboard') => {
    setTab(nextTab);
    setShowLanding(false);
  };

  const navigate = (nextTab) => openApp(nextTab);
  const back = () => setTab('dashboard');

  if (showLanding) {
    return <LandingPage onEnterApp={openApp} />;
  }

  return (
    <div className="min-h-screen overflow-x-hidden">
      <Header activeTab={tab} setTab={setTab} onOpenLanding={() => setShowLanding(true)} />
      <main className="mx-auto max-w-6xl overflow-x-hidden px-3 py-6 sm:px-6 sm:py-8 lg:px-8">
        {tab === 'dashboard' && <DashboardTab onNavigate={navigate} />}
        {tab === 'bridge' && <BridgeTab onBack={back} />}
        {tab === 'swap' && <SwapTab onBack={back} />}
        {tab === 'agent' && <AgentTab />}
        {tab === 'jobs' && <JobsTab />}
        {tab === 'tasks' && <TasksTab />}
        {tab === 'oracle' && <OracleTab />}
        {tab === 'trade' && <TradeTab />}
        {tab === 'defi' && <DeFiTab />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AgentProvider>
      <AppContent />
    </AgentProvider>
  );
}
