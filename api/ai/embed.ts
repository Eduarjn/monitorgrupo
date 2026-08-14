/**
 * whatsapp-monitor — Fase 5: montagem de blocos + embeddings.
 *
 * POR QUE BLOCO E NÃO MENSAGEM (risco 1.5, a decisão mais importante daqui):
 * mensagem de WhatsApp é curtíssima — "ok", "kkkk", "manda aí", "é isso".
 * Vetorizar cada uma isolada produz recuperação péssima: a busca traz fragmento
 * sem contexto e o modelo responde mal mesmo com o RAG "funcionando".
 *
 * O bloco é uma JANELA DE CONVERSA: mensagens próximas no tempo, agrupadas até
 * um limite. `mensagem_ids` preserva a origem para que a resposta possa citar
 * trechos e datas, como o brief exige.
 *
 * Custo: embutir por bloco em vez de por mensagem reduz o número de vetores em
 * ~10–30× num grupo real — menos chamadas, menos armazenamento, melhor recall.
 */

import type { AIProvider } from './provider.ts';
import { estimarTokens, PRECOS } from './provider.ts';
import type { DB } from '../stats/queries.ts';

export interface OpcoesBloco {
  /** Nova janela quando o silêncio entre mensagens passa disto. */
  minutosDeCorte?: number;
  /** Teto de mensagens por bloco (evita bloco gigante em dia de pico). */
  maxMensagens?: number;
  /** Teto de caracteres (protege o limite de contexto do modelo). */
  maxCaracteres?: number;
}

const PADRAO: Required<OpcoesBloco> = {
  minutosDeCorte: 15,
  maxMensagens: 40,
  maxCaracteres: 4000,
};

export interface MensagemParaBloco {
  id: number;
  /**
   * Instante em ISO-8601 UTC (com "Z"). Precisa ser o instante ABSOLUTO, não a
   * hora local: `inicio_em`/`fim_em` são `timestamptz` e, se recebessem uma
   * string local sem fuso, o Postgres a interpretaria no fuso da sessão e o
   * bloco ficaria deslocado — bug real encontrado no teste ponta a ponta:
   * 09:14 virava 06:14 na citação do RAG (dupla conversão).
   */
  enviada_em: string;
  /** Hora já no fuso local, só para o texto do bloco ("09:14"). */
  hora_local?: string;
  autor: string;
  conteudo: string;
}

export interface BlocoMontado {
  inicio_em: string;
  fim_em: string;
  texto: string;
  mensagem_ids: number[];
}

/**
 * Agrupa mensagens (já ordenadas por data) em janelas de conversa.
 *
 * Função PURA: não toca banco nem IA — por isso dá para testar o comportamento
 * de janela isoladamente, que é onde a qualidade do RAG se decide.
 */
export function montarBlocos(
  mensagens: MensagemParaBloco[],
  opcoes: OpcoesBloco = {},
): BlocoMontado[] {
  const { minutosDeCorte, maxMensagens, maxCaracteres } = { ...PADRAO, ...opcoes };
  const blocos: BlocoMontado[] = [];

  let atual: MensagemParaBloco[] = [];
  let tamanho = 0;

  const fechar = () => {
    if (!atual.length) return;
    blocos.push({
      inicio_em: atual[0].enviada_em,
      fim_em: atual[atual.length - 1].enviada_em,
      // "HH:MM Autor: texto" — o modelo precisa saber QUEM disse o quê.
      // Usa a hora LOCAL quando disponível; o campo `enviada_em` é UTC e serviria
      // para o cálculo de janela, não para leitura humana.
      texto: atual
        .map((m) => `${m.hora_local ?? m.enviada_em.slice(11, 16)} ${m.autor}: ${m.conteudo}`)
        .join('\n'),
      mensagem_ids: atual.map((m) => m.id),
    });
    atual = [];
    tamanho = 0;
  };

  for (const m of mensagens) {
    const linha = m.conteudo.trim();
    if (!linha) continue;                       // mídia/vazio não entra no vetor

    if (atual.length) {
      const anterior = new Date(atual[atual.length - 1].enviada_em).getTime();
      const agora = new Date(m.enviada_em).getTime();
      const silencio = (agora - anterior) / 60000;
      if (
        silencio > minutosDeCorte ||
        atual.length >= maxMensagens ||
        tamanho + linha.length > maxCaracteres
      ) {
        fechar();
      }
    }
    atual.push(m);
    tamanho += linha.length;
  }
  fechar();
  return blocos;
}

/** Estimativa de custo ANTES de gastar (o brief pede isso explicitamente). */
export function estimarCustoEmbedding(blocos: BlocoMontado[], modelo = 'text-embedding-3-small') {
  const tokens = blocos.reduce((s, b) => s + estimarTokens(b.texto), 0);
  const preco = PRECOS[modelo as keyof typeof PRECOS] as { porMilhaoTokens?: number } | undefined;
  return {
    blocos: blocos.length,
    tokens,
    usd: preco?.porMilhaoTokens ? (tokens / 1_000_000) * preco.porMilhaoTokens : null,
  };
}

/**
 * Monta os blocos de um período, gera os embeddings e grava.
 *
 * Idempotente por período: apaga os blocos daquela janela antes de regravar, o
 * que permite reprocessar depois de uma recoleta sem duplicar vetores.
 */
export async function indexarPeriodo(
  db: DB,
  provider: AIProvider,
  grupoId: number,
  periodo: { inicio: string; fim: string },
  opcoes: OpcoesBloco & { lote?: number } = {},
): Promise<{ blocos: number; tokens: number; usd: number | null }> {
  const { rows } = await db.query<MensagemParaBloco>(
    `
    select m.id,
           -- instante absoluto (UTC): é o que vai para inicio_em/fim_em
           to_char(m.enviada_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as enviada_em,
           -- hora local: só para o texto que o modelo lê
           to_char(m.enviada_em at time zone 'America/Sao_Paulo', 'HH24:MI') as hora_local,
           coalesce(p.nome_exibicao, m.autor_raw, 'desconhecido') as autor,
           m.conteudo
      from mensagens m
      left join pessoas p on p.id = m.pessoa_id
     where m.grupo_id = $1
       and m.tipo in ('texto','audio_transcrito')   -- sistema e mídia não vetorizam
       and m.conteudo <> ''
       and m.enviada_em >= $2 and m.enviada_em < $3
     order by m.enviada_em
    `,
    [grupoId, periodo.inicio, periodo.fim],
  );

  const blocos = montarBlocos(rows, opcoes);
  const custo = estimarCustoEmbedding(blocos);
  if (!blocos.length) return { blocos: 0, tokens: 0, usd: 0 };

  await db.query(
    `delete from blocos where grupo_id = $1 and inicio_em >= $2 and inicio_em < $3`,
    [grupoId, periodo.inicio, periodo.fim],
  );

  const lote = opcoes.lote ?? 64;
  for (let i = 0; i < blocos.length; i += lote) {
    const fatia = blocos.slice(i, i + lote);
    const vetores = await provider.embed(fatia.map((b) => b.texto));
    for (let j = 0; j < fatia.length; j++) {
      const b = fatia[j];
      await db.query(
        `insert into blocos (grupo_id, inicio_em, fim_em, texto, mensagem_ids, embedding, modelo)
         values ($1,$2,$3,$4,$5,$6::vector,$7)`,
        [grupoId, b.inicio_em, b.fim_em, b.texto, b.mensagem_ids,
         `[${vetores[j].join(',')}]`, provider.nome],
      );
    }
  }
  return { blocos: blocos.length, tokens: custo.tokens, usd: custo.usd };
}
