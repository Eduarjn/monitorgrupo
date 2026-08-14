-- ============================================================================
-- whatsapp-monitor — Fase 1: modelo de dados
--
-- Roda num banco PRÓPRIO (não no banco do EraLearn), pelo mesmo motivo do
-- ERAREASON: o EraLearn já tem `usuarios` no schema public e misturar os dois
-- quebraria o login dele.
--
-- Cada decisão de schema está comentada acima da tabela correspondente.
-- ============================================================================

create extension if not exists vector;      -- busca semântica (Fase 5)
create extension if not exists pg_trgm;     -- busca por trecho parecido em nomes
create extension if not exists unaccent;    -- "joao" achar "João"

-- ---------------------------------------------------------------------------
-- auth.uid(): num banco separado o schema `auth` do Supabase não existe, então
-- recriamos só a função que o RLS usa. Ela lê o `sub` do JWT que o PostgREST
-- coloca no GUC da conexão — mesmo comportamento do Supabase hospedado.
-- Assim as políticas de RLS ficam idênticas às de um projeto Supabase normal.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', 'anon')
$$;


-- ===========================================================================
-- GRUPOS
-- ---------------------------------------------------------------------------
-- Um registro por grupo de WhatsApp monitorado.
--
-- `frequencia_coleta` e `proxima_coleta_em` existem por causa da decisão D3: o
-- painel não dispara o export (isso é um clique no celular), mas agenda o
-- LEMBRETE e cobra quem atrasou. Guardar isso aqui é o que alimenta o painel de
-- saúde da coleta.
-- ===========================================================================
create table if not exists grupos (
  id                bigint generated always as identity primary key,
  nome              text not null,
  descricao         text,
  ativo             boolean not null default true,

  -- cadência da coleta (D3). 'semanal' é o padrão recomendado.
  frequencia_coleta text not null default 'semanal'
                    check (frequencia_coleta in ('diaria','semanal','manual')),
  ultima_coleta_em  timestamptz,
  proxima_coleta_em timestamptz,

  criado_em         timestamptz not null default now(),
  criado_por        uuid
);

comment on column grupos.ultima_coleta_em is
  'Preenchido ao processar um upload com sucesso; é o que permite avisar "3 grupos sem coleta há X dias".';


-- ===========================================================================
-- ACESSO AO GRUPO  (base de todo o RLS)
-- ---------------------------------------------------------------------------
-- O controle de acesso é POR GRUPO, não global: alguém pode ler o grupo
-- Comercial e não enxergar o Financeiro. Toda política de RLS das outras
-- tabelas se resolve olhando para cá.
--
-- `papel` separa quem só lê de quem administra. Consentimento e exclusão de
-- dados ficam restritos a 'gestor'/'admin'.
-- ===========================================================================
create table if not exists grupo_acessos (
  grupo_id   bigint not null references grupos(id) on delete cascade,
  user_id    uuid   not null,
  papel      text   not null default 'leitor'
             check (papel in ('leitor','gestor','admin')),
  criado_em  timestamptz not null default now(),
  primary key (grupo_id, user_id)
);

create index if not exists idx_grupo_acessos_user on grupo_acessos (user_id);


-- ===========================================================================
-- PESSOAS + ALIASES
-- ---------------------------------------------------------------------------
-- Risco 1.3: o autor no export vem como está na AGENDA de quem exportou —
-- "João", "João Silva" ou "+55 19 99999-9999". A mesma pessoa aparece diferente
-- em exports de celulares diferentes. Sem isso, "quantas vezes me citaram" e o
-- ranking de participantes ficam errados.
--
-- Por isso a identidade fica em `pessoas` e as grafias em `pessoa_aliases`.
-- O parser grava o texto cru em `mensagens.autor_raw` e a conciliação (manual ou
-- automática) preenche `mensagens.pessoa_id` depois — nessa ordem, para que uma
-- conciliação errada nunca destrua o dado original.
-- ===========================================================================
create table if not exists pessoas (
  id            bigint generated always as identity primary key,
  nome_exibicao text not null,
  telefone_e164 text,
  observacao    text,
  criado_em     timestamptz not null default now()
);

create unique index if not exists idx_pessoas_telefone
  on pessoas (telefone_e164) where telefone_e164 is not null;

create table if not exists pessoa_aliases (
  id        bigint generated always as identity primary key,
  pessoa_id bigint not null references pessoas(id) on delete cascade,
  -- a grafia exatamente como sai no export
  alias     text   not null,
  -- alias pode ser específico de um grupo (mesmo apelido, pessoas diferentes)
  grupo_id  bigint references grupos(id) on delete cascade,
  criado_em timestamptz not null default now()
);

-- `coalesce(grupo_id,0)` porque NULL não colide com NULL em índice único, e
-- queremos que "alias global" seja único de verdade.
create unique index if not exists idx_alias_unico
  on pessoa_aliases (lower(alias), coalesce(grupo_id, 0));

create index if not exists idx_alias_trgm
  on pessoa_aliases using gin (alias gin_trgm_ops);


-- ===========================================================================
-- UPLOADS
-- ---------------------------------------------------------------------------
-- Um registro por arquivo de export recebido.
--
-- Risco 1.1 (o mais perigoso): o export NÃO informa fuso nem formato de data.
-- "03/08/2026" pode ser 3 de agosto ou 8 de março, dependendo do idioma do
-- celular de quem exportou — e o erro é silencioso, desloca o histórico inteiro
-- sem gerar exceção. Por isso o formato detectado (ou confirmado pelo usuário)
-- fica REGISTRADO aqui, junto do upload que o originou.
--
-- `arquivo_hash` evita reprocessar o mesmo arquivo. Não confundir com o dedup
-- por mensagem (D3): como o WhatsApp exporta a conversa inteira toda vez, o
-- hash do arquivo sozinho não impede duplicar o histórico.
-- ===========================================================================
create table if not exists uploads (
  id                  bigint generated always as identity primary key,
  grupo_id            bigint not null references grupos(id) on delete cascade,

  arquivo_nome        text not null,
  arquivo_hash        text not null,           -- sha256 do conteúdo
  tamanho_bytes       bigint,

  -- o que o parser detectou (ou o que o usuário confirmou na tela de upload)
  plataforma          text check (plataforma in ('ios','android','desconhecida')),
  idioma              text,                     -- 'pt','en',...
  formato_data        text check (formato_data in ('DMY','MDY')),
  fuso                text not null default 'America/Sao_Paulo',
  formato_confirmado  boolean not null default false,  -- true = usuário confirmou

  -- resultado do processamento
  status              text not null default 'pendente'
                      check (status in ('pendente','processando','concluido','erro')),
  erro                text,
  linhas_lidas        integer,
  mensagens_novas     integer,
  mensagens_repetidas integer,

  enviado_por         uuid,
  criado_em           timestamptz not null default now(),
  processado_em       timestamptz
);

create unique index if not exists idx_uploads_hash on uploads (arquivo_hash);
create index if not exists idx_uploads_grupo on uploads (grupo_id, criado_em desc);


-- ===========================================================================
-- MENSAGENS
-- ---------------------------------------------------------------------------
-- O coração. Uma linha por mensagem real do grupo.
--
-- `hash_mensagem` + índice único por grupo é o que implementa a decisão D3: o
-- WhatsApp exporta a conversa INTEIRA a cada coleta, então a segunda coleta
-- traria todo o passado de novo. O hash (grupo+timestamp+autor+conteúdo) faz o
-- insert repetido virar um no-op barato via ON CONFLICT DO NOTHING.
--
-- `tipo` já prevê 'audio_transcrito' mesmo com o áudio fora do escopo inicial
-- (D1) — plugar a Fase 4 depois não vai exigir migração.
--
-- `midia_arquivo` guarda o nome do arquivo citado na linha (risco 1.2). É o
-- parser que extrai isso, não a fase de áudio; sem ele não há como saber de quem
-- é a transcrição.
--
-- `busca` é uma coluna gerada com o tsvector em português: é ela que faz a
-- Fase 3 ("quantas vezes me citaram") rodar em SQL puro, sem IA.
-- ===========================================================================
create table if not exists mensagens (
  id            bigint generated always as identity primary key,
  grupo_id      bigint not null references grupos(id) on delete cascade,
  -- upload em que a mensagem apareceu pela PRIMEIRA vez (auditoria de origem)
  upload_id     bigint references uploads(id) on delete set null,

  -- identidade: cru primeiro, conciliado depois
  autor_raw     text,
  pessoa_id     bigint references pessoas(id) on delete set null,

  enviada_em    timestamptz not null,
  conteudo      text not null default '',

  tipo          text not null default 'texto'
                check (tipo in ('texto','audio_transcrito','midia','sistema')),
  midia_arquivo text,

  hash_mensagem text not null,
  criado_em     timestamptz not null default now(),

  busca tsvector generated always as
        (to_tsvector('portuguese', coalesce(conteudo, ''))) stored
);

-- dedup por mensagem (D3) — é este índice que torna a recoleta barata
create unique index if not exists idx_mensagens_dedup
  on mensagens (grupo_id, hash_mensagem);

-- linha do tempo: usado por resumo do dia, volume por dia e horário de pico
create index if not exists idx_mensagens_grupo_data
  on mensagens (grupo_id, enviada_em desc);

-- ranking por participante
create index if not exists idx_mensagens_pessoa
  on mensagens (pessoa_id) where pessoa_id is not null;

-- busca textual (Fase 3, sem IA)
create index if not exists idx_mensagens_busca
  on mensagens using gin (busca);

-- as estatísticas quase sempre excluem mensagens de sistema; índice parcial
-- deixa essas contagens mais baratas
create index if not exists idx_mensagens_reais
  on mensagens (grupo_id, enviada_em) where tipo <> 'sistema';


-- ===========================================================================
-- BLOCOS  (unidade de embedding — NÃO a mensagem)
-- ---------------------------------------------------------------------------
-- Risco 1.5: mensagem de WhatsApp é curtíssima ("ok", "kkkk", "manda aí").
-- Vetorizar cada uma isolada faz a busca recuperar fragmento sem sentido, e o
-- RAG responde mal mesmo "funcionando".
--
-- Por isso o embedding vive num bloco = janela de conversa (proximidade de
-- tempo / nº de mensagens). `mensagem_ids` preserva a origem para que a resposta
-- possa CITAR os trechos e as datas, como o brief pede.
--
-- 1536 dimensões = text-embedding-3-small da OpenAI. Trocar de modelo depois
-- exige recriar a coluna — está isolado aqui de propósito.
-- ===========================================================================
create table if not exists blocos (
  id           bigint generated always as identity primary key,
  grupo_id     bigint not null references grupos(id) on delete cascade,

  inicio_em    timestamptz not null,
  fim_em       timestamptz not null,
  texto        text not null,
  mensagem_ids bigint[] not null default '{}',

  embedding    vector(1536),
  modelo       text,                 -- qual modelo gerou (rastreabilidade)

  criado_em    timestamptz not null default now()
);

create index if not exists idx_blocos_grupo_periodo
  on blocos (grupo_id, inicio_em desc);

-- HNSW com distância de cosseno: melhor recall/latência que ivfflat e não exige
-- treinar com dados prévios. Criado só quando houver embeddings.
create index if not exists idx_blocos_embedding
  on blocos using hnsw (embedding vector_cosine_ops);


-- ===========================================================================
-- CONSENTIMENTOS
-- ---------------------------------------------------------------------------
-- Risco 1.7: o brief tratava consentimento como um "aviso". Não basta.
-- Registramos POR PESSOA, com o texto e a versão que ela viu, a base legal, e
-- `revogado_em` para o direito de revogação. Sem histórico não há como provar
-- o que foi consentido e quando.
-- ===========================================================================
create table if not exists consentimentos (
  id            bigint generated always as identity primary key,
  grupo_id      bigint not null references grupos(id) on delete cascade,
  pessoa_id     bigint references pessoas(id) on delete set null,

  versao_texto  text not null,
  texto         text not null,
  base_legal    text not null default 'consentimento',
  canal         text,                  -- como o aviso foi dado (mensagem no grupo, e-mail…)

  consentido_em timestamptz not null default now(),
  revogado_em   timestamptz,
  registrado_por uuid,
  criado_em     timestamptz not null default now()
);

create index if not exists idx_consentimentos_grupo on consentimentos (grupo_id);


-- ===========================================================================
-- RETENÇÃO
-- ---------------------------------------------------------------------------
-- Também do risco 1.7: guardar para sempre é difícil de justificar. A política
-- fica declarada por grupo e uma rotina apaga o que passou do prazo.
-- ===========================================================================
create table if not exists politica_retencao (
  grupo_id     bigint primary key references grupos(id) on delete cascade,
  dias         integer not null default 730,   -- 2 anos
  atualizado_em timestamptz not null default now()
);
