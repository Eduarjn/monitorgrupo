/**
 * Saúde da coleta — o painel que responde "quais grupos estão atrasados".
 *
 * Tudo em SQL, sem IA: é contagem de dias, não interpretação. Mesmo princípio
 * da Fase 3.
 *
 * A régua é `proxima_coleta_em`. Ela é recalculada a cada upload concluído a
 * partir de `frequencia_coleta` — antes desta fase a coluna existia no schema e
 * nunca era escrita, então nada nunca ficou "atrasado".
 */

import type { DB } from '../stats/queries.ts';

export type FrequenciaColeta = 'diaria' | 'semanal' | 'manual';

export interface SaudeColeta {
  grupo_id: number;
  nome: string;
  frequencia_coleta: FrequenciaColeta;
  ultima_coleta_em: string | null;
  proxima_coleta_em: string | null;
  dias_sem_coleta: number | null;
  atrasado: boolean;
  /** Nunca coletado. Diferente de atrasado: não há régua para comparar. */
  nunca_coletado: boolean;
  lembrete_ativo: boolean;
  lembrete_destino: string | null;
  lembrete_enviado_em: string | null;
  consentimento_ok: boolean;
  mensagens: number;
}

const DIAS: Record<FrequenciaColeta, number | null> = {
  diaria: 1,
  semanal: 7,
  manual: null,      // sem cadência: nunca fica atrasado
};

/**
 * Próxima coleta a partir de uma base. `manual` devolve null de propósito: o
 * grupo sai do painel de cobrança em vez de ficar eternamente vermelho.
 */
export function proximaColeta(freq: FrequenciaColeta, base: Date): Date | null {
  const dias = DIAS[freq];
  if (dias == null) return null;
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
}

/**
 * Saúde de todos os grupos que o usuário enxerga.
 *
 * O filtro por `grupo_acessos` é o mesmo do resto da API: esta rota não pode
 * revelar a existência de um grupo que o usuário não acessa.
 */
export async function getSaudeColeta(db: DB, userId: string): Promise<SaudeColeta[]> {
  const { rows } = await db.query<SaudeColeta>(
    // ::int porque o driver do Postgres devolve bigint como STRING, para não
    // perder precisão. Sem o cast, comparar com o id numérico do seletor de
    // grupo falha em silêncio ("1" === 1 é falso) e a tela some.
    `select g.id::int as grupo_id,
            g.nome,
            g.frequencia_coleta,
            g.ultima_coleta_em,
            g.proxima_coleta_em,
            g.lembrete_ativo,
            g.lembrete_destino,
            g.lembrete_enviado_em,
            -- floor: "coletado há 26h" é 1 dia, não 2
            case when g.ultima_coleta_em is null then null
                 else floor(extract(epoch from (now() - g.ultima_coleta_em)) / 86400)::int
            end as dias_sem_coleta,
            (g.proxima_coleta_em is not null and g.proxima_coleta_em < now()) as atrasado,
            (g.ultima_coleta_em is null) as nunca_coletado,
            consentimento_vigente(g.id) as consentimento_ok,
            (select count(*) from mensagens m where m.grupo_id = g.id)::int as mensagens
       from grupos g
       join grupo_acessos a on a.grupo_id = g.id and a.user_id = $1
      where g.ativo
      order by (g.proxima_coleta_em is not null and g.proxima_coleta_em < now()) desc,
               g.proxima_coleta_em asc nulls last,
               g.nome`,
    [userId],
  );
  return rows;
}

/**
 * Grupos que devem receber lembrete agora. Usado pela rotina agendada.
 *
 * Três travas, todas necessárias:
 *  - `lembrete_ativo` e destino preenchido — configuração completa;
 *  - `consentimento_vigente` — a D7 exige aviso registrado antes de automatizar;
 *  - `lembrete_enviado_em` — não repete a cobrança no mesmo ciclo, senão a
 *    rotina vira spam a cada execução.
 */
export async function getGruposParaLembrar(db: DB): Promise<
  Array<{ grupo_id: number; nome: string; destino: string; dias_sem_coleta: number | null }>
> {
  const { rows } = await db.query(
    `select g.id::int as grupo_id, g.nome, g.lembrete_destino as destino,
            case when g.ultima_coleta_em is null then null
                 else floor(extract(epoch from (now() - g.ultima_coleta_em)) / 86400)::int
            end as dias_sem_coleta
       from grupos g
      where g.ativo
        and g.lembrete_ativo
        and g.lembrete_destino is not null and g.lembrete_destino <> ''
        and g.proxima_coleta_em is not null
        and g.proxima_coleta_em < now()
        and consentimento_vigente(g.id)
        and (g.lembrete_enviado_em is null or g.lembrete_enviado_em < g.proxima_coleta_em)
      order by g.proxima_coleta_em`,
  );
  return rows as Array<{ grupo_id: number; nome: string; destino: string; dias_sem_coleta: number | null }>;
}

/** Telefone só com dígitos, com 55 na frente. É o formato que o Calliope aceita. */
export function normalizarDestino(bruto: string): string | null {
  const d = String(bruto ?? '').replace(/\D/g, '');
  if (!d) return null;
  const comDdi = d.startsWith('55') ? d : '55' + d;
  // 55 + DDD(2) + número(8 ou 9)
  if (comDdi.length < 12 || comDdi.length > 13) return null;
  return comDdi;
}
