import React, { useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useSwitchChain } from 'wagmi';
import { arcTestnet, SUPPORTED_CHAINS } from './lib/web3.js';
import { AgentProvider, useAgent } from './providers/AgentProvider.jsx';
import DashboardTab from './components/DashboardTab.jsx';
import AgentTab from './components/AgentTab.jsx';
import BridgeTab from './components/BridgeTab.jsx';
import SwapTab from './components/SwapTab.jsx';
import JobsTab from './components/JobsTab.jsx';
import TasksTab from './components/TasksTab.jsx';
import DeFiTab from './components/DeFiTab.jsx';
import OracleTab from './components/OracleTab.jsx';
import LandingPage from './components/LandingPage.jsx';
import { LayoutDashboard, ArrowLeftRight, Repeat2, Bot, Briefcase, Zap, ChevronDown, Brain, Droplets } from 'lucide-react';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { id: 'bridge',    label: 'Bridge',    Icon: ArrowLeftRight  },
  { id: 'swap',      label: 'Swap',      Icon: Repeat2         },
  { id: 'agent',     label: 'Agent',     Icon: Bot             },
  { id: 'jobs',      label: 'Jobs',      Icon: Briefcase       },
  { id: 'tasks',     label: 'Tasks',     Icon: Zap             },
  { id: 'defi',      label: 'DeFi',      Icon: Droplets        },
  { id: 'oracle',    label: 'Oracle',    Icon: Brain           },
];

function NetworkSwitcher() {
  const { chain } = useAccount();
  const { switchChain } = useSwitchChain();
  const [open, setOpen] = useState(false);

  const current = SUPPORTED_CHAINS.find(c => c.id === chain?.id);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-[#66D121]/40 hover:bg-arc-greenBg hover:text-arc-green"
      >
        <span className="h-2 w-2 rounded-full bg-arc-green" />
        {current?.name ?? chain?.name ?? 'Switch Network'}
        <ChevronDown size={14} />
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
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6 lg:px-8">
        {/* Logo */}
        <button
          type="button"
          onClick={onOpenLanding}
          className="mr-2 flex items-center gap-2.5 rounded-xl px-1 py-1 transition hover:bg-slate-100"
        >
          <img
            src="/arc-logo-icon.png"
            alt=""
            className="h-11 w-auto object-contain"
          />
          <span className="font-extrabold tracking-tight text-slate-900">Arc Machina</span>
        </button>

        {/* Tab navigation */}
        <nav className="hidden md:flex items-center gap-1 flex-1">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                activeTab === id
                  ? 'border border-[#66D121]/40 bg-arc-greenBg text-arc-green shadow-sm'
                  : 'border border-transparent text-slate-600 hover:text-arc-green hover:bg-arc-greenBg/60'
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        {/* Right: network switcher + connect */}
        <div className="ml-auto flex items-center gap-2">
          {isConnected && <NetworkSwitcher />}
          <ConnectButton
            accountStatus="avatar"
            chainStatus="none"
            showBalance={false}
          />
        </div>
      </div>

      {/* Mobile tabs */}
      <div className="flex md:hidden overflow-x-auto gap-1 px-4 pb-2">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === id
                ? 'border border-[#66D121]/40 bg-arc-greenBg text-arc-green'
                : 'border border-transparent text-slate-600'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
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
    <div className="min-h-screen">
      <Header activeTab={tab} setTab={setTab} onOpenLanding={() => setShowLanding(true)} />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        {tab === 'dashboard' && <DashboardTab onNavigate={navigate} />}
        {tab === 'bridge' && <BridgeTab onBack={back} />}
        {tab === 'swap' && <SwapTab onBack={back} />}
        {tab === 'agent' && <AgentTab />}
        {tab === 'jobs' && <JobsTab />}
        {tab === 'tasks' && <TasksTab />}
        {tab === 'defi' && <DeFiTab />}
        {tab === 'oracle' && <OracleTab />}
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
