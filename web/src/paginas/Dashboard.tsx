import { useEffect, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, type Dossie, type Estatisticas } from '../lib/api.ts';
import PainelExecutivo from '../componentes/PainelExecutivo.tsx';
import { Aviso, Card, Carregando, Kpi, Titulo } from '../componentes/ui.tsx';

const FULOR = '#CEFF00';
const GRADE = 'rgba(255,255,255,0.08)';
const EIXO = { fontSize: 11, fill: 'rgba(237,237,237,0.45)' } as const;
const TOOLTIP = {
  contentStyle: {
    background: '#1e262c',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8,
    color: '#EDEDED',
    fontSize: 12,
  },
  itemStyle: { color: FULOR },
  labelStyle: { color: 'rgba(237,237,237,0.6)' },
  cursor: { fill: 'rgba(206,255,0,0.06)' },
} as const;

export default function Dashboard({ grupo }: { grupo: number }) {
  const [dados, setDados] = useState<Estatisticas | null>(null);
  const [erro, setErro] = useState('');
  const [termo, setTermo] = useState('');
  const [mencoes, setMencoes] = useState<{ mensagens: number; ocorrencias: number } | null>(null);
  const [dossie, setDossie] = useState<Dossie | null>(null);
  const [dias, setDias] = useState(30);

  useEffect(() => {
    setDados(null);
    setErro('');
    setMencoes(null);
    api.estatisticas(grupo).then(setDados).catch((e) => setErro((e as Error).message));
  }, [grupo]);

  // O dossie tem periodo proprio e recarrega sozinho: trocar a janela nao deve
  // derrubar os graficos do historico inteiro que ja estao na tela.
  useEffect(() => {
    setDossie(null);
    api.dossie(grupo, dias).then(setDossie).catch(() => setDossie(null));
  }, [grupo, dias]);

  if (erro) return <Aviso tipo="erro">{erro}</Aviso>;
  if (!dados) return <Carregando />;
  if (!dados.total) {
    // Havia so o caminho do upload aqui; a captura em tempo real chegou depois
    // e a mensagem ficou para tras, mandando o usuario para o lugar errado.
    return (
      <Aviso>
        Nenhuma mensagem neste grupo ainda. Há dois caminhos: conectar o WhatsApp na aba{' '}
        <b>Coleta</b> para capturar em tempo real, ou enviar o arquivo de export na aba{' '}
        <b>Upload</b> para trazer o histórico.
      </Aviso>
    );
  }

  const contarMencoes = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!termo.trim()) return;
    try {
      setMencoes(await api.mencoes(grupo, termo));
    } catch (x) {
      setErro((x as Error).message);
    }
  };

  const pico = dados.pico.reduce((a, b) => (b.mensagens > a.mensagens ? b : a), dados.pico[0]);
  const horaPico = String(pico?.hora ?? 0).padStart(2, '0') + 'h';

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi rotulo="Mensagens" valor={dados.total.toLocaleString('pt-BR')}
             nota="sem contar avisos do sistema" />
        <Kpi rotulo="Participantes" valor={dados.autores.length} />
        <Kpi rotulo="Dias com conversa" valor={dados.dias.length} />
        <Kpi rotulo="Horário de pico" valor={horaPico} nota={(pico?.mensagens ?? 0) + ' mensagens'} />
      </div>

      <Card>
        <Titulo sub="Mensagens por dia, no fuso de São Paulo.">Volume ao longo do tempo</Titulo>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={dados.dias}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRADE} />
            <XAxis dataKey="dia" tick={EIXO} stroke={GRADE} />
            <YAxis tick={EIXO} stroke={GRADE} allowDecimals={false} />
            <Tooltip {...TOOLTIP} />
            <Line type="monotone" dataKey="mensagens" stroke={FULOR} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Titulo sub="Quem mais fala no grupo.">Ranking de participantes</Titulo>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={dados.ranking} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRADE} />
              <XAxis type="number" tick={EIXO} stroke={GRADE} allowDecimals={false} />
              <YAxis type="category" dataKey="nome" width={120} tick={EIXO} stroke={GRADE} />
              <Tooltip {...TOOLTIP} />
              <Bar dataKey="mensagens" fill={FULOR} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card>
          <Titulo sub="Distribuição por hora do dia.">Horários de pico</Titulo>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={dados.pico}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRADE} />
              <XAxis dataKey="hora" tick={EIXO} stroke={GRADE} tickFormatter={(h) => h + 'h'} />
              <YAxis tick={EIXO} stroke={GRADE} allowDecimals={false} />
              <Tooltip {...TOOLTIP} labelFormatter={(h) => h + 'h'} />
              <Bar dataKey="mensagens" fill={FULOR} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Bloco executivo: os mesmos agregados do relatorio .md, so que ao vivo.
          Fica depois dos graficos gerais porque responde a outra pergunta —
          nao "quanto se fala", e sim "como e quem". */}
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-border pt-6">
        <div>
          <h2 className="font-display text-lg font-bold uppercase tracking-wide">Visão executiva</h2>
          <p className="text-sm text-muted-foreground">
            Os mesmos números do relatório executivo — apurados em SQL, sem IA.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border bg-white/5 p-1">
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              onClick={() => setDias(n)}
              className={`rounded px-3 py-1 text-xs font-medium transition ${
                dias === n ? 'bg-primary text-primary-foreground'
                           : 'text-muted-foreground hover:text-foreground'}`}
            >
              {n} dias
            </button>
          ))}
        </div>
      </div>

      {dossie
        ? <PainelExecutivo dossie={dossie} />
        : <Carregando texto="apurando o período…" />}

      <Card>
        <Titulo sub="Contagem exata em SQL — não usa IA nem gasta tokens.">
          Quantas vezes citaram…
        </Titulo>
        <form onSubmit={contarMencoes} className="flex gap-2">
          <input
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            placeholder="ex.: Eduardo, proposta, reunião"
            className="flex-1 rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none
                       placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/25"
          />
          <button className="rounded-lg bg-primary px-4 py-2 font-display text-sm font-bold uppercase
                             tracking-wider text-primary-foreground transition hover:brightness-110">
            Contar
          </button>
        </form>
        {mencoes && (
          <div className="mt-4 flex gap-8">
            <div>
              <div className="font-display text-3xl font-extrabold text-primary">{mencoes.mensagens}</div>
              <div className="text-xs text-muted-foreground">mensagens citam o termo</div>
            </div>
            <div>
              <div className="font-display text-3xl font-extrabold text-primary">{mencoes.ocorrencias}</div>
              <div className="text-xs text-muted-foreground">ocorrências no total</div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
