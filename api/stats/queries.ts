/**
 * whatsapp-monitor — Fase 3: estatísticas em SQL PURO.
 *
 * Nenhuma função aqui chama modelo de IA. Tudo é contagem/agregação no
 * Postgres — rápido, barato e determinístico (princípio 2 do brief).
 *
 * ── Duas decisões transversais ─────────────────────────────────────────────
 *
 * 1. AGRUPAMENTO POR IDENTIDADE, NÃO POR STRING (risco 1.3)
 *    O export traz o autor como está na agenda de quem exportou: "João",
 *    "João Silva" e "+55 19 99876-5432" podem ser a MESMA pessoa. Por isso o
 *    agrupamento usa `pessoa_id` quando a conciliação já ligou a mensagem a
 *    uma pessoa, e cai para `autor_raw` quando não. Conforme a conciliação
 *    avança, os números convergem sozinhos — sem reprocessar nada.
 *
 * 2. FUSO EXPLÍCITO EM TUDO QUE VIRA "DIA" OU "HORA" (parente do risco 1.1)
 *    `enviada_em` é timestamptz (UTC internamente). Uma mensagem de 23:30 em
 *    São Paulo é 02:30 UTC do dia seguinte — DATE_TRUNC sem fuso jogaria a
 *    mensagem no dia errado e o "horário de pico" sairia deslocado 3 horas.
 *    Toda query converte com `AT TIME ZONE $fuso` antes de truncar/extrair.
 *
 * ── Índices que sustentam estas queries (já criados na Fase 1) ─────────────
 *
 *   idx_mensagens_reais       (grupo_id, enviada_em) WHERE tipo <> 'sistema'
 *     → é O índice destas funções: parcial, cobre exatamente o filtro que
 *       todas usam. Range de datas vira Index/Bitmap Scan, nunca Seq Scan.
 *   idx_mensagens_grupo_data  (grupo_id, enviada_em DESC)
 *     → linha do tempo geral (inclui sistema), usada pelo resumo da Fase 5.
 *   idx_mensagens_busca       GIN (busca)
 *     → Full-Text Search das menções.
 *
 *   Sobre o pedido de "B-Tree em autor": um índice em autor_raw NÃO ajuda
 *   estas agregações — com filtro por grupo+período, o Postgres precisa visitar
 *   as linhas do período de qualquer jeito, e o GROUP BY vira HashAggregate em
 *   memória. Índice extra só custaria escrita a cada upload semanal. Se um dia
 *   houver "linha do tempo DE UM autor", aí sim: (grupo_id, autor_raw, enviada_em).
 *
 * ── Custo típico (validado com EXPLAIN ANALYZE sobre 60k mensagens) ────────
 *   volume/dia/ranking com período  → Bitmap Index Scan no parcial, poucos ms
 *   pico/ranking do histórico todo  → lê tudo mesmo (agregação total é assim);
 *                                     o parcial ainda poupa as linhas 'sistema'
 *   menções                          → Bitmap Index Scan no GIN, ms
 */

import type { ContagemMencoes, HorarioPico, VolumePorAutor, VolumePorDia } from '../../shared/types.ts';

/**
 * Injeção de dependência: as funções recebem o executor em vez de importar um
 * pool global — testáveis com qualquer client compatível com `pg` (Pool,
 * Client, transação aberta…).
 */
export interface DB {
  query<R = unknown>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

const FUSO_PADRAO = 'America/Sao_Paulo';

/**
 * Período meio-aberto [inicio, fim): "de 01/08 a 01/09" pega o mês de agosto
 * inteiro sem depender de 23:59:59.999. `null` = sem limite daquele lado.
 */
export interface Periodo {
  inicio?: string | null;  // ISO ou 'YYYY-MM-DD'
  fim?: string | null;
}

// ---------------------------------------------------------------------------
// 1. Volume por autor
// ---------------------------------------------------------------------------
export async function getVolumePorAutor(
  db: DB,
  grupoId: number,
  periodo: Periodo = {},
): Promise<VolumePorAutor[]> {
  const { rows } = await db.query<VolumePorAutor>(
    `
    select m.pessoa_id,
           coalesce(p.nome_exibicao, m.autor_raw, '(sem autor)') as nome,
           count(*)::int as mensagens
      from mensagens m
      left join pessoas p on p.id = m.pessoa_id
     where m.grupo_id = $1
       and m.tipo <> 'sistema'                        -- texto e mídia contam; evento não
       and ($2::timestamptz is null or m.enviada_em >= $2)
       and ($3::timestamptz is null or m.enviada_em <  $3)
     group by m.pessoa_id, coalesce(p.nome_exibicao, m.autor_raw, '(sem autor)')
     order by mensagens desc, nome
    `,
    [grupoId, periodo.inicio ?? null, periodo.fim ?? null],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// 2. Volume por dia (curva temporal do dashboard)
// ---------------------------------------------------------------------------
export async function getVolumePorDia(
  db: DB,
  grupoId: number,
  periodo: Periodo = {},
  fuso: string = FUSO_PADRAO,
): Promise<VolumePorDia[]> {
  const { rows } = await db.query<VolumePorDia>(
    `
    select to_char(date_trunc('day', m.enviada_em at time zone $4), 'YYYY-MM-DD') as dia,
           count(*)::int as mensagens
      from mensagens m
     where m.grupo_id = $1
       and m.tipo <> 'sistema'
       and ($2::timestamptz is null or m.enviada_em >= $2)
       and ($3::timestamptz is null or m.enviada_em <  $3)
     group by 1
     order by 1
    `,
    [grupoId, periodo.inicio ?? null, periodo.fim ?? null, fuso],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// 3. Horários de pico (mapa de calor 0–23h)
// ---------------------------------------------------------------------------
export async function getHorariosDePico(
  db: DB,
  grupoId: number,
  periodo: Periodo = {},
  fuso: string = FUSO_PADRAO,
): Promise<HorarioPico[]> {
  const { rows } = await db.query<HorarioPico>(
    `
    select extract(hour from m.enviada_em at time zone $4)::int as hora,
           count(*)::int as mensagens
      from mensagens m
     where m.grupo_id = $1
       and m.tipo <> 'sistema'
       and ($2::timestamptz is null or m.enviada_em >= $2)
       and ($3::timestamptz is null or m.enviada_em <  $3)
     group by 1
     order by 1
    `,
    [grupoId, periodo.inicio ?? null, periodo.fim ?? null, fuso],
  );
  // Mapa de calor precisa das 24 posições — hora sem mensagem vem com zero.
  const porHora = new Map(rows.map((r) => [r.hora, r.mensagens]));
  return Array.from({ length: 24 }, (_, hora) => ({ hora, mensagens: porHora.get(hora) ?? 0 }));
}

// ---------------------------------------------------------------------------
// 4. Ranking de participantes (top N)
// ---------------------------------------------------------------------------
export async function getRankingParticipantes(
  db: DB,
  grupoId: number,
  limite = 10,
  periodo: Periodo = {},
): Promise<VolumePorAutor[]> {
  const todos = await getVolumePorAutor(db, grupoId, periodo);
  // Reusa a query do volume: o custo é o mesmo (a agregação já visita tudo) e
  // a regra de identidade fica num lugar só. O corte é feito aqui.
  return todos.slice(0, limite);
}

// ---------------------------------------------------------------------------
// 5. Menções a um termo ("quantas vezes me citaram?")
// ---------------------------------------------------------------------------
export async function getMencoesTermo(
  db: DB,
  grupoId: number,
  termo: string,
  periodo: Periodo = {},
): Promise<ContagemMencoes> {
  const { rows } = await db.query<{ mensagens: number; ocorrencias: number }>(
    `
    with alvo as (
      -- websearch_to_tsquery em vez de to_tsquery: aceita entrada humana
      -- ("proposta era", com aspas, OR…) sem estourar erro de sintaxe — input
      -- de usuário nunca deve alcançar to_tsquery cru.
      select websearch_to_tsquery('portuguese', $2) as q,
             unaccent(lower($2)) as literal
    )
    select count(*)::int as mensagens,
           coalesce(sum(
             -- contagem literal de ocorrências, insensível a acento/caixa:
             -- (tamanho - tamanho sem o termo) / tamanho do termo
             (length(unaccent(lower(m.conteudo)))
              - length(replace(unaccent(lower(m.conteudo)), a.literal, '')))
             / nullif(length(a.literal), 0)
           ), 0)::int as ocorrencias
      from mensagens m, alvo a
     where m.grupo_id = $1
       and m.tipo <> 'sistema'
       and m.busca @@ a.q                             -- GIN faz o corte pesado
       and ($3::timestamptz is null or m.enviada_em >= $3)
       and ($4::timestamptz is null or m.enviada_em <  $4)
    `,
    [grupoId, termo, periodo.inicio ?? null, periodo.fim ?? null],
  );
  const r = rows[0] ?? { mensagens: 0, ocorrencias: 0 };
  // `mensagens` usa FTS com stemming ("citou" acha "citaram"); `ocorrencias`
  // conta o termo LITERAL (sem acento/caixa). Uma mensagem pode casar no FTS
  // sem conter o literal — por isso os dois números existem e podem divergir.
  return { termo, mensagens: r.mensagens, ocorrencias: r.ocorrencias };
}
