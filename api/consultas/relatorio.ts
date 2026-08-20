/**
 * Relatório executivo em Markdown, com gráficos Mermaid.
 *
 * ⚠️ A REGRA DA CASA CONTINUA VALENDO: o modelo NÃO produz número.
 *
 * O pedido original mandava entregar os logs crus e pedir gráficos. Isso faria o
 * modelo somar, contar e arredondar — e ele erra nisso de um jeito que parece
 * certo. Num relatório que vai para gestão, número errado com aparência de
 * dashboard é pior do que não ter dashboard.
 *
 * O desenho aqui inverte: o SQL calcula TODOS os agregados, o dossiê já chega
 * pronto ao modelo, e a instrução é explícita — copiar os valores, nunca
 * recalcular. Ao modelo cabe o que ele faz bem: escrever a leitura de negócio
 * para o nicho, priorizar o que importa e redigir os alertas.
 *
 * Depois de gerado, `conferirNumeros()` reabre o Markdown e checa se os valores
 * dos gráficos batem com o dossiê. Divergência vira aviso no próprio relatório.
 */

import type { DB } from '../stats/queries.ts';
import { getHorariosDePico, getRankingParticipantes, getVolumePorDia } from '../stats/queries.ts';
import type { AIProvider } from '../ai/provider.ts';
import { neutralizar } from '../ai/analise.ts';
import { montarMarkdown, type Narrativa } from './markdown.ts';

export interface Dossie {
  grupo: string;
  nicho: string;
  periodo: { inicio: string; fim: string; dias: number };
  totais: {
    mensagens: number;
    participantes: number;
    dias_com_atividade: number;
    media_por_dia: number;
  };
  por_tipo: Array<{ tipo: string; total: number }>;
  por_origem: Array<{ origem: string; total: number }>;
  por_participante: Array<{ nome: string; mensagens: number; participacao_pct: number }>;
  por_hora: Array<{ hora: string; mensagens: number }>;
  por_dia: Array<{ dia: string; mensagens: number }>;
  alertas: Array<{ tipo: string; severidade: number; titulo: string; estado: string; criado_em: string }>;
  temas_ia: Array<{ resumo: string; temperatura: number; sentimento: string }>;
  tempo_sem_atividade_h: number | null;
}

/**
 * Monta o dossiê: tudo que vai ao modelo, já contado pelo banco.
 * Uma consulta por bloco — nenhuma agregação em JavaScript, para que o número
 * do relatório seja o mesmo número que o Dashboard mostra.
 */
export async function montarDossie(
  db: DB, grupoId: number, nicho: string, dias = 30,
): Promise<Dossie> {
  const fim = new Date();
  const inicio = new Date(fim.getTime() - dias * 86_400_000);
  const p = { inicio: inicio.toISOString(), fim: fim.toISOString() };

  const [nome, tipos, origens, ranking, horas, porDia, alertas, analises, ultima] =
    await Promise.all([
      db.query<{ nome: string }>(`select nome from grupos where id = $1`, [grupoId]),
      db.query<{ tipo: string; total: number }>(
        `select tipo, count(*)::int as total from mensagens
          where grupo_id = $1 and enviada_em >= $2 and enviada_em < $3
          group by tipo order by 2 desc`, [grupoId, p.inicio, p.fim]),
      db.query<{ origem: string; total: number }>(
        `select origem, count(*)::int as total from mensagens
          where grupo_id = $1 and enviada_em >= $2 and enviada_em < $3
          group by origem order by 2 desc`, [grupoId, p.inicio, p.fim]),
      getRankingParticipantes(db, grupoId, 12, p),
      getHorariosDePico(db, grupoId, p),
      getVolumePorDia(db, grupoId, p),
      db.query<{ tipo: string; severidade: number; titulo: string; estado: string; criado_em: string }>(
        `select tipo, severidade, titulo, estado, criado_em::text from wa_alertas
          where grupo_id = $1 and criado_em >= $2
          order by severidade desc, criado_em desc limit 15`, [grupoId, p.inicio]),
      db.query<{ resumo: string; temperatura: number; sentimento: string }>(
        `select resumo, temperatura, sentimento from wa_analises
          where grupo_id = $1 and inicio_em >= $2 and not nada_relevante
          order by temperatura desc, inicio_em desc limit 10`, [grupoId, p.inicio]),
      db.query<{ h: number | null }>(
        `select extract(epoch from (now() - max(enviada_em)))/3600 as h
           from mensagens where grupo_id = $1`, [grupoId]),
    ]);

  const total = tipos.rows.reduce((s, t) => s + t.total, 0);
  const diasAtivos = porDia.length;

  return {
    grupo: nome.rows[0]?.nome ?? 'grupo',
    nicho,
    periodo: { inicio: p.inicio.slice(0, 10), fim: p.fim.slice(0, 10), dias },
    totais: {
      mensagens: total,
      participantes: ranking.length,
      dias_com_atividade: diasAtivos,
      media_por_dia: diasAtivos ? Math.round(total / diasAtivos) : 0,
    },
    por_tipo: tipos.rows,
    por_origem: origens.rows,
    por_participante: ranking.map((r) => ({
      nome: r.nome,
      mensagens: r.mensagens,
      participacao_pct: total ? Math.round((r.mensagens / total) * 1000) / 10 : 0,
    })),
    por_hora: horas.map((h) => ({ hora: `${String(h.hora).padStart(2, '0')}h`, mensagens: h.mensagens })),
    por_dia: porDia.map((d) => ({ dia: d.dia, mensagens: d.mensagens })),
    alertas: alertas.rows,
    temas_ia: analises.rows,
    tempo_sem_atividade_h: ultima.rows[0]?.h != null ? Math.round(Number(ultima.rows[0].h)) : null,
  };
}

export const PROMPT_RELATORIO = `Você é o motor de inteligência analítica da plataforma ERA (PABX em Nuvem e Omnichannel).

Recebe um DOSSIÊ já apurado no banco e devolve APENAS a parte interpretativa de um
relatório executivo. Os números, tabelas e gráficos são montados por código — você
NÃO precisa reproduzi-los e NÃO deve calcular nada.

Devolva SOMENTE JSON válido, neste formato:
{
  "resumo": "3 a 5 frases dizendo o que os números SIGNIFICAM para o negócio deste nicho, não o que eles são",
  "alertas": [
    {"titulo": "curto e direto", "explicacao": "por que isso importa, apoiado num dado do dossiê", "severidade": "alta|media|baixa"}
  ],
  "recomendacoes": ["ação concreta para a gestão", "no máximo 3"]
}

REGRAS:
- Nunca invente número. Se citar um valor, ele tem que estar no dossiê.
- Alertas devem ser as dores CRÍTICAS DO NICHO informado, não genéricas.
- Se o volume for baixo demais para conclusão, diga isso no resumo e devolva poucos alertas — forçar análise sobre dado ralo é pior que admitir que falta dado.
- Português do Brasil, objetivo, sem adjetivo de vendedor.

SOBRE O NICHO: provedor de internet sofre com integração de ERP e chamado repetido; imobiliária vive de discador e velocidade de retorno ao lead; saúde depende de agendamento, confirmação e no-show; varejo tem pico sazonal e fila. Fale a língua do negócio do cliente.`;

/** Lê a narrativa com desconfiança: modelo devolvendo prosa em volta do JSON é o modo de falha comum. */
export function interpretarNarrativa(bruto: string): Narrativa {
  const vazia: Narrativa = { resumo: '', alertas: [], recomendacoes: [] };
  const i = bruto.indexOf('{'); const j = bruto.lastIndexOf('}');
  if (i < 0 || j <= i) return { ...vazia, resumo: bruto.trim().slice(0, 800) };
  let o: Record<string, unknown>;
  try { o = JSON.parse(bruto.slice(i, j + 1)); } catch { return { ...vazia, resumo: bruto.trim().slice(0, 800) }; }

  const sev = (v: unknown) => (['alta', 'media', 'baixa'].includes(String(v)) ? String(v) : 'media');
  return {
    resumo: typeof o.resumo === 'string' ? o.resumo.trim() : '',
    alertas: (Array.isArray(o.alertas) ? o.alertas : []).slice(0, 8)
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !!a.titulo)
      .map((a) => ({
        // Pipe e quebra de linha destruiriam a tabela Markdown em que o alerta cai.
        titulo: String(a.titulo).replace(/[|\r\n]/g, ' ').slice(0, 120),
        explicacao: String(a.explicacao ?? '').replace(/[|\r\n]/g, ' ').slice(0, 300),
        severidade: sev(a.severidade) as 'alta' | 'media' | 'baixa',
      })),
    recomendacoes: (Array.isArray(o.recomendacoes) ? o.recomendacoes : []).slice(0, 3)
      .map((r) => String(r).replace(/[\r\n]/g, ' ').slice(0, 300)).filter(Boolean),
  };
}

/**
 * Confere se os números do relatório existem no dossiê.
 *
 * Não é prova formal — é rede de segurança. Extrai os inteiros dos blocos
 * Mermaid e das tabelas e compara com o conjunto de valores legítimos. Um
 * número que não veio do dossiê significa que o modelo calculou algo, que é
 * exatamente o que a regra proíbe.
 */
export function conferirNumeros(markdown: string, d: Dossie): string[] {
  const legitimos = new Set<number>([
    d.totais.mensagens, d.totais.participantes, d.totais.dias_com_atividade,
    d.totais.media_por_dia, d.periodo.dias,
    ...d.por_tipo.map((x) => x.total),
    ...d.por_origem.map((x) => x.total),
    ...d.por_participante.flatMap((x) => [x.mensagens, Math.round(x.participacao_pct)]),
    ...d.por_hora.map((x) => x.mensagens),
    ...d.por_dia.map((x) => x.mensagens),
    ...d.alertas.map((x) => x.severidade),
    ...d.temas_ia.map((x) => x.temperatura),
  ]);

  const suspeitos: string[] = [];
  const blocos = markdown.match(/```mermaid[\s\S]*?```/g) ?? [];
  for (const bloco of blocos) {
    for (const m of bloco.matchAll(/:\s*(\d+)(?!\d*\s*[-/])/g)) {
      const n = Number(m[1]);
      // 0..3 aparecem como eixo, índice ou casa decimal — ruído, não afirmação.
      if (n > 3 && !legitimos.has(n)) suspeitos.push(String(n));
    }
  }
  return [...new Set(suspeitos)];
}

export interface RelatorioGerado {
  markdown: string;
  dossie: Dossie;
  numeros_suspeitos: string[];
  vazio: boolean;
  /** true = veio do cache, nenhuma chamada de modelo foi paga. */
  doCache: boolean;
}

/**
 * Chave do cache do relatório.
 *
 * Inclui o total de mensagens e a última atividade: chegou mensagem nova, a
 * chave muda e o relatório é refeito. Nada mudou, reaproveita. Inclui também
 * nicho e janela, porque a leitura do modelo depende dos dois.
 *
 * Não é hash criptográfico de propósito — é chave de cache, não segredo.
 */
function chaveRelatorio(d: Dossie, dias: number): string {
  return [d.nicho, dias, d.totais.mensagens, d.totais.participantes,
          d.tempo_sem_atividade_h ?? 'x', d.alertas.length].join('|');
}

async function lerCache(db: DB, grupoId: number, chave: string): Promise<Narrativa | null> {
  try {
    const { rows } = await db.query<{ narrativa: Narrativa }>(
      `select narrativa from relatorio_cache
        where grupo_id = $1 and chave = $2 and criado_em > now() - interval '7 days'`,
      [grupoId, chave]);
    return rows[0]?.narrativa ?? null;
  } catch {
    // Cache indisponível nunca pode derrubar o relatório — só encarece.
    return null;
  }
}

async function gravarCache(db: DB, grupoId: number, chave: string, n: Narrativa): Promise<void> {
  try {
    await db.query(
      `insert into relatorio_cache (grupo_id, chave, narrativa) values ($1, $2, $3)
         on conflict (grupo_id, chave) do update
            set narrativa = excluded.narrativa, criado_em = now()`,
      [grupoId, chave, JSON.stringify(n)]);
  } catch { /* idem: falhar em gravar cache não é falha do relatório */ }
}

/**
 * Versão enxuta do dossiê, só para o prompt.
 *
 * O dossiê completo carrega até 90 entradas de `por_dia`, as 24 de `por_hora`,
 * 15 alertas com data e estado, e 10 temas inteiros. Nada disso muda a
 * interpretação — o modelo só precisa saber a forma dos dados, não a série
 * ponto a ponto. Mandar tudo era pagar token por informação que o próprio
 * código já vai escrever no Markdown.
 *
 * Também sai o `JSON.stringify(…, null, 2)`: a indentação é pura decoração e
 * custa token igual.
 */
export function resumirParaIA(d: Dossie): Record<string, unknown> {
  const pico = d.por_hora.length
    ? d.por_hora.reduce((a, b) => (b.mensagens > a.mensagens ? b : a)) : null;

  // Tendência em vez da série: primeira metade contra a segunda diz ao modelo
  // se o grupo está esquentando ou esfriando, que é tudo que ele faz com isso.
  const meio = Math.floor(d.por_dia.length / 2);
  const soma = (xs: typeof d.por_dia) => xs.reduce((s, x) => s + x.mensagens, 0);
  const tendencia = d.por_dia.length >= 4
    ? { primeira_metade: soma(d.por_dia.slice(0, meio)), segunda_metade: soma(d.por_dia.slice(meio)) }
    : null;

  return {
    grupo: d.grupo,
    nicho: d.nicho,
    periodo: d.periodo,
    totais: d.totais,
    por_tipo: d.por_tipo,
    // Cauda longa de participante não muda a leitura; o topo, sim.
    participantes_topo: d.por_participante.slice(0, 6),
    hora_de_pico: pico,
    tendencia,
    horas_sem_atividade: d.tempo_sem_atividade_h,
    alertas_da_plataforma: d.alertas.slice(0, 5).map((a) => ({
      tipo: a.tipo, severidade: a.severidade, titulo: a.titulo,
    })),
    temas_observados: d.temas_ia.slice(0, 5).map((t) => ({
      resumo: t.resumo.slice(0, 200), temperatura: t.temperatura, sentimento: t.sentimento,
    })),
  };
}

export async function gerarRelatorio(
  db: DB, provider: AIProvider, grupoId: number, nicho: string, dias = 30,
): Promise<RelatorioGerado> {
  const dossie = await montarDossie(db, grupoId, neutralizar(nicho, 60) || 'geral', dias);

  // Sem dado nao ha o que interpretar — nao gasta chamada de modelo.
  if (dossie.totais.mensagens === 0) {
    return {
      markdown: montarMarkdown(dossie, {
        resumo: `Sem mensagens entre ${dossie.periodo.inicio} e ${dossie.periodo.fim}. ` +
                'Não há base para análise no período.',
        alertas: [], recomendacoes: [],
      }),
      dossie, numeros_suspeitos: [], vazio: true, doCache: false,
    };
  }

  // Cache: o relatorio so muda quando chega mensagem nova. Reabrir o mesmo card
  // tres vezes na reuniao nao pode custar tres chamadas de modelo.
  const chave = chaveRelatorio(dossie, dias);
  const guardado = await lerCache(db, grupoId, chave);
  if (guardado) {
    return { markdown: montarMarkdown(dossie, guardado), dossie,
             numeros_suspeitos: [], vazio: false, doCache: true };
  }

  const bruto = await provider.summarize(
    'DOSSIÊ (números já apurados pelo banco):\n' + JSON.stringify(resumirParaIA(dossie)),
    PROMPT_RELATORIO,
  );
  const narrativa = interpretarNarrativa(bruto);
  await gravarCache(db, grupoId, chave, narrativa);
  const markdown = montarMarkdown(dossie, narrativa);

  // A conferencia continua, mas agora e cinto e suspensorio: os numeros do
  // relatorio sao escritos por codigo, entao so poderiam divergir se a IA
  // citasse um valor dentro do texto narrativo.
  return { markdown, dossie, numeros_suspeitos: conferirNumeros(markdown, dossie), vazio: false };
}
