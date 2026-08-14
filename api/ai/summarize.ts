/**
 * whatsapp-monitor — Fase 5: resumo de um dia / período.
 *
 * Fluxo: busca as mensagens do período no banco → monta o texto na ordem
 * cronológica → pede o resumo ao `AIProvider`. Nenhuma regra de negócio de IA
 * mora aqui; o prompt está em `provider.ts`.
 *
 * Custo: um resumo de dia num grupo ativo raramente passa de alguns milhares de
 * tokens de entrada — ordem de centésimos de centavo com gpt-4o-mini. Por isso
 * o resumo é gerado sob demanda e CACHEADO (ver `resumirDiaComCache`), em vez
 * de recalculado a cada abertura da tela.
 */

import type { AIProvider } from './provider.ts';
import { estimarTokens, PRECOS, PROMPT_RESUMO } from './provider.ts';
import type { DB } from '../stats/queries.ts';

const FUSO = 'America/Sao_Paulo';

export interface ResumoDia {
  grupo_id: number;
  dia: string;              // YYYY-MM-DD
  mensagens: number;
  autores: number;
  resumo: string;
  tokens_entrada: number;
  usd_estimado: number | null;
}

/**
 * Texto do dia no fuso local. Mídia e sistema ficam de fora do que vai ao
 * modelo (não têm conteúdo útil e só gastariam token), mas continuam contando
 * nas estatísticas da Fase 3 — são coisas diferentes de propósito.
 */
export async function textoDoDia(
  db: DB,
  grupoId: number,
  dia: string,
  fuso: string = FUSO,
): Promise<{ texto: string; mensagens: number; autores: number }> {
  const { rows } = await db.query<{ hora: string; autor: string; conteudo: string }>(
    `
    select to_char(m.enviada_em at time zone $3, 'HH24:MI') as hora,
           coalesce(p.nome_exibicao, m.autor_raw, 'desconhecido') as autor,
           m.conteudo
      from mensagens m
      left join pessoas p on p.id = m.pessoa_id
     where m.grupo_id = $1
       and m.tipo in ('texto','audio_transcrito')
       and m.conteudo <> ''
       and (m.enviada_em at time zone $3)::date = $2::date
     order by m.enviada_em
    `,
    [grupoId, dia, fuso],
  );

  return {
    texto: rows.map((r) => `${r.hora} ${r.autor}: ${r.conteudo}`).join('\n'),
    mensagens: rows.length,
    autores: new Set(rows.map((r) => r.autor)).size,
  };
}

export async function resumirDia(
  db: DB,
  provider: AIProvider,
  grupoId: number,
  dia: string,
  fuso: string = FUSO,
): Promise<ResumoDia> {
  const { texto, mensagens, autores } = await textoDoDia(db, grupoId, dia, fuso);

  if (!mensagens) {
    return {
      grupo_id: grupoId, dia, mensagens: 0, autores: 0,
      resumo: 'Sem mensagens neste dia.', tokens_entrada: 0, usd_estimado: 0,
    };
  }

  const resumo = await provider.summarize(
    `Conversa do dia ${dia}:\n\n${texto}`,
    PROMPT_RESUMO,
  );

  const tokens = estimarTokens(texto);
  const p = PRECOS['gpt-4o-mini'];
  return {
    grupo_id: grupoId, dia, mensagens, autores, resumo,
    tokens_entrada: tokens,
    usd_estimado: (tokens / 1_000_000) * p.entradaPorMilhao,
  };
}

/**
 * Cache em `config`-style: guarda o resumo pronto e só regenera quando o dia
 * recebeu mensagem nova. Sem isto, abrir a tela do mesmo dia dez vezes custaria
 * dez chamadas de modelo pelo mesmo resultado.
 */
export async function resumirDiaComCache(
  db: DB,
  provider: AIProvider,
  grupoId: number,
  dia: string,
): Promise<ResumoDia & { doCache: boolean }> {
  await db.query(`
    create table if not exists resumos_dia (
      grupo_id   bigint not null references grupos(id) on delete cascade,
      dia        date   not null,
      resumo     text   not null,
      mensagens  integer not null,
      autores    integer not null,
      -- assinatura do conteúdo: muda quando chega mensagem nova naquele dia
      assinatura text   not null,
      modelo     text,
      criado_em  timestamptz not null default now(),
      primary key (grupo_id, dia)
    )`);

  const { rows: [atual] } = await db.query<{ assinatura: string; mensagens: number }>(
    `select md5(coalesce(string_agg(m.hash_mensagem, '' order by m.id), '')) as assinatura,
            count(*)::int as mensagens
       from mensagens m
      where m.grupo_id = $1
        and (m.enviada_em at time zone $3)::date = $2::date`,
    [grupoId, dia, FUSO],
  );

  const { rows: [cache] } = await db.query<{ resumo: string; mensagens: number; autores: number }>(
    `select resumo, mensagens, autores from resumos_dia
      where grupo_id = $1 and dia = $2::date and assinatura = $3`,
    [grupoId, dia, atual.assinatura],
  );

  if (cache) {
    return {
      grupo_id: grupoId, dia, ...cache,
      tokens_entrada: 0, usd_estimado: 0, doCache: true,
    };
  }

  const novo = await resumirDia(db, provider, grupoId, dia);
  await db.query(
    `insert into resumos_dia (grupo_id, dia, resumo, mensagens, autores, assinatura, modelo)
     values ($1,$2::date,$3,$4,$5,$6,$7)
     on conflict (grupo_id, dia) do update
       set resumo = excluded.resumo, mensagens = excluded.mensagens,
           autores = excluded.autores, assinatura = excluded.assinatura,
           modelo = excluded.modelo, criado_em = now()`,
    [grupoId, dia, novo.resumo, novo.mensagens, novo.autores, atual.assinatura, provider.nome],
  );
  return { ...novo, doCache: false };
}
