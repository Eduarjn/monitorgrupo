/**
 * Motor das consultas salvas.
 *
 * A regra que organiza tudo: **número vem do SQL, leitura vem da IA.**
 *
 * Pedir os dados do gráfico ao modelo produziria valores plausíveis e errados —
 * num painel de gestão isso é pior do que não ter gráfico. As estatísticas da
 * Fase 3 já existem em SQL puro e são exatas; a IA entra onde ela é boa, que é
 * interpretar texto e citar a origem.
 */

import type { DB, Periodo } from '../stats/queries.ts';
import { getHorariosDePico, getMencoesTermo, getRankingParticipantes,
         getVolumePorAutor, getVolumePorDia } from '../stats/queries.ts';
import type { AIProvider } from '../ai/provider.ts';
import { perguntar } from '../ai/search.ts';
import { gerarRelatorio } from './relatorio.ts';

export type Metrica = 'volume_autor' | 'volume_dia' | 'horario_pico' | 'ranking' | 'mencoes';
export type Visual = 'auto' | 'numero' | 'barra' | 'linha' | 'pizza' | 'tabela' | 'texto';

export interface Consulta {
  id: number;
  titulo: string;
  descricao: string | null;
  natureza: 'metrica' | 'pergunta' | 'mista' | 'relatorio';
  metrica: Metrica | null;
  parametro: string | null;
  pergunta: string | null;
  visual: Visual;
  dias: number | null;
}

export interface Serie { rotulo: string; valor: number }

export interface VisualResultado {
  tipo: Exclude<Visual, 'auto'>;
  titulo: string;
  unidade: string;
  series: Serie[];
  total: number;
  /** Número em destaque: o que o gestor lê antes de olhar o gráfico. */
  destaque?: { valor: number; rotulo: string };
}

export interface ResultadoConsulta {
  consulta_id: number;
  titulo: string;
  natureza: string;
  /** Relatorio completo em Markdown, com graficos Mermaid. */
  markdown?: string;
  /** Valores do relatorio que NAO constam no dossie apurado. */
  numeros_suspeitos?: string[];
  /** Gráfico — só existe quando veio de SQL. Nunca gerado por modelo. */
  visual?: VisualResultado;
  texto?: string;
  fontes?: Array<{ bloco_id: number; inicio_em: string; trecho: string; similaridade: number }>;
  vazio?: boolean;
  aviso?: string;
}

/** Período meio-aberto a partir de "N dias atrás". Sem dias = histórico inteiro. */
function periodoDe(dias: number | null): Periodo {
  if (!dias) return {};
  const fim = new Date();
  return { inicio: new Date(fim.getTime() - dias * 86_400_000).toISOString(), fim: fim.toISOString() };
}

const plural = (n: number, um: string, muitos: string) => (n === 1 ? um : muitos);
const somar = (s: Serie[]) => s.reduce((a, x) => a + x.valor, 0);

/**
 * Roda a métrica em SQL e já devolve no formato do gráfico.
 *
 * Cada métrica escolhe o próprio visual padrão porque a forma do dado manda:
 * série temporal é linha, ranking é barra, contagem é número. O usuário pode
 * sobrescrever no card, mas o padrão nunca é arbitrário.
 */
async function rodarMetrica(
  db: DB, grupoId: number, c: Consulta,
): Promise<VisualResultado & { vazio: boolean }> {
  const p = periodoDe(c.dias);
  const escolher = (padrao: Exclude<Visual, 'auto'>) =>
    (c.visual === 'auto' ? padrao : c.visual as Exclude<Visual, 'auto'>);

  if (c.metrica === 'ranking' || c.metrica === 'volume_autor') {
    const linhas = c.metrica === 'ranking'
      ? await getRankingParticipantes(db, grupoId, 10, p)
      : await getVolumePorAutor(db, grupoId, p);
    const series = linhas.map((l) => ({ rotulo: l.nome, valor: l.mensagens }));
    return {
      tipo: escolher('barra'), titulo: 'Mensagens por participante', unidade: 'mensagens',
      series, total: somar(series), vazio: series.length === 0,
      destaque: series[0] ? { valor: series[0].valor, rotulo: `de ${series[0].rotulo}` } : undefined,
    };
  }

  if (c.metrica === 'volume_dia') {
    const linhas = await getVolumePorDia(db, grupoId, p);
    const series = linhas.map((l) => ({ rotulo: l.dia, valor: l.mensagens }));
    const total = somar(series);
    const media = series.length ? Math.round(total / series.length) : 0;
    return {
      tipo: escolher('linha'), titulo: 'Mensagens por dia', unidade: 'mensagens',
      series, total, vazio: series.length === 0,
      destaque: { valor: media, rotulo: plural(media, 'mensagem por dia, em média',
                                                     'mensagens por dia, em média') },
    };
  }

  if (c.metrica === 'horario_pico') {
    const linhas = await getHorariosDePico(db, grupoId, p);
    const series = linhas.map((l) => ({
      rotulo: `${String(l.hora).padStart(2, '0')}h`, valor: l.mensagens,
    }));
    const pico = series.reduce<Serie | null>((a, b) => (!a || b.valor > a.valor ? b : a), null);
    return {
      tipo: escolher('barra'), titulo: 'Mensagens por hora do dia', unidade: 'mensagens',
      series, total: somar(series), vazio: series.length === 0,
      destaque: pico ? { valor: pico.valor, rotulo: `no pico, às ${pico.rotulo}` } : undefined,
    };
  }

  if (c.metrica === 'mencoes') {
    const termo = (c.parametro ?? '').trim();
    if (!termo) {
      return { tipo: 'numero', titulo: 'Menções', unidade: '', series: [], total: 0, vazio: true };
    }
    const r = await getMencoesTermo(db, grupoId, termo, p);
    return {
      tipo: escolher('numero'), titulo: `Menções a "${termo}"`, unidade: 'menções',
      // Os dois números existem de propósito e podem divergir: a contagem de
      // mensagens usa busca com stemming, a de ocorrências é literal.
      series: [
        { rotulo: 'mensagens que citam', valor: r.mensagens },
        { rotulo: 'ocorrências no total', valor: r.ocorrencias },
      ],
      total: r.ocorrencias, vazio: r.ocorrencias === 0,
      destaque: { valor: r.mensagens, rotulo: plural(r.mensagens, 'mensagem cita o termo',
                                                                  'mensagens citam o termo') },
    };
  }

  return { tipo: 'texto', titulo: '', unidade: '', series: [], total: 0, vazio: true };
}

export async function executarConsulta(
  db: DB, provider: AIProvider, grupoId: number, c: Consulta,
): Promise<ResultadoConsulta> {
  const saida: ResultadoConsulta = { consulta_id: c.id, titulo: c.titulo, natureza: c.natureza };

  // Relatorio tem caminho proprio: o dossie ja carrega todos os agregados, entao
  // nao passa pelas metricas nem pelo RAG.
  if (c.natureza === 'relatorio') {
    const r = await gerarRelatorio(db, provider, grupoId, c.parametro ?? 'geral', c.dias ?? 30);
    saida.markdown = r.markdown;
    saida.numeros_suspeitos = r.numeros_suspeitos;
    saida.vazio = r.vazio;
    if (r.vazio) saida.aviso = 'Sem mensagens no periodo — nada a relatar.';
    return saida;
  }

  if (c.natureza === 'metrica' || c.natureza === 'mista') {
    const { vazio, ...visual } = await rodarMetrica(db, grupoId, c);
    saida.visual = visual;
    if (vazio) {
      saida.vazio = true;
      saida.aviso = c.dias
        ? `Sem mensagens nos últimos ${c.dias} dias neste grupo.`
        : 'Este grupo ainda não tem mensagens.';
      // Sem dado não há o que a IA leia — não gasta chamada à toa.
      if (c.natureza === 'mista') return saida;
    }
  }

  if (c.natureza === 'pergunta' || c.natureza === 'mista') {
    const pergunta = (c.pergunta ?? '').trim();
    if (!pergunta) { saida.texto = 'Esta consulta não tem pergunta configurada.'; return saida; }

    const { rows } = await db.query<{ blocos: number; mensagens: number }>(
      `select (select count(*) from blocos    where grupo_id = $1)::int as blocos,
              (select count(*) from mensagens where grupo_id = $1)::int as mensagens`, [grupoId]);
    const n = rows[0];
    // Mesmo diagnóstico da busca: "não encontrei" sem índice é correto e inútil.
    if (n && n.blocos === 0) {
      saida.texto = n.mensagens === 0
        ? 'Este grupo ainda não tem mensagens.'
        : `Este grupo tem ${n.mensagens} mensagens, mas nenhuma foi indexada. ` +
          'Clique em "Reindexar histórico" na aba Resumo e busca.';
      saida.vazio = true;
      return saida;
    }

    const r = await perguntar(db, provider, grupoId, pergunta, { topK: 8, minSimilaridade: 0.05 });
    saida.texto = r.resposta;
    saida.fontes = r.fontes;
  }

  return saida;
}
