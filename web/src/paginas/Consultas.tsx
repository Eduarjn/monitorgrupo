import { useCallback, useEffect, useState } from 'react';
import {
  Activity, AlertTriangle, BarChart3, CheckSquare, Clock, Database, Gavel,
  Loader2, MessageSquare, Plus, Sparkles, Trash2, Users, X,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, type Consulta, type ResultadoConsulta } from '../lib/api.ts';
import { Aviso, Botao, Card, Carregando, Titulo } from '../componentes/ui.tsx';

/**
 * Consultas salvas — o painel de um clique.
 *
 * A distinção que organiza a tela: card de MÉTRICA responde por SQL (número e
 * gráfico são dado real, instantâneo, sem custo); card de PERGUNTA responde por
 * IA com citação das fontes. O selo em cada card diz de onde vem a resposta,
 * porque confiar num número exige saber quem o produziu.
 */

const FULOR = '#CEFF00';
const GRADE = 'rgba(255,255,255,0.08)';
const EIXO = { fontSize: 11, fill: 'rgba(237,237,237,0.45)' } as const;
const TOOLTIP = {
  contentStyle: {
    background: '#1e262c', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, color: '#EDEDED', fontSize: 12,
  },
  itemStyle: { color: FULOR },
  labelStyle: { color: 'rgba(237,237,237,0.6)' },
  cursor: { fill: 'rgba(206,255,0,0.06)' },
} as const;

const ICONES: Record<string, typeof Sparkles> = {
  users: Users, activity: Activity, clock: Clock, 'check-square': CheckSquare,
  'alert-triangle': AlertTriangle, 'message-square': MessageSquare, gavel: Gavel,
  sparkles: Sparkles,
};

const METRICAS = [
  { v: 'ranking', r: 'Quem mais falou' },
  { v: 'volume_dia', r: 'Volume por dia' },
  { v: 'horario_pico', r: 'Horário de pico' },
  { v: 'mencoes', r: 'Menções a um termo' },
];

const num = (n: number) => n.toLocaleString('pt-BR');

/** Selo da origem do dado. É informação, não enfeite. */
function SeloOrigem({ natureza }: { natureza: string }) {
  if (natureza === 'metrica') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-aqua/40 bg-aqua/10
                       px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-aqua">
        <Database className="h-3 w-3" /> dado direto
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10
                     px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
      <Sparkles className="h-3 w-3" /> {natureza === 'mista' ? 'dado + IA' : 'IA'}
    </span>
  );
}

function Grafico({ v }: { v: NonNullable<ResultadoConsulta['visual']> }) {
  if (!v.series.length) return null;

  if (v.tipo === 'numero') {
    return (
      <div className="flex flex-wrap gap-8">
        {v.series.map((s) => (
          <div key={s.rotulo}>
            <div className="font-display text-4xl font-extrabold text-primary tabular-nums">
              {num(s.valor)}
            </div>
            <div className="text-xs text-muted-foreground">{s.rotulo}</div>
          </div>
        ))}
      </div>
    );
  }

  if (v.tipo === 'tabela') {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {v.series.map((s) => (
              <tr key={s.rotulo} className="border-b border-border last:border-0">
                <td className="py-1.5">{s.rotulo}</td>
                <td className="py-1.5 text-right font-medium tabular-nums">{num(s.valor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const dados = v.series.map((s) => ({ nome: s.rotulo, valor: s.valor }));
  // Ranking com nome de pessoa fica ilegível na horizontal; barra deitada resolve.
  const deitado = v.tipo === 'barra' && dados.some((d) => d.nome.length > 6);

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        {v.tipo === 'linha' ? (
          <LineChart data={dados}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRADE} />
            <XAxis dataKey="nome" tick={EIXO} stroke={GRADE} />
            <YAxis tick={EIXO} stroke={GRADE} allowDecimals={false} />
            <Tooltip {...TOOLTIP} />
            <Line type="monotone" dataKey="valor" stroke={FULOR} strokeWidth={2} dot={false}
                  name={v.unidade} />
          </LineChart>
        ) : deitado ? (
          <BarChart data={dados} layout="vertical" margin={{ left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRADE} />
            <XAxis type="number" tick={EIXO} stroke={GRADE} allowDecimals={false} />
            <YAxis type="category" dataKey="nome" width={130} tick={EIXO} stroke={GRADE} />
            <Tooltip {...TOOLTIP} />
            <Bar dataKey="valor" fill={FULOR} radius={[0, 4, 4, 0]} name={v.unidade} />
          </BarChart>
        ) : (
          <BarChart data={dados}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRADE} />
            <XAxis dataKey="nome" tick={EIXO} stroke={GRADE} />
            <YAxis tick={EIXO} stroke={GRADE} allowDecimals={false} />
            <Tooltip {...TOOLTIP} />
            <Bar dataKey="valor" fill={FULOR} radius={[4, 4, 0, 0]} name={v.unidade} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export default function Consultas({ grupo, grupoNome, podeGerir }: {
  grupo: number; grupoNome?: string; podeGerir: boolean;
}) {
  const [cards, setCards] = useState<Consulta[] | null>(null);
  const [resultado, setResultado] = useState<ResultadoConsulta | null>(null);
  const [rodando, setRodando] = useState<number | null>(null);
  const [erro, setErro] = useState('');
  const [criando, setCriando] = useState(false);

  const carregar = useCallback(() => {
    if (!grupo) { setCards([]); return; }
    api.consultas(grupo).then((r) => setCards(r.consultas))
      .catch((e) => setErro((e as Error).message));
  }, [grupo]);

  useEffect(() => { carregar(); setResultado(null); }, [carregar]);

  const executar = async (c: Consulta) => {
    setErro(''); setRodando(c.id); setResultado(null);
    try { setResultado(await api.executarConsulta(grupo, c.id)); }
    catch (e) { setErro((e as Error).message); }
    finally { setRodando(null); }
  };

  const remover = async (c: Consulta) => {
    setErro('');
    try { await api.removerConsulta(grupo, c.id); carregar(); }
    catch (e) { setErro((e as Error).message); }
  };

  if (!grupo) return <Aviso>Selecione um grupo no topo da página.</Aviso>;
  if (!cards) return <Carregando texto="carregando consultas…" />;

  return (
    <div className="space-y-6">
      {erro && <Aviso tipo="erro">{erro}</Aviso>}

      <Card>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <Titulo sub="Um clique responde. Métrica vem do banco; pergunta vem da IA com as fontes citadas.">
            Consultas de <span className="text-primary">{grupoNome ?? 'este grupo'}</span>
          </Titulo>
          {podeGerir && (
            <button onClick={() => setCriando(true)}
                    className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border
                               px-3 py-2 font-display text-xs font-semibold uppercase tracking-wider
                               text-muted-foreground transition hover:border-primary/50 hover:text-primary">
              <Plus className="h-3.5 w-3.5" /> Novo card
            </button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => {
            const Icone = ICONES[c.icone] ?? Sparkles;
            const ativo = rodando === c.id;
            return (
              <div key={c.id}
                   className={'group relative flex flex-col gap-2 rounded-xl border p-4 text-left transition ' +
                     (resultado?.consulta_id === c.id
                       ? 'border-primary bg-primary/5'
                       : 'border-border bg-white/[0.03] hover:border-primary/50')}>
                <button onClick={() => executar(c)} disabled={ativo}
                        className="flex flex-1 flex-col gap-2 text-left disabled:opacity-60">
                  <div className="flex items-start gap-2">
                    {ativo
                      ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                      : <Icone className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
                    <span className="font-display text-base font-bold uppercase leading-tight tracking-wide">
                      {c.titulo}
                    </span>
                  </div>
                  {c.descricao && (
                    <p className="text-xs leading-relaxed text-muted-foreground">{c.descricao}</p>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                    <SeloOrigem natureza={c.natureza} />
                    {c.dias && (
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {c.dias} dias
                      </span>
                    )}
                    {c.execucoes > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {c.execucoes}× usado
                      </span>
                    )}
                  </div>
                </button>

                {podeGerir && c.grupo_id !== null && (
                  <button onClick={() => remover(c)} title="Remover card"
                          className="absolute right-2 top-2 rounded p-1 text-muted-foreground
                                     opacity-0 transition hover:text-destructive
                                     focus:opacity-100 group-hover:opacity-100">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {resultado && (
        <Card>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <Titulo sub={resultado.visual?.titulo}>{resultado.titulo}</Titulo>
            <SeloOrigem natureza={resultado.natureza} />
          </div>

          {resultado.aviso && <Aviso>{resultado.aviso}</Aviso>}

          {resultado.visual && !resultado.vazio && (
            <div className="space-y-4">
              {resultado.visual.destaque && (
                <div className="flex items-baseline gap-3">
                  <span className="font-display text-5xl font-extrabold text-primary tabular-nums">
                    {num(resultado.visual.destaque.valor)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {resultado.visual.destaque.rotulo}
                  </span>
                </div>
              )}
              <Grafico v={resultado.visual} />
              <p className="text-xs text-muted-foreground">
                {num(resultado.visual.total)} {resultado.visual.unidade} no período ·
                {' '}contagem direta do banco, sem IA
              </p>
            </div>
          )}

          {resultado.texto && (
            <div className={resultado.visual ? 'mt-6 border-t border-border pt-5' : ''}>
              <div className="whitespace-pre-wrap rounded-lg bg-white/5 p-4 text-sm leading-relaxed">
                {resultado.texto}
              </div>
              {resultado.fontes && resultado.fontes.length > 0 && (
                <div className="mt-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[2px] text-aqua">
                    Trechos que embasaram a resposta
                  </div>
                  <div className="space-y-2">
                    {resultado.fontes.map((f) => (
                      <div key={f.bloco_id} className="rounded-lg border border-border p-3 text-xs">
                        <div className="mb-1 flex justify-between text-muted-foreground">
                          <span>{new Date(f.inicio_em).toLocaleString('pt-BR')}</span>
                          <span>similaridade {(f.similaridade * 100).toFixed(0)}%</span>
                        </div>
                        <div className="whitespace-pre-wrap">{f.trecho}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {criando && (
        <NovoCard grupo={grupo} onFechar={() => setCriando(false)}
                  onSalvo={() => { setCriando(false); carregar(); }} />
      )}
    </div>
  );
}

/** Formulário de card novo. O tipo escolhido decide quais campos aparecem. */
function NovoCard({ grupo, onFechar, onSalvo }: {
  grupo: number; onFechar: () => void; onSalvo: () => void;
}) {
  const [titulo, setTitulo] = useState('');
  const [descricao, setDescricao] = useState('');
  const [natureza, setNatureza] = useState<'metrica' | 'pergunta'>('pergunta');
  const [metrica, setMetrica] = useState('ranking');
  const [parametro, setParametro] = useState('');
  const [pergunta, setPergunta] = useState('');
  const [dias, setDias] = useState('30');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const salvar = async () => {
    setErro(''); setSalvando(true);
    try {
      await api.salvarConsulta(grupo, {
        titulo, descricao: descricao || null, natureza,
        metrica: natureza === 'metrica' ? metrica : null,
        parametro: natureza === 'metrica' && metrica === 'mencoes' ? parametro : null,
        pergunta: natureza === 'pergunta' ? pergunta : null,
        dias: dias ? Number(dias) : null,
        icone: natureza === 'metrica' ? 'activity' : 'sparkles',
      });
      onSalvo();
    } catch (e) { setErro((e as Error).message); }
    finally { setSalvando(false); }
  };

  return (
    <Card className="border-primary/40">
      <div className="mb-4 flex items-start justify-between gap-3">
        <Titulo sub="O card fica salvo neste grupo e responde com um clique.">Novo card</Titulo>
        <button onClick={onFechar} className="rounded p-1 text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      {erro && <div className="mb-4"><Aviso tipo="erro">{erro}</Aviso></div>}

      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {([['pergunta', 'Pergunta para a IA'], ['metrica', 'Métrica do banco']] as const).map(([v, r]) => (
            <button key={v} onClick={() => setNatureza(v)}
                    className={'rounded-lg border px-3 py-2 font-display text-xs font-semibold ' +
                      'uppercase tracking-wider transition ' +
                      (natureza === v
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground')}>
              {r}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">
            Título do card
          </span>
          <input value={titulo} onChange={(e) => setTitulo(e.target.value)}
                 placeholder={natureza === 'metrica' ? 'Ex.: Citações do meu nome' : 'Ex.: Riscos da semana'}
                 className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 text-sm
                            outline-none placeholder:text-muted-foreground focus:border-primary/60" />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">
            O que este card responde
          </span>
          <input value={descricao} onChange={(e) => setDescricao(e.target.value)}
                 placeholder="Uma linha, para quem for clicar saber o que esperar"
                 className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 text-sm
                            outline-none placeholder:text-muted-foreground focus:border-primary/60" />
        </label>

        {natureza === 'metrica' ? (
          <div className="flex flex-wrap gap-4">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">
                Métrica
              </span>
              <select value={metrica} onChange={(e) => setMetrica(e.target.value)}
                      className="rounded-lg border border-border bg-white/5 px-3 py-2 text-sm
                                 outline-none focus:border-primary/60">
                {METRICAS.map((m) => <option key={m.v} value={m.v}>{m.r}</option>)}
              </select>
            </label>
            {metrica === 'mencoes' && (
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">
                  Termo a contar
                </span>
                <input value={parametro} onChange={(e) => setParametro(e.target.value)}
                       placeholder="ex.: Eduardo"
                       className="w-44 rounded-lg border border-border bg-white/5 px-3 py-2 text-sm
                                  outline-none focus:border-primary/60" />
              </label>
            )}
          </div>
        ) : (
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">
              Pergunta que a IA vai responder
            </span>
            <textarea value={pergunta} onChange={(e) => setPergunta(e.target.value)} rows={4}
                      placeholder="Seja específico. Ex.: Liste os clientes citados com sinal de insatisfação, dizendo quem relatou e quando."
                      className="w-full rounded-lg border border-border bg-white/5 p-3 text-sm
                                 outline-none placeholder:text-muted-foreground focus:border-primary/60" />
          </label>
        )}

        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[2px] text-muted-foreground">
            Período (dias)
          </span>
          <input value={dias} onChange={(e) => setDias(e.target.value.replace(/\D/g, ''))}
                 placeholder="vazio = todo o histórico"
                 className="w-40 rounded-lg border border-border bg-white/5 px-3 py-2 text-sm
                            outline-none placeholder:text-muted-foreground focus:border-primary/60" />
        </label>

        <Botao onClick={salvar} disabled={salvando || !titulo.trim()}>
          {salvando ? 'Salvando…' : 'Salvar card'}
        </Botao>
      </div>
    </Card>
  );
}
