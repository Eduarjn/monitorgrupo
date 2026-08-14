-- ============================================================================
-- whatsapp-monitor — Fase 1: Row Level Security
--
-- Regra única do sistema: você só enxerga um grupo se existir uma linha sua em
-- `grupo_acessos`. Todas as outras tabelas herdam essa decisão.
--
-- ⚠️ LIMITE IMPORTANTE (risco 1.6): RLS só protege conexões que usam a chave
-- anon/authenticated. Se o backend Node conectar com `service_role` — que é o
-- normal para ingestão — o RLS é IGNORADO por completo. Ou seja:
--   • leitura do frontend  → protegida por estas políticas;
--   • rotas do backend     → a autorização é responsabilidade do código.
-- Não confie no RLS para proteger o que passa pelo backend.
-- ============================================================================

alter table grupos            enable row level security;
alter table grupo_acessos     enable row level security;
alter table pessoas           enable row level security;
alter table pessoa_aliases    enable row level security;
alter table uploads           enable row level security;
alter table mensagens         enable row level security;
alter table blocos            enable row level security;
alter table consentimentos    enable row level security;
alter table politica_retencao enable row level security;


-- ---------------------------------------------------------------------------
-- Helpers: concentram a regra num lugar só. Se a regra de acesso mudar, muda
-- aqui e todas as políticas acompanham.
-- `security definer` + `search_path` fixo evita que a função seja subvertida.
-- ---------------------------------------------------------------------------
create or replace function tem_acesso(g bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from grupo_acessos
     where grupo_id = g and user_id = auth.uid()
  )
$$;

create or replace function pode_gerir(g bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from grupo_acessos
     where grupo_id = g and user_id = auth.uid()
       and papel in ('gestor','admin')
  )
$$;


-- ===========================================================================
-- GRUPOS — vejo os grupos a que fui dado acesso; só gestor/admin altera.
-- ===========================================================================
drop policy if exists grupos_leitura on grupos;
create policy grupos_leitura on grupos
  for select using (tem_acesso(id));

drop policy if exists grupos_escrita on grupos;
create policy grupos_escrita on grupos
  for update using (pode_gerir(id)) with check (pode_gerir(id));


-- ===========================================================================
-- GRUPO_ACESSOS — cada um enxerga a própria linha; só admin do grupo distribui
-- acesso. Sem isso, um leitor poderia se promover a admin.
-- ===========================================================================
drop policy if exists acessos_leitura on grupo_acessos;
create policy acessos_leitura on grupo_acessos
  for select using (user_id = auth.uid() or pode_gerir(grupo_id));

drop policy if exists acessos_escrita on grupo_acessos;
create policy acessos_escrita on grupo_acessos
  for all using (
    exists (select 1 from grupo_acessos a
             where a.grupo_id = grupo_acessos.grupo_id
               and a.user_id = auth.uid() and a.papel = 'admin')
  ) with check (
    exists (select 1 from grupo_acessos a
             where a.grupo_id = grupo_acessos.grupo_id
               and a.user_id = auth.uid() and a.papel = 'admin')
  );


-- ===========================================================================
-- MENSAGENS — o dado mais sensível. Só leitura pelo frontend; a escrita é da
-- ingestão, que roda no backend com service_role.
-- ===========================================================================
drop policy if exists mensagens_leitura on mensagens;
create policy mensagens_leitura on mensagens
  for select using (tem_acesso(grupo_id));

-- exclusão para atender pedido de remoção de um titular (LGPD)
drop policy if exists mensagens_exclusao on mensagens;
create policy mensagens_exclusao on mensagens
  for delete using (pode_gerir(grupo_id));


-- ===========================================================================
-- UPLOADS / BLOCOS / RETENÇÃO — acompanham o acesso ao grupo.
-- ===========================================================================
drop policy if exists uploads_leitura on uploads;
create policy uploads_leitura on uploads
  for select using (tem_acesso(grupo_id));

drop policy if exists blocos_leitura on blocos;
create policy blocos_leitura on blocos
  for select using (tem_acesso(grupo_id));

drop policy if exists retencao_leitura on politica_retencao;
create policy retencao_leitura on politica_retencao
  for select using (tem_acesso(grupo_id));

drop policy if exists retencao_escrita on politica_retencao;
create policy retencao_escrita on politica_retencao
  for all using (pode_gerir(grupo_id)) with check (pode_gerir(grupo_id));


-- ===========================================================================
-- CONSENTIMENTOS — todo mundo com acesso pode ver o que foi consentido
-- (transparência); só gestor registra ou revoga.
-- ===========================================================================
drop policy if exists consent_leitura on consentimentos;
create policy consent_leitura on consentimentos
  for select using (tem_acesso(grupo_id));

drop policy if exists consent_escrita on consentimentos;
create policy consent_escrita on consentimentos
  for all using (pode_gerir(grupo_id)) with check (pode_gerir(grupo_id));


-- ===========================================================================
-- PESSOAS / ALIASES — não têm grupo_id próprio: uma pessoa pode estar em vários
-- grupos. A regra é "vejo a pessoa se ela aparece em algum grupo meu".
--
-- Custo: este EXISTS roda por linha. Aceitável porque a lista de pessoas é
-- pequena (dezenas), ao contrário de mensagens (centenas de milhares).
-- ===========================================================================
drop policy if exists pessoas_leitura on pessoas;
create policy pessoas_leitura on pessoas
  for select using (
    exists (
      select 1 from mensagens m
       where m.pessoa_id = pessoas.id and tem_acesso(m.grupo_id)
      limit 1
    )
    or exists (
      select 1 from pessoa_aliases pa
       where pa.pessoa_id = pessoas.id
         and pa.grupo_id is not null and tem_acesso(pa.grupo_id)
      limit 1
    )
  );

drop policy if exists aliases_leitura on pessoa_aliases;
create policy aliases_leitura on pessoa_aliases
  for select using (grupo_id is null or tem_acesso(grupo_id));

-- conciliação de identidade (juntar "João" e "João Silva") é ação de gestor
drop policy if exists aliases_escrita on pessoa_aliases;
create policy aliases_escrita on pessoa_aliases
  for all using (grupo_id is not null and pode_gerir(grupo_id))
      with check (grupo_id is not null and pode_gerir(grupo_id));


-- ---------------------------------------------------------------------------
-- Permissões de tabela. O RLS só entra em cena depois do GRANT — sem isto o
-- PostgREST devolve "permission denied" antes de avaliar qualquer política.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to authenticated;
grant delete on mensagens to authenticated;
grant insert, update, delete on pessoa_aliases, consentimentos, politica_retencao to authenticated;
grant update on grupos to authenticated;
grant insert, update, delete on grupo_acessos to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- `anon` (não logado) não enxerga nada: sem GRANT, sem acesso.
