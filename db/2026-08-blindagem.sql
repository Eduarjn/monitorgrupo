-- ============================================================================
-- Blindagem — achados da revisão de segurança (18/08/2026)
--
-- Origem: revisão adversarial em cinco superfícies (HTTP público, autorização,
-- injeção de prompt, segredos, infra/LGPD), com verificação cética de cada
-- achado contra o código real. 25 confirmados de 47 brutos.
--
-- Idempotente.
-- ============================================================================

-- ===========================================================================
-- 1. TABELAS QUE FICARAM SEM RLS
-- ---------------------------------------------------------------------------
-- `rls-policies.sql` termina com um GRANT COLETIVO em todas as tabelas do
-- schema public para `authenticated`. Toda tabela criada depois herda esse
-- grant e, sem RLS, fica legível por qualquer usuário autenticado — inclusive
-- de outros grupos.
--
-- Três escaparam nas migrações anteriores, e as três guardam dado de pessoa:
--   wa_identidades  -> telefone real do participante (o mais sensível)
--   wa_lacunas      -> janelas sem captura (operacional, mas revela o grupo)
--   wa_uso_ia       -> consumo por grupo
--   resumos_dia     -> texto de resumo por grupo
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['wa_identidades', 'wa_lacunas', 'wa_uso_ia', 'resumos_dia']
  loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = t) then
      execute format('alter table %I enable row level security', t);
      execute format('revoke all on %I from authenticated, anon', t);
    end if;
  end loop;
end $$;

-- wa_identidades guarda telefone e não tem grupo_id: não há como filtrar por
-- acesso. Fica fechada — só o backend (credencial de serviço) a enxerga.
comment on table wa_identidades is
  'Telefone real do participante. SEM grant para authenticated: so o backend le.';

-- As que têm grupo_id podem ser lidas por quem acessa o grupo.
do $$ begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='wa_uso_ia') then
    execute 'drop policy if exists uso_ia_leitura on wa_uso_ia';
    execute 'create policy uso_ia_leitura on wa_uso_ia for select to authenticated
               using (exists (select 1 from grupo_acessos a
                               where a.grupo_id = wa_uso_ia.grupo_id and a.user_id = auth.uid()))';
    execute 'grant select on wa_uso_ia to authenticated';
  end if;
  if exists (select 1 from pg_tables where schemaname='public' and tablename='resumos_dia') then
    execute 'drop policy if exists resumos_leitura on resumos_dia';
    execute 'create policy resumos_leitura on resumos_dia for select to authenticated
               using (exists (select 1 from grupo_acessos a
                               where a.grupo_id = resumos_dia.grupo_id and a.user_id = auth.uid()))';
    execute 'grant select on resumos_dia to authenticated';
  end if;
end $$;


-- ===========================================================================
-- 2. TABELA MORTA COM COLUNA DE CONTEÚDO
-- ---------------------------------------------------------------------------
-- `wa_webhook_eventos` foi criada para durabilidade, mas o desenho final ficou
-- com ingestão SÍNCRONA — nenhum código escreve nela. Sobrou uma tabela vazia
-- com uma coluna `payload jsonb` pronta para receber conteúdo de terceiro sem
-- política de retenção. Superfície sem dono é superfície esquecida.
-- ===========================================================================
drop table if exists wa_webhook_eventos;


-- ===========================================================================
-- 3. RETENÇÃO — a tabela existia desde a Fase 1 e nada nunca apagou
-- ---------------------------------------------------------------------------
-- `politica_retencao` declarava 730 dias por grupo e nenhuma rotina lia isso.
-- Guardar mensagem de terceiro para sempre é difícil de justificar sob LGPD;
-- pior, era uma promessa escrita no schema e não cumprida.
--
-- A função abaixo é chamada uma vez por dia pela API. Apaga em cascata o que
-- deriva da mensagem, senão o texto sairia de `mensagens` e continuaria vivo
-- dentro de `blocos.texto`.
-- ===========================================================================
create or replace function expurgar_retencao()
returns table (grupo_id bigint, mensagens_apagadas bigint, blocos_apagados bigint)
language plpgsql as $$
declare
  g record;
  corte timestamptz;
  n_msg bigint;
  n_blk bigint;
begin
  for g in
    select gr.id, coalesce(pr.dias, 730) as dias
      from grupos gr left join politica_retencao pr on pr.grupo_id = gr.id
  loop
    corte := now() - make_interval(days => g.dias);

    -- Bloco primeiro: ele carrega o TEXTO das mensagens, então apagar só a
    -- mensagem deixaria o conteúdo vivo no acervo de embeddings.
    delete from blocos b where b.grupo_id = g.id and b.fim_em < corte;
    get diagnostics n_blk = row_count;

    delete from mensagens m where m.grupo_id = g.id and m.enviada_em < corte;
    get diagnostics n_msg = row_count;

    -- Análises e alertas da janela expirada perdem o sentido sem as mensagens.
    delete from wa_analises a where a.grupo_id = g.id and a.fim_em < corte;
    delete from wa_alertas  al where al.grupo_id = g.id and al.criado_em < corte;
    delete from resumos_dia r where r.grupo_id = g.id and r.dia < corte::date;

    if n_msg > 0 or n_blk > 0 then
      grupo_id := g.id; mensagens_apagadas := n_msg; blocos_apagados := n_blk;
      return next;
    end if;
  end loop;
end $$;

comment on function expurgar_retencao() is
  'Chamada 1x/dia pela API. Apaga mensagens, blocos, analises, alertas e resumos alem do prazo do grupo.';


-- ===========================================================================
-- 4. EXCLUSÃO POR TITULAR (LGPD art. 18)
-- ---------------------------------------------------------------------------
-- Não existia caminho para apagar os dados de UMA pessoa. Com a captura, o
-- telefone real passou a ser conhecido, então a identificação é possível — e
-- por isso a obrigação fica concreta.
--
-- Apaga tudo que é identificável daquela pessoa. Os blocos que a continham são
-- removidos (não editados): reescrever texto de bloco deixaria o embedding
-- correspondendo a um conteúdo que não existe mais.
-- ===========================================================================
create or replace function excluir_titular(p_pessoa_id bigint, p_grupo_id bigint default null)
returns table (mensagens bigint, blocos bigint, aliases bigint)
language plpgsql as $$
declare n_msg bigint; n_blk bigint; n_ali bigint; ids bigint[];
begin
  select array_agg(id) into ids from mensagens
   where pessoa_id = p_pessoa_id and (p_grupo_id is null or grupo_id = p_grupo_id);

  if ids is null then
    mensagens := 0; blocos := 0; aliases := 0; return next; return;
  end if;

  -- Bloco que cite qualquer mensagem da pessoa sai inteiro.
  delete from blocos b where b.mensagem_ids && ids;
  get diagnostics n_blk = row_count;

  delete from mensagens m where m.id = any(ids);
  get diagnostics n_msg = row_count;

  delete from pessoa_aliases pa where pa.pessoa_id = p_pessoa_id
     and (p_grupo_id is null or pa.grupo_id = p_grupo_id or pa.grupo_id is null);
  get diagnostics n_ali = row_count;

  -- Só remove a identidade e a pessoa quando a exclusão é global.
  if p_grupo_id is null then
    delete from wa_identidades wi where wi.pessoa_id = p_pessoa_id;
    delete from pessoas p where p.id = p_pessoa_id;
  end if;

  mensagens := n_msg; blocos := n_blk; aliases := n_ali;
  return next;
end $$;

comment on function excluir_titular(bigint, bigint) is
  'Direito de exclusao (LGPD art.18). grupo_id null = apaga em todos os grupos e remove a pessoa.';
