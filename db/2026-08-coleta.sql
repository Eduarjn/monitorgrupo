-- ============================================================================
-- Opção A — coleta assistida (14/08/2026)
--
-- Contexto: não existe caminho oficial para ler mensagens de grupo (D7). O que
-- dá para automatizar é tudo em volta do clique de exportar: lembrar, cobrar,
-- processar e resumir. Esta migração cria o que falta para isso, mais o gate de
-- consentimento que a Fase 1 deixou apenas documental.
--
-- Idempotente: pode rodar mais de uma vez.
-- ============================================================================

-- ===========================================================================
-- 1. GATE DE CONSENTIMENTO
-- ---------------------------------------------------------------------------
-- Até aqui `consentimentos` era só registro: nenhum ponto da ingestão o
-- consultava e `revogado_em` não tinha caminho de escrita. Agora é uma trava.
--
-- Semântica adotada: vigente = existe pelo menos um aviso do grupo sem
-- revogação. O consentimento é modelado por pessoa (`pessoa_id`), mas o aviso
-- de grupo é registrado sem pessoa — então o gate é por GRUPO, e revogar um
-- titular específico não desliga a coleta do grupo inteiro. Está assim de
-- propósito; mudar isso exige decidir o que fazer com a mensagem de quem
-- revogou (apagar? anonimizar?), que é outra discussão.
-- ===========================================================================
create index if not exists idx_consentimentos_vigentes
  on consentimentos (grupo_id) where revogado_em is null;

create or replace function consentimento_vigente(g bigint) returns boolean
language sql stable as $$
  select exists (
    select 1 from consentimentos
     where grupo_id = g and revogado_em is null
  )
$$;

comment on function consentimento_vigente(bigint) is
  'Gate da LGPD: falso bloqueia a coleta automática do grupo. Ver D7.';


-- ===========================================================================
-- 2. PAPEL GLOBAL DO USUÁRIO
-- ---------------------------------------------------------------------------
-- `grupo_acessos` resolve autorização POR GRUPO, mas a conexão de aviso é dado
-- de conta, não de grupo: sem isto, qualquer usuário logado poderia trocar o
-- token do canal comercial da ERA. `usuarios` nasce em auth.ts, por isso o
-- `if exists`.
-- ===========================================================================
alter table if exists usuarios
  add column if not exists papel_global text not null default 'usuario'
  check (papel_global in ('usuario', 'admin'));


-- ===========================================================================
-- 3. CONEXÕES DE AVISO
-- ---------------------------------------------------------------------------
-- Canal por onde o painel FALA com a equipe (lembrete de coleta). Não é canal
-- de leitura — ler grupo por API não existe, oficial ou não-oficialmente
-- aceitável (D7).
--
-- `provedor` é enum fechado. 'calliope' é o Omnichannel que a ERA já opera, com
-- API de template em produção. 'cloud_api' fica previsto para o dia em que o
-- Embedded Signup for aprovado; nenhum valor de biblioteca não oficial existe
-- aqui, e isso é intencional.
--
-- O token NUNCA fica em texto: AES-256-GCM, com IV e tag ao lado e a versão da
-- chave que o cifrou, para permitir rotação sem perder o que já existe.
-- ===========================================================================
create table if not exists conexoes (
  id       bigint generated always as identity primary key,
  rotulo   text not null,
  provedor text not null default 'calliope'
           check (provedor in ('calliope', 'cloud_api')),

  -- destino da API e identificação do remetente no Omnichannel
  endpoint  text,
  remetente text,                       -- agent / attendance_id do Calliope
  config    jsonb not null default '{}', -- nome do template, idioma, etc.

  status text not null default 'desconectado'
         check (status in ('desconectado', 'conectado', 'erro')),

  erro_codigo   text,
  erro_mensagem text,
  erro_em       timestamptz,

  -- segredo em repouso
  token_cifrado bytea,
  token_iv      bytea,
  token_tag     bytea,
  token_versao  smallint not null default 1,

  ultima_verificacao_em timestamptz,
  ultimo_uso_em         timestamptz,

  criado_por    uuid,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

comment on column conexoes.token_cifrado is
  'AES-256-GCM. Nenhuma rota da API devolve esta coluna — nem mascarada.';

create table if not exists conexao_eventos (
  id         bigint generated always as identity primary key,
  conexao_id bigint not null references conexoes(id) on delete cascade,
  tipo       text not null,   -- criada | token_trocado | testada | erro | removida
  -- NUNCA gravar token, senha ou corpo bruto de resposta aqui.
  detalhe    jsonb not null default '{}',
  criado_em  timestamptz not null default now()
);

create index if not exists idx_conexao_eventos
  on conexao_eventos (conexao_id, criado_em desc);


-- ===========================================================================
-- 4. LEMBRETE DE COLETA (fecha a D3)
-- ---------------------------------------------------------------------------
-- `grupos` já tinha frequencia_coleta / ultima_coleta_em / proxima_coleta_em
-- desde a Fase 1, e nada nunca escreveu em proxima_coleta_em. Estas colunas
-- completam o que faltava para o lembrete sair.
-- ===========================================================================
alter table grupos add column if not exists lembrete_ativo   boolean not null default false;
alter table grupos add column if not exists lembrete_destino text;      -- E.164, ex: 5519935010887
alter table grupos add column if not exists lembrete_enviado_em timestamptz;

comment on column grupos.lembrete_destino is
  'Quem recebe a cobrança de coleta. Vazio com lembrete_ativo=true é configuração incompleta.';

create table if not exists lembretes_enviados (
  id         bigint generated always as identity primary key,
  grupo_id   bigint not null references grupos(id) on delete cascade,
  conexao_id bigint references conexoes(id) on delete set null,
  destino    text not null,
  status     text not null check (status in ('enviado', 'erro')),
  erro       text,
  -- só metadado da resposta (id, código). Corpo cru pode conter token no eco.
  detalhe    jsonb not null default '{}',
  criado_em  timestamptz not null default now()
);

create index if not exists idx_lembretes_grupo
  on lembretes_enviados (grupo_id, criado_em desc);


-- ===========================================================================
-- 5. RLS DAS TABELAS NOVAS
-- ---------------------------------------------------------------------------
-- ⚠️ `rls-policies.sql` termina com um GRANT COLETIVO em todas as tabelas do
-- schema public para `authenticated`. Reaplicá-lo daria a um leitor SELECT em
-- `conexoes` — inclusive na coluna do token. O revoke abaixo tem que vir DEPOIS
-- daquele grant, e precisa ser repetido toda vez que o rls-policies rodar.
-- ===========================================================================
alter table conexoes           enable row level security;
alter table conexao_eventos    enable row level security;
alter table lembretes_enviados enable row level security;

revoke all on conexoes        from authenticated, anon;
revoke all on conexao_eventos from authenticated, anon;

-- Lembrete enviado é histórico operacional do grupo: quem lê o grupo pode ver.
drop policy if exists lembretes_leitura on lembretes_enviados;
create policy lembretes_leitura on lembretes_enviados
  for select to authenticated
  using (exists (select 1 from grupo_acessos a
                  where a.grupo_id = lembretes_enviados.grupo_id
                    and a.user_id = auth.uid()));

grant select on lembretes_enviados to authenticated;
