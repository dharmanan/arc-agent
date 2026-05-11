import React from 'react';
import { Loader2 } from 'lucide-react';

export function Card({ children, className = '' }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-6 shadow-card ${className}`}>
      {children}
    </div>
  );
}

export function Button({ children, variant = 'primary', loading = false, className = '', ...props }) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-xl px-6 py-3 font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed text-sm';
  const variants = {
    primary: 'bg-arc-green text-white hover:bg-arc-greenHover',
    outline: 'border border-slate-200 bg-white text-slate-700 hover:border-[#66D121]/40 hover:bg-arc-greenBg hover:text-arc-green',
    danger:  'bg-red-600 text-white hover:bg-red-700',
    ghost:   'text-slate-600 hover:text-arc-green hover:bg-arc-greenBg/60',
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} disabled={loading || props.disabled} {...props}>
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Input({ label, error, className = '', ...props }) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <label className="text-sm font-semibold text-slate-700">{label}</label>}
      <input
        className={`w-full rounded-xl border bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:ring-2 ${error ? 'border-red-400 focus:ring-red-200' : 'border-slate-200 focus:border-[#66D121]/60 focus:ring-[#66D121]/20'} ${className}`}
        {...props}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

export function Select({ label, children, className = '', ...props }) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <label className="text-sm font-semibold text-slate-700">{label}</label>}
      <select
        className={`w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-[#66D121]/60 focus:ring-2 focus:ring-[#66D121]/20 ${className}`}
        {...props}
      >
        {children}
      </select>
    </div>
  );
}

export function Badge({ children, variant = 'green' }) {
  const variants = {
    green:  'border-[#66D121]/40 bg-arc-greenBg text-arc-green',
    slate:  'border-slate-200 bg-slate-100 text-slate-600',
    red:    'border-red-200 bg-red-50 text-red-600',
    yellow: 'border-yellow-200 bg-yellow-50 text-yellow-700',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${variants[variant]}`}>
      {children}
    </span>
  );
}

export function Spinner({ size = 20, className = '' }) {
  return <Loader2 size={size} className={`animate-spin text-arc-green ${className}`} />;
}

export function AddressBox({ address, label }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      {label && <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</label>}
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <span className="flex-1 break-all font-mono text-sm text-slate-700">{address}</span>
        <button
          onClick={copy}
          title="Copy address"
          className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
        >
          {copied ? (
            <svg width="14" height="14" fill="none" stroke="#2F6E0C" strokeWidth="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          )}
        </button>
      </div>
    </div>
  );
}

export function Alert({ type = 'info', children }) {
  const styles = {
    info:    'border-blue-200 bg-blue-50 text-blue-800',
    success: 'border-[#66D121]/40 bg-arc-greenBg text-arc-green',
    warning: 'border-yellow-200 bg-yellow-50 text-yellow-800',
    error:   'border-red-200 bg-red-50 text-red-700',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${styles[type]}`}>
      {children}
    </div>
  );
}

export function SectionHeader({ title, subtitle }) {
  return (
    <div className="mb-6">
      <h2 className="text-xl font-bold text-slate-900">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
    </div>
  );
}
