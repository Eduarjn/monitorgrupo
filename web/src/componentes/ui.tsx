/** Blocos visuais reutilizados nas telas. Estilo do Design System ERA (dark). */
import type { ReactNode } from 'react';

export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={`rounded-xl border border-border bg-background p-5 ${className}`}>{children}</div>
);

export const Titulo = ({ children, sub }: { children: ReactNode; sub?: string }) => (
  <div className="mb-4">
    <h2 className="font-display text-xl font-bold uppercase tracking-wide text-foreground">
      {children}
    </h2>
    {sub && <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>}
  </div>
);

export const Botao = ({ children, className = '', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    {...p}
    className={`rounded-lg bg-primary px-4 py-2 font-display text-sm font-bold uppercase
                tracking-wider text-primary-foreground transition hover:brightness-110
                disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
  >{children}</button>
);

export const Campo = ({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
  <label className="block">
    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">
      {label}
    </span>
    <input {...p} className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 text-sm
                             text-foreground outline-none placeholder:text-muted-foreground
                             focus:border-primary/60 focus:ring-2 focus:ring-primary/25" />
  </label>
);

export const Aviso = ({ tipo = 'info', children }: { tipo?: 'info' | 'erro' | 'ok'; children: ReactNode }) => {
  const cor = tipo === 'erro' ? 'border-destructive/50 bg-destructive/10 text-[#ffb0b0]'
            : tipo === 'ok'   ? 'border-primary/40 bg-primary/10 text-foreground'
                              : 'border-border bg-background text-foreground/80';
  return <div className={`rounded-lg border px-4 py-3 text-sm ${cor}`}>{children}</div>;
};

export const Kpi = ({ rotulo, valor, nota }: { rotulo: string; valor: string | number; nota?: string }) => (
  <Card className="border-l-2 border-l-primary/70">
    <div className="font-display text-[11px] font-bold uppercase tracking-[3px] text-aqua">
      {rotulo}
    </div>
    <div className="mt-1 font-display text-4xl font-extrabold text-foreground">{valor}</div>
    {nota && <div className="mt-1 text-xs text-muted-foreground">{nota}</div>}
  </Card>
);

export const Carregando = ({ texto = 'carregando…' }: { texto?: string }) => (
  <div className="flex items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
    {texto}
  </div>
);
