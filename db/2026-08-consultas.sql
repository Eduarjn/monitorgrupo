-- ============================================================================
-- Consultas salvas — cards de um clique (18/08/2026)
--
-- Duas naturezas, e a distincao e o coracao do desenho:
--
--   'metrica'  -> responde por SQL puro (api/stats/queries.ts). Numero e
--                 grafico sao dado REAL, instantaneo e sem custo de IA.
--   'pergunta' -> responde por RAG + IA, com citacao das fontes.
--   'mista'    -> grafico do SQL + leitura da IA sobre o mesmo periodo.
--
-- Por que nao deixar a IA devolver os dados do grafico: ela geraria numeros
-- plausiveis e errados. Num painel de gestao isso e pior que nao ter grafico.
-- ============================================================================

create table if not exists consultas (
  id          bigint generated always as identity primary key,
  -- null = disponivel em todos os grupos que o usuario acessa
  grupo_id    bigint references grupos(id) on delete cascade,

  titulo      text not null,
  descricao   text,
  -- o que o card faz, em uma linha, para o usuario saber antes de clicar
  natureza    text not null default 'pergunta'
              check (natureza in ('metrica', 'pergunta', 'mista')),

  -- para 'metrica' e 'mista': qual estatistica em SQL alimenta o grafico
  metrica     text check (metrica in ('volume_autor', 'volume_dia', 'horario_pico',
                                      'ranking', 'mencoes')),
  -- termo da metrica 'mencoes'
  parametro   text,

  -- para 'pergunta' e 'mista': o prompt que vai para a IA
  pergunta    text,

  -- como desenhar. 'auto' deixa a natureza decidir.
  visual      text not null default 'auto'
              check (visual in ('auto', 'numero', 'barra', 'linha', 'pizza', 'tabela', 'texto')),

  -- janela padrao em dias (null = todo o historico)
  dias        integer,

  icone       text not null default 'sparkles',
  ordem       integer not null default 100,
  ativa       boolean not null default true,

  criado_por  uuid,
  criado_em   timestamptz not null default now(),
  -- telemetria de uso: card que ninguem clica e card que deve sair do painel
  execucoes   integer not null default 0,
  ultimo_uso_em timestamptz
);

create index if not exists idx_consultas_grupo
  on consultas (coalesce(grupo_id, 0), ordem) where ativa;

comment on column consultas.natureza is
  'metrica = SQL (dado real); pergunta = IA com citacao; mista = grafico do SQL + leitura da IA.';


-- ---------------------------------------------------------------------------
-- Cards padrao: valem para todos os grupos (grupo_id null) e sao o ponto de
-- partida. O usuario edita, desativa ou cria os proprios.
-- ---------------------------------------------------------------------------
insert into consultas (grupo_id, titulo, descricao, natureza, metrica, pergunta, visual, dias, icone, ordem)
select * from (values
  (null::bigint, 'Quem mais falou',
   'Ranking de participacao no periodo. Dado direto do banco, sem IA.',
   'metrica', 'ranking', null::text, 'barra', 30, 'users', 10),

  (null::bigint, 'Volume por dia',
   'Como o movimento do grupo variou. Serve para achar picos e silencios.',
   'metrica', 'volume_dia', null::text, 'linha', 30, 'activity', 20),

  (null::bigint, 'Horario de pico',
   'Em que horas a conversa acontece. Util para dimensionar plantao.',
   'metrica', 'horario_pico', null::text, 'barra', 30, 'clock', 30),

  (null::bigint, 'O que ficou pendente',
   'Compromissos assumidos no grupo que ninguem fechou.',
   'pergunta', null::text,
   'Liste os compromissos que alguem assumiu no grupo e que ainda nao foram concluidos. Para cada um: o que e, de quem e, e desde quando esta em aberto. Se nao houver nenhum, diga isso.',
   'texto', 14, 'check-square', 40),

  (null::bigint, 'Dores do cliente',
   'Reclamacoes e dificuldades relatadas, agrupadas por tema.',
   'pergunta', null::text,
   'Quais problemas, reclamacoes ou dificuldades foram relatados? Agrupe por tema e diga quem relatou cada um. Nao invente: use apenas o que esta no historico.',
   'texto', 30, 'alert-triangle', 50),

  (null::bigint, 'Quem chamou e nao teve resposta',
   'Mencoes diretas que ficaram sem retorno.',
   'pergunta', null::text,
   'Identifique mensagens em que alguem foi chamado ou cobrado diretamente e nao houve resposta em seguida. Diga quem chamou, quem foi chamado e sobre o que.',
   'texto', 7, 'message-square', 60),

  (null::bigint, 'Decisoes tomadas',
   'O que foi decidido, por quem, e quando.',
   'pergunta', null::text,
   'Liste as decisoes tomadas no grupo: o que foi decidido, quem decidiu e em que data. Se algo ficou sem decisao clara, diga.',
   'texto', 30, 'gavel', 70)
) as novos(grupo_id, titulo, descricao, natureza, metrica, pergunta, visual, dias, icone, ordem)
where not exists (select 1 from consultas where grupo_id is null);


-- RLS: consulta global e visivel a todos; consulta de grupo, so a quem acessa.
alter table consultas enable row level security;

do $$ begin
  execute 'drop policy if exists consultas_leitura on consultas';
  execute 'create policy consultas_leitura on consultas for select to authenticated
             using (grupo_id is null or exists (
               select 1 from grupo_acessos a
                where a.grupo_id = consultas.grupo_id and a.user_id = auth.uid()))';
end $$;

grant select on consultas to authenticated;
