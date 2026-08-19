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
Recebe um DOSSIÊ já apurado e devolve um relatório executivo em Markdown.

REGRA ABSOLUTA SOBRE NÚMEROS:
- Todo número que você escrever DEVE ser copiado literalmente do dossiê. Nunca some, calcule, estime, arredonde ou complete.
- Se um dado não está no dossiê, ele não existe: escreva "sem dado" em vez de inventar.
- Isso vale especialmente para os gráficos Mermaid: os valores vêm do dossiê, sem exceção.

O QUE VOCÊ PRODUZ:
1. APENAS Markdown. Sem conversa, sem preâmbulo, sem "aqui está".
2. Comece com um título e uma linha de período.
3. Uma seção "Resumo executivo" com 3 a 5 frases de leitura de negócio — o que os números significam para este nicho, não o que eles são.
4. Pelo menos UM gráfico Mermaid. Use o formato exato:
   \`\`\`mermaid
   pie title Mensagens por tipo
     "texto" : 120
   \`\`\`
   Para série temporal use xychart-beta; para composição use pie. Rótulos sempre entre aspas.
5. Uma tabela Markdown com o desempenho por participante (nome, mensagens, % de participação).
6. Uma seção "Alertas" com as dores CRÍTICAS DESTE NICHO, não genéricas. Cada alerta precisa se apoiar num dado do dossiê.
7. Uma seção "Recomendações" com no máximo 3 ações concretas para a gestão.

SOBRE O NICHO:
Ajuste a leitura ao nicho informado. Provedor de internet sofre com integração de ERP e chamado de suporte repetido; imobiliária vive de discador e velocidade de retorno ao lead; saúde depende de agendamento, confirmação e no-show; varejo tem pico sazonal e fila de atendimento. Fale a língua do negócio do cliente.

TOM: objetivo, em português do Brasil, sem adjetivo de vendedor. Se o volume for baixo demais para conclusão, diga isso em vez de forçar análise.`;

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
}

export async function gerarRelatorio(
  db: DB, provider: AIProvider, grupoId: number, nicho: string, dias = 30,
): Promise<RelatorioGerado> {
  const dossie = await montarDossie(db, grupoId, neutralizar(nicho, 60) || 'geral', dias);

  if (dossie.totais.mensagens === 0) {
    return {
      markdown: `# ${dossie.grupo}\n\n_Sem mensagens entre ${dossie.periodo.inicio} e ` +
                `${dossie.periodo.fim}. Não há o que relatar._\n`,
      dossie, numeros_suspeitos: [], vazio: true,
    };
  }

  const markdown = await provider.summarize(
    `DOSSIÊ (todos os números já apurados — copie, não recalcule):\n\n` +
    JSON.stringify(dossie, null, 2),
    PROMPT_RELATORIO,
  );

  const limpo = markdown
    .replace(/^```(?:markdown|md)\s*\n/i, '')   // modelo às vezes cerca tudo em bloco
    .replace(/\n```\s*$/i, '')
    .trim();

  const suspeitos = conferirNumeros(limpo, dossie);
  const aviso = suspeitos.length
    ? `\n\n---\n\n> ⚠️ **Conferência automática:** os valores ${suspeitos.join(', ')} ` +
      `aparecem no relatório mas não constam no dossiê apurado. Trate-os como não ` +
      `confiáveis — o restante dos números foi conferido contra o banco.\n`
    : '';

  return { markdown: limpo + aviso, dossie, numeros_suspeitos: suspeitos, vazio: false };
}
