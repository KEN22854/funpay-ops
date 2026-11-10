import { motion } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';
import { copyText } from '../lib/storage';
import { parseNum } from '../lib/format';

export function Page({ title, subtitle, children, actions }: { title: string; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>}
        </div>
        {actions}
      </header>
      {children}
    </motion.div>
  );
}

export function Card({ title, children, className = '', right }: { title?: ReactNode; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={`card p-4 sm:p-5 ${className}`}>
      {(title || right) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  suffix,
  hint,
  min = 0,
  step = 'any',
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  hint?: ReactNode;
  min?: number;
  step?: string;
}) {
  // Держим строку локально, чтобы можно было вводить «12,» и пустое поле
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => {
    if (parseNum(text) !== value) setText(value ? String(value) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="relative">
        <input
          className="input num pr-10"
          inputMode="decimal"
          value={text}
          placeholder="0"
          min={min}
          step={step}
          onChange={(e) => {
            const t = e.target.value.replace(/[^\d.,\s-]/g, '');
            setText(t);
            onChange(Math.max(min, parseNum(t)));
          }}
        />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">{suffix}</span>}
      </div>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Badge({ tone, children }: { tone: 'bad' | 'warn' | 'good' | 'accent' | 'muted'; children: ReactNode }) {
  const map = {
    bad: 'bg-bad/15 text-bad border-bad/30',
    warn: 'bg-warn/15 text-warn border-warn/30',
    good: 'bg-good/15 text-good border-good/30',
    accent: 'bg-accent/15 text-accent border-accent/30',
    muted: 'bg-raised text-muted border-line',
  } as const;
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${map[tone]}`}>{children}</span>;
}

export function CopyButton({ text, label = 'Скопировать', className = 'btn-ghost', disabled }: { text: string; label?: string; className?: string; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <motion.button
      type="button"
      whileHover={{ scale: disabled ? 1 : 1.02 }}
      whileTap={{ scale: 0.98 }}
      className={className}
      disabled={disabled}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? 'ok' : 'fail');
        setTimeout(() => setState('idle'), 1500);
      }}
    >
      {state === 'ok' ? 'Скопировано ✓' : state === 'fail' ? 'Не удалось' : label}
    </motion.button>
  );
}

export function Warning({ children, tone = 'warn' }: { children: ReactNode; tone?: 'warn' | 'bad' }) {
  const cls = tone === 'bad' ? 'border-bad/40 bg-bad/10' : 'border-warn/40 bg-warn/10';
  return (
    <div className={`flex gap-3 rounded-xl border p-4 text-sm ${cls}`}>
      <span className={tone === 'bad' ? 'text-bad' : 'text-warn'} aria-hidden>
        ⚠
      </span>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

export function Stat({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad'; sub?: ReactNode }) {
  const color = tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-fg';
  return (
    <div className="rounded-lg border border-line bg-raised/50 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`num mt-1 text-lg font-semibold ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">{children}</div>;
}
