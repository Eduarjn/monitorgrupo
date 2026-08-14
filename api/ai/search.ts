/**
 * whatsapp-monitor — Fase 5: busca semântica (RAG).
 *
 * POR QUE EMBEDDINGS EM VEZ DE MANDAR O HISTÓRICO INTEIRO AO MODELO
 * — o brief pede essa explicação, e ela é quantitativa:
 *
 *   Um grupo com 60 mil mensagens tem ~2,5 milhões de tokens. Enviar isso a
 *   cada pergunta é (a) impossível, porque estoura a janela de contexto de
 *   qualquer modelo atual, e (b) caro: mesmo cabendo, seriam ~US$ 0,38 POR
 *   PERGUNTA com gpt-4o-mini.
 *
 *   Com RAG: os blocos são vetorizados UMA vez (~US$ 0,05 pelo histórico
 *   inteiro), e cada pergunta custa um embedding da pergunta (fração de
 *   centavo) + ~8 blocos de contexto (~2 mil tokens, ~US$ 0,0003).
 *
 *   Ou seja: ~1.000× mais barato por pergunta, e funciona em histórico de
 *   qualquer tamanho. O preço é que a resposta só enxerga o que foi
 *   recuperado — por isso as fontes são sempre devolvidas, para o usuário
 *   julgar se a recuperação foi boa.
 */

import type { AIProvider, TrechoContexto } from './provider.ts';
import type { DB } from '../stats/queries.ts';
import type { RespostaBusca } from '../../shared/types.ts';

export interface OpcoesBusca {
  /** Quantos blocos recuperar. Mais = mais contexto e mais custo. */
  topK?: number;
  /**
   * Similaridade mínima (0–1). Bloco abaixo disso é ruído: entra no contexto e
   * atrapalha mais do que ajuda. Com 0 nada é filtrado.
   */
  minSimilaridade?: number;
  periodo?: { inicio?: string | null; fim?: string | null };
}

interface LinhaBloco {
  bloco_id: number;
  inicio_em: string;
  fim_em: string;
  texto: string;
  similaridade: number;
}

/**
 * Recupera os blocos mais próximos da pergunta.
 *
 * `<=>` é a distância de cosseno do pgvector (0 = idêntico, 2 = oposto), e é o
 * operador que casa com o índice HNSW criado na Fase 1 — usar outro operador
 * ignoraria o índice e viraria varredura completa.
 */
export async function recuperar(
  db: DB,
  provider: AIProvider,
  grupoId: number,
  pergunta: string,
  opcoes: OpcoesBusca = {},
): Promise<LinhaBloco[]> {
  const topK = opcoes.topK ?? 8;
  const [vetor] = await provider.embed([pergunta]);

  const { rows } = await db.query<LinhaBloco>(
    `
    select id as bloco_id,
           to_char(inicio_em at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS') as inicio_em,
           to_char(fim_em    at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS') as fim_em,
           texto,
           1 - (embedding <=> $2::vector) as similaridade
      from blocos
     where grupo_id = $1
       and embedding is not null
       and ($3::timestamptz is null or inicio_em >= $3)
       and ($4::timestamptz is null or inicio_em <  $4)
     order by embedding <=> $2::vector
     limit $5
    `,
    [grupoId, `[${vetor.join(',')}]`,
     opcoes.periodo?.inicio ?? null, opcoes.periodo?.fim ?? null, topK],
  );

  const min = opcoes.minSimilaridade ?? 0;
  return rows.filter((r) => r.similaridade >= min);
}

/**
 * Pergunta em linguagem natural → resposta fundamentada nos trechos.
 *
 * Se nada for recuperado, NÃO chama o modelo: responde direto que não achou.
 * Chamar o modelo sem contexto é pagar para ele inventar.
 */
export async function perguntar(
  db: DB,
  provider: AIProvider,
  grupoId: number,
  pergunta: string,
  opcoes: OpcoesBusca = {},
): Promise<RespostaBusca> {
  const blocos = await recuperar(db, provider, grupoId, pergunta, opcoes);

  if (!blocos.length) {
    return { pergunta, resposta: 'Não encontrei isso no histórico recuperado.', fontes: [] };
  }

  const contexto: TrechoContexto[] = blocos.map((b) => ({
    bloco_id: b.bloco_id, inicio_em: b.inicio_em, fim_em: b.fim_em, texto: b.texto,
  }));

  const resposta = await provider.answer(pergunta, contexto);

  return {
    pergunta,
    resposta,
    // as fontes SEMPRE voltam: é como o usuário audita se a recuperação prestou
    fontes: blocos.map((b) => ({
      bloco_id: b.bloco_id,
      inicio_em: b.inicio_em,
      fim_em: b.fim_em,
      trecho: b.texto.length > 400 ? b.texto.slice(0, 400) + '…' : b.texto,
      similaridade: Number(b.similaridade.toFixed(4)),
    })),
  };
}
