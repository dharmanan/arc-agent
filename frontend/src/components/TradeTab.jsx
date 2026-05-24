import React from 'react';
import { ExternalLink, LineChart } from 'lucide-react';
import { Card, SectionHeader } from './ui/index.jsx';

const TRADINGVIEW_SCRIPT_URL = 'https://tr.tradingview.com/script/PpnOsZya/?utm_source=notification_email&utm_medium=email&utm_campaign=notification_vote';
const TRADINGVIEW_PREVIEW_IMAGE_URL = 'https://s3.tradingview.com/p/PpnOsZya_big.png?v=1766867978';
const TRADINGVIEW_SCRIPT_TITLE = 'Kohen Dive V4.6';

export default function TradeTab() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <SectionHeader
        title="Trade"
        subtitle="This page shows the strategy that will later drive autonomous trading inside Arc."
      />

      <Card className="border-yellow-200 bg-yellow-50">
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-yellow-700 shadow-sm">
              <LineChart size={20} />
            </div>
            <span className="inline-flex items-center rounded-full border border-yellow-300 bg-white px-3 py-1 text-sm font-bold uppercase tracking-[0.14em] text-yellow-700">
              Soon
            </span>
            <span className="inline-flex items-center rounded-full border border-yellow-300 bg-yellow-100 px-3 py-1 text-sm font-semibold text-yellow-800">
              Not live on Arc yet
            </span>
          </div>

          <div className="space-y-3 md:max-w-4xl">
            <h3 className="text-2xl font-bold text-slate-900">{TRADINGVIEW_SCRIPT_TITLE}</h3>
            <p className="text-sm text-slate-700">
              This page starts with a TradingView script published by the Arc Machina builder. It is the main strategy reference for the autonomous trade lane that is being prepared here.
            </p>
            <p className="text-sm text-slate-700">
              The goal is not slow position holding. The plan is to let an autonomous agent focus on short, lower-timeframe trades, keep a running record of signals, entries, exits, and results, and use LLM-assisted review to become sharper over time.
            </p>
            <p className="text-sm text-slate-700">
              ETH is planned as the first live market. Before live Arc execution opens, Sepolia trials are expected so the flow can be tested in a safer environment and tightened before launch.
            </p>
            <p className="text-sm text-slate-700">
              You can open the TradingView page to read the full strategy notes, review the separate strategy tester, and add the script to your own chart if you want to explore it yourself.
            </p>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">TradingView snapshot</p>
            <p className="mt-1 text-sm text-slate-600">
              Open the TradingView page for the full explanation, the separate strategy tester, and the option to add the script to your own chart.
            </p>
          </div>

          <a
            href={TRADINGVIEW_SCRIPT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-[#66D121]/40 hover:text-arc-green"
          >
            Open on TradingView <ExternalLink size={13} />
          </a>
        </div>

        <div className="bg-slate-100 p-4 sm:p-5">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-yellow-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-green-300" />
              <span className="ml-2 truncate text-xs text-slate-500">tr.tradingview.com/script/PpnOsZya/</span>
            </div>
            <img
              src={TRADINGVIEW_PREVIEW_IMAGE_URL}
              alt={`${TRADINGVIEW_SCRIPT_TITLE} TradingView page preview`}
              className="w-full bg-white object-cover"
              loading="lazy"
            />
          </div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Autonomous lane</p>
          <p className="mt-2 text-sm font-semibold text-slate-900">A trade agent that learns from its own history</p>
          <p className="mt-2 text-sm text-slate-600">
            The goal is an autonomous trade structure that keeps a clear memory of what it saw, what it did, and what happened next. That growing history can then be reviewed with LLM support so the agent becomes more disciplined over time.
          </p>
        </Card>

        <Card>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Launch path</p>
          <p className="mt-2 text-sm font-semibold text-slate-900">ETH first, Sepolia before wider rollout</p>
          <p className="mt-2 text-sm text-slate-600">
            The first live focus is ETH. Before broader rollout on Arc, Sepolia runs are planned so execution can be watched closely and the agent can be tuned with less risk.
          </p>
        </Card>

        <Card>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">What you can do now</p>
          <p className="mt-2 text-sm font-semibold text-slate-900">Read it, test it, and try it on your own chart</p>
          <p className="mt-2 text-sm text-slate-600">
            The TradingView page already gives you the long-form explanation, the script page, and access to the strategy tester. If you want, you can also add the script to your own chart and explore it directly there.
          </p>
        </Card>
      </div>
    </div>
  );
}