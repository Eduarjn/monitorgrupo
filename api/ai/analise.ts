/**
 * Análise de janela de conversa — inteligência acionável, estilo Gong/Chorus.
 *
 * Três decisões que definem o módulo:
 *
 * 1. NENHUM gatilho chama o modelo na hora. Todos marcam a janela como quente e
 *    agendam a análise para `debounce_seg` depois da ÚLTIMA mensagem. Uma
 *    discussão de 40 mensagens em 6 minutos vira UMA análise, não 40 — sem isso
 *    o custo é 40× maior e o feed enche de alerta quase idêntico, que é como um
 *    painel desses perde credibilidade e morre.
 *
 * 2. A saída é JSON estruturado com citação obrigatória de mensagem_id. Item
 *    sem citação não é criado — é o que impede o modelo de inventar urgência.
 *
 * 3. `nada_relevante: true` é resposta CORRETA. Conversa sobre almoço tem que
 *    poder sair sem achado.
 */

import { createHash } from 'node:crypto';
import type { DB } from '../stats/queries.ts';
import { estimarTokens, PRECOS, type AIProvider } from './provider.ts';
import { normalizarTexto } from '../captura/chave.ts';

export type Gatilho = 'mencao' | 'termo_critico' | 'volume' | 'silencio' | 'bloco';

export interface Regras {
  termos_criticos: string[];
  mencoes: string[];
  volume_limite: number;
  volume_janela_min: number;
  silencio_horas: number;
  debounce_seg: number;
  ia_ativa: boolean;
  teto_usd_dia: number;
}

export const REGRAS_PADRAO: Regras = {
  termos_criticos: ['cancelamento', 'cancelar', 'reclamacao', 'processo', 'procon',
                    'urgente', 'parado', 'fora do ar', 'multa', 'rescisao'],
  mencoes: [],
  volume_limite: 25,
  volume_janela_min: 10,
  silencio_horas: 48,
  debounce_seg: 90,
  ia_ativa: true,
  teto_usd_dia: 1.0,
};

export interface MensagemDaJanela {
  id: number;
  enviada_em: string;
  autor: string;
  conteudo: string;
}

// ------------------------------------------------------------------ gatilhos

/**
 * Avalia os gatilhos que dependem só da mensagem que acabou de chegar.
 * Volume e silêncio são varredura, não reação — ficam fora daqui.
 */
export function avaliarGatilho(
  conteudo: string, mencionados: string[], regras: Regras,
): { gatilho: Gatilho; termo: string; severidade: number } | null {
  const texto = normalizarTexto(conteudo);

  for (const alvo of regras.mencoes) {
    const a = normalizarTexto(alvo);
    if (!a) continue;
    if (mencionados.some((j) => j.startsWith(a)) || texto.includes('@' + a) || texto.includes(a)) {
      return { gatilho: 'mencao', termo: alvo, severidade: 4 };
    }
  }

  for (const termo of regras.termos_criticos) {
    const t = normalizarTexto(termo);
    // Fronteira de palavra: "cancelar" não pode casar dentro de outra palavra.
    if (t && new RegExp(`(^|\\W)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(texto)) {
      return { gatilho: 'termo_critico', termo, severidade: 5 };
    }
  }

  return null;
}

/**
 * Janela de análise: a conversa em volta da mensagem-gatilho.
 *
 * Inclui o que veio ANTES de propósito — "por que o cliente está bravo" quase
 * nunca está na mensagem em que ele fica bravo.
 *
 * ⚠️ Não reusa `montarBlocos()` de embed.ts. Parecia economia, mas as fronteiras
 * de bloco dependem do ponto de partida (os limites de 40 mensagens / 4000
 * caracteres são acumuladores), então a janela em tempo real cortaria em lugar
 * diferente do que `/indexar` produz depois — e `/indexar` apaga e recria tudo,
 * o que faria os `mensagem_ids` gravados aqui deixarem de bater.
 */
export async function montarJanela(
  db: DB, grupoId: number, ate: Date, minutos = 45, teto = 80,
): Promise<MensagemDaJanela[]> {
  const desde = new Date(ate.getTime() - minutos * 60_000);
  const { rows } = await db.query<MensagemDaJanela>(
    `select m.id::int as id,
            to_char(m.enviada_em at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI') as enviada_em,
            coalesce(p.nome_exibicao, m.autor_raw, 'desconhecido') as autor,
            m.conteudo
       from mensagens m
       left join pessoas p on p.id = m.pessoa_id
      where m.grupo_id = $1
        and m.tipo <> 'sistema'
        and m.conteudo <> ''
        and m.enviada_em > $2 and m.enviada_em <= $3
      order by m.enviada_em
      limit $4`,
    [grupoId, desde.toISOString(), ate.toISOString(), teto]);
  return rows;
}

/** Texto que vai ao modelo. O id na frente é o que permite citar. */
export function formatarJanela(
  grupoNome: string, msgs: MensagemDaJanela[], gatilho: Gatilho, termo: string,
): string {
  const autores = new Set(msgs.map((m) => m.autor)).size;
  const ini = msgs[0]?.enviada_em.replace('T', ' ') ?? '';
  const fim = msgs[msgs.length - 1]?.enviada_em.replace('T', ' ') ?? '';
  const cabecalho =
    `Grupo: ${grupoNome}\n` +
    `Janela: ${ini} → ${fim} (America/Sao_Paulo) · ${msgs.length} mensagens · ${autores} participantes\n` +
    `Gatilho: ${gatilho}${termo ? ` ("${termo}")` : ''}\n`;
  const corpo = msgs
    .map((m) => `[${m.id}] ${m.enviada_em.slice(11)} ${m.autor}: ${m.conteudo}`)
    .join('\n');
  return cabecalho + '\n' + corpo;
}

// -------------------------------------------------------------------- prompt

export const PROMPT_ANALISE = `Você analisa uma janela de conversa de um grupo de WhatsApp corporativo e devolve inteligência acionável para a gestão.

Regras inegociáveis:
- Use EXCLUSIVAMENTE o que está na janela. Não infira relações comerciais, valores, prazos ou nomes que não apareçam no texto.
- TODO item (chamado, dor, pendência, urgência) precisa citar ao menos um mensagem_id da janela. Item sem citação não deve ser criado.
- Se a janela for conversa social, ruído ou irrelevante para gestão, devolva "nada_relevante": true e deixe as listas vazias. Isso é uma resposta CORRETA e esperada — não force achados.
- "pendencia" é compromisso assumido por alguém no texto, não sugestão sua.
- "proximo_passo" é o que a GESTÃO deveria fazer, não o que o grupo deveria.
- Nomes de pessoas: exatamente como aparecem na janela.
- Português do Brasil. Objetivo, sem adjetivo de vendedor.

Responda SOMENTE com JSON válido no formato:
{
  "nada_relevante": false,
  "resumo": "2 a 4 frases sobre o que aconteceu e por que importa",
  "temperatura": 1,
  "sentimento": "positivo|neutro|negativo",
  "chamados": [{"quem":"","por_quem":"","trecho":"","respondido":false,"mensagem_id":0}],
  "assuntos_urgentes": [{"titulo":"","por_que":"","severidade":"alta|media|baixa","mensagem_ids":[0]}],
  "dores": [{"tema":"","descricao":"","quem_relatou":"","mensagem_ids":[0]}],
  "pendencias": [{"o_que":"","de_quem":"","prazo":null,"mensagem_ids":[0]}],
  "proximo_passo": "uma frase, ou null"
}
"temperatura" é 1 (rotina) a 5 (precisa de alguém agora).`;

export interface Analise {
  nada_relevante: boolean;
  resumo: string;
  temperatura: number;
  sentimento: string;
  chamados: unknown[];
  assuntos_urgentes: Array<{ titulo: string; por_que?: string; severidade?: string; mensagem_ids?: number[] }>;
  dores: unknown[];
  pendencias: unknown[];
  proximo_passo: string | null;
}

const VAZIA: Analise = {
  nada_relevante: true, resumo: '', temperatura: 1, sentimento: 'neutro',
  chamados: [], assuntos_urgentes: [], dores: [], pendencias: [], proximo_passo: null,
};

/**
 * Lê a resposta do modelo com desconfiança: modelo devolvendo prosa em volta do
 * JSON é o modo de falha mais comum, e não pode derrubar a ingestão.
 */
export function interpretarResposta(bruto: string): Analise {
  const inicio = bruto.indexOf('{');
  const fim = bruto.lastIndexOf('}');
  if (inicio < 0 || fim <= inicio) return { ...VAZIA };
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(bruto.slice(inicio, fim + 1)); } catch { return { ...VAZIA }; }

  const lista = (v: unknown) => (Array.isArray(v) ? v : []);
  const temperatura = Number(obj.temperatura);
  return {
    nada_relevante: obj.nada_relevante === true,
    resumo: typeof obj.resumo === 'string' ? obj.resumo : '',
    temperatura: Number.isFinite(temperatura) ? Math.min(5, Math.max(1, Math.round(temperatura))) : 1,
    sentimento: ['positivo', 'neutro', 'negativo'].includes(String(obj.sentimento))
      ? String(obj.sentimento) : 'neutro',
    chamados: lista(obj.chamados),
    assuntos_urgentes: lista(obj.assuntos_urgentes) as Analise['assuntos_urgentes'],
    dores: lista(obj.dores),
    pendencias: lista(obj.pendencias),
    proximo_passo: typeof obj.proximo_passo === 'string' ? obj.proximo_passo : null,
  };
}

/** md5 dos ids: a mesma janela nunca é paga duas vezes. */
export const assinaturaJanela = (ids: number[]): string =>
  createHash('md5').update(ids.slice().sort((a, b) => a - b).join(',')).digest('hex');

/**
 * Custo estimado da chamada. O `AIProvider` não devolve uso real (a interface
 * da Fase 5 só expõe `summarize`), então estimamos por caractere com a mesma
 * régua já usada no `/indexar`. É estimativa declarada, não fatura.
 */
function estimarCusto(entrada: string, saida: string) {
  const tin = estimarTokens(entrada);
  const tout = estimarTokens(saida);
  const p = PRECOS['gpt-4o-mini'];
  return {
    tokens_in: tin,
    tokens_out: tout,
    usd: (tin / 1e6) * p.entradaPorMilhao + (tout / 1e6) * p.saidaPorMilhao,
  };
}

/**
 * Roda a análise com cache e teto de custo.
 *
 * O teto por dia/grupo existe porque um grupo agitado com gatilho mal calibrado
 * consegue consumir a conta da OpenAI sozinho. Estourou: para de chamar o modelo
 * e registra — silencioso seria pior.
 */
export async function analisarJanela(
  db: DB, provider: AIProvider, grupoId: number, grupoNome: string,
  msgs: MensagemDaJanela[], gatilho: Gatilho, termo: string, regras: Regras,
): Promise<{ analise: Analise; doCache: boolean; id: number | null }> {
  if (!msgs.length) return { analise: { ...VAZIA }, doCache: false, id: null };

  const ids = msgs.map((m) => m.id);
  const assinatura = assinaturaJanela(ids);

  const { rows: cache } = await db.query<{ id: number; dados: Analise }>(
    `select id::int as id, dados from wa_analises where grupo_id = $1 and assinatura = $2`,
    [grupoId, assinatura]);
  if (cache[0]) return { analise: cache[0].dados, doCache: true, id: cache[0].id };

  const { rows: uso } = await db.query<{ usd: string }>(
    `select coalesce(usd, 0)::text as usd from wa_uso_ia where dia = current_date and grupo_id = $1`,
    [grupoId]);
  if (Number(uso[0]?.usd ?? 0) >= regras.teto_usd_dia) {
    return { analise: { ...VAZIA, resumo: 'Teto de custo diário atingido.' }, doCache: false, id: null };
  }

  const texto = formatarJanela(grupoNome, msgs, gatilho, termo);
  // `summarize(texto, instrucao)` é a porta que a Fase 5 já expõe — sem chave
  // ela cai no MockProvider, então todo este caminho roda em teste sem custo.
  const bruto = await provider.summarize(texto, PROMPT_ANALISE);
  const analise = interpretarResposta(bruto);
  const custo = estimarCusto(texto, bruto);

  const { rows } = await db.query<{ id: number }>(
    `insert into wa_analises (grupo_id, inicio_em, fim_em, mensagem_ids, assinatura, gatilho,
                              nada_relevante, resumo, temperatura, sentimento, dados,
                              modelo, tokens_in, tokens_out, usd)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (grupo_id, assinatura) do nothing
     returning id::int as id`,
    [grupoId, msgs[0].enviada_em, msgs[msgs.length - 1].enviada_em, ids, assinatura, gatilho,
     analise.nada_relevante, analise.resumo, analise.temperatura, analise.sentimento,
     JSON.stringify(analise), provider.nome, custo.tokens_in, custo.tokens_out, custo.usd]);

  await db.query(
    `insert into wa_uso_ia (dia, grupo_id, chamadas, tokens_in, tokens_out, usd)
     values (current_date, $1, 1, $2, $3, $4)
     on conflict (dia, grupo_id) do update
       set chamadas = wa_uso_ia.chamadas + 1,
           tokens_in = wa_uso_ia.tokens_in + excluded.tokens_in,
           tokens_out = wa_uso_ia.tokens_out + excluded.tokens_out,
           usd = wa_uso_ia.usd + excluded.usd`,
    [grupoId, custo.tokens_in, custo.tokens_out, custo.usd]);

  return { analise, doCache: false, id: rows[0]?.id ?? null };
}

/** Alertas do feed. Só o que tem citação vira alerta. */
export async function gerarAlertas(
  db: DB, grupoId: number, analiseId: number | null, a: Analise, gatilho: Gatilho,
): Promise<number> {
  if (a.nada_relevante || !analiseId) return 0;
  let n = 0;
  for (const u of a.assuntos_urgentes) {
    if (!u?.titulo || !(u.mensagem_ids ?? []).length) continue;
    const sev = u.severidade === 'alta' ? 5 : u.severidade === 'media' ? 3 : 2;
    await db.query(
      `insert into wa_alertas (grupo_id, analise_id, tipo, severidade, titulo, detalhe, mensagem_ids)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [grupoId, analiseId, gatilho, sev, u.titulo, u.por_que ?? null, u.mensagem_ids ?? []]);
    n++;
  }
  return n;
}
