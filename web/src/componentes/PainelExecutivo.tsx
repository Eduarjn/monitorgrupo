/**
 * Painel executivo — os mesmos números do relatório .md, dentro do Dashboard.
 *
 * O relatório existia só como arquivo para baixar, e arquivo baixado é arquivo
 * esquecido. Aqui o gestor vê a composição, a participação e os alertas sem
 * gerar nada e sem gastar token: é o dossiê cru, SQL puro, o mesmo que alimenta
 * o Markdown. Se esta tela e o arquivo divergissem, o cliente perderia a
 * confiança nos dois — por isso partilham a mesma origem.
 */

import {
  Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip,
} from 'recharts';
import type { Dossie } from '../lib/api.ts';
import { Card, Titulo } from './ui.tsx';

/** Fulor em primeiro: a fatia dominante é a que o olho deve achar primeiro. */
const PALETA = ['#CEFF00', '#97B9BC', '#6E8A8D', '#4A5C5E', '#B8CC5C', '#3C4A4C'];

const TOOLTIP = {
  contentStyle: {
    background: '#1e262c', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, color: '#EDEDED', fontSize: 12,
  },
  itemStyle: { color: '#EDEDED' },
} as const;

const NOME_ORIGEM: Record<string, string> = { captura: 'Tempo real', upload: 'Histórico' };
const br = (n: number) => n.toLocaleString('pt-BR');

/** Severidade vem como número do banco; o gestor lê cor, não escala. */
function corSeveridade(s: number) {
  if (s >= 4) return 'bg-red-500/15 text-red-300 border-red-500/30';
  if (s >= 3) return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  return 'bg-white/5 text-muted-foreground border-border';
}

function Rosca({ titulo, sub, dados }: {
  titulo: string; sub: string; dados: Array<{ nome: string; valor: number }>;
}) {
  const uteis = dados.filter((d) => d.valor > 0);
  // Uma fatia só é 100% — o gráfico não acrescenta nada ao número já exibido.
  if (uteis.length < 2) {
    return (
      <Card>
        <Titulo sub={sub}>{titulo}</Titulo>
        <p className="py-8 text-center text-sm text-muted-foreground">
          {uteis.length === 1
            ? <>Tudo em <b className="text-foreground">{uteis[0].nome}</b> — {br(uteis[0].valor)} mensagens.</>
            : 'Sem dados no período.'}
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <Titulo sub={sub}>{titulo}</Titulo>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie data={uteis} dataKey="valor" nameKey="nome" innerRadius={45} outerRadius={80}
               paddingAngle={2} stroke="none">
            {uteis.map((_, i) => <Cell key={i} fill={PALETA[i % PALETA.length]} />)}
          </Pie>
          <Tooltip {...TOOLTIP} formatter={(v: number) => [br(v), 'mensagens']} />
          <Legend verticalAlign="bottom" height={28}
                  formatter={(v) => <span className="text-xs text-muted-foreground">{v}</span>} />
        </PieChart>
      </ResponsiveContainer>
    </Card>
  );
}

export default function PainelExecutivo({ dossie }: { dossie: Dossie }) {
  const d = dossie;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Rosca
          titulo="Composição por tipo"
          sub="Texto, imagem, áudio — o que circula no grupo."
          dados={d.por_tipo.map((t) => ({ nome: t.tipo, valor: t.total }))}
        />
        <Rosca
          titulo="Origem dos dados"
          sub="Capturado em tempo real ou importado de export."
          dados={d.por_origem.map((o) => ({ nome: NOME_ORIGEM[o.origem] ?? o.origem, valor: o.total }))}
        />
      </div>

      <Card>
        <Titulo sub={`Participação de cada pessoa no total de ${br(d.totais.mensagens)} mensagens do período.`}>
          Desempenho por participante
        </Titulo>
        {d.por_participante.length === 0
          ? <p className="py-6 text-center text-sm text-muted-foreground">Sem participantes no período.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider
                                 text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">Participante</th>
                    <th className="py-2 pr-3 text-right font-medium">Mensagens</th>
                    <th className="py-2 font-medium">Participação</th>
                  </tr>
                </thead>
                <tbody>
                  {d.por_participante.map((x, i) => (
                    <tr key={x.nome + i} className="border-b border-border/40 last:border-0">
                      <td className="py-2 pr-3 tabular-nums text-muted-foreground">{i + 1}</td>
                      <td className="py-2 pr-3">{x.nome}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{br(x.mensagens)}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          {/* Barra proporcional: comparar dois números é mais rápido
                              olhando comprimento do que lendo dois percentuais. */}
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                            <div className="h-full rounded-full bg-primary"
                                 style={{ width: `${Math.min(100, x.participacao_pct)}%` }} />
                          </div>
                          <span className="w-12 shrink-0 text-right tabular-nums text-xs
                                           text-muted-foreground">
                            {x.participacao_pct}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>

      {d.temas_ia.length > 0 && (
        <Card>
          <Titulo sub="Assuntos que a análise de janela quente marcou como relevantes.">
            O que a IA vem observando
          </Titulo>
          <ul className="space-y-3">
            {d.temas_ia.map((t, i) => (
              <li key={i} className="flex gap-3 border-b border-border/40 pb-3 last:border-0 last:pb-0">
                <span className="mt-0.5 shrink-0 rounded border border-border bg-white/5 px-2 py-0.5
                                 text-xs tabular-nums text-muted-foreground">
                  {t.temperatura}
                </span>
                <div className="min-w-0">
                  <p className="text-sm">{t.resumo}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">sentimento: {t.sentimento}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d.alertas.length > 0 && (
        <Card>
          <Titulo sub="Registrados pela plataforma no período — os mesmos que constam no relatório.">
            Alertas
          </Titulo>
          <ul className="space-y-2">
            {d.alertas.map((a, i) => (
              <li key={i}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2
                              text-sm ${corSeveridade(a.severidade)}`}>
                <span className="font-medium">{a.titulo}</span>
                <span className="text-xs opacity-70">{a.tipo}</span>
                <span className="ml-auto text-xs tabular-nums opacity-70">
                  {a.criado_em.slice(0, 16).replace('T', ' ')}
                </span>
                <span className="rounded bg-black/20 px-1.5 py-0.5 text-xs">{a.estado}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
