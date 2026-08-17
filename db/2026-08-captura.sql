-- ============================================================================
-- Captura em tempo real por QR Code (D8, 17/08/2026)
--
-- Reverte a D7 na parte de ingestão: o painel passa a receber mensagem de grupo
-- em tempo real via Evolution API (Baileys). O upload do .txt CONTINUA — vira o
-- backfill do passado, porque o histórico via Baileys é instável.
--
-- O gate de consentimento fica: captura contínua não tem intervenção humana por
-- mensagem, então bloqueia (409) em vez de só avisar.
--
-- Idempotente.
-- ============================================================================

-- ===========================================================================
-- 1. GRUPO ↔ GRUPO REMOTO
-- ---------------------------------------------------------------------------
-- `grupos` nasceu sem identificador externo: a mensagem que chega não sabia
-- onde entrar. `captura_inicio_em` é a fronteira entre o passado (vem do .txt)
-- e o presente (vem do webhook).
-- ===========================================================================
alter table grupos add column if not exists wa_jid             text;
alter table grupos add column if not exists wa_nome_remoto     text;
alter table grupos add column if not exists captura_ativa      boolean not null default false;
alter table grupos add column if not exists captura_inicio_em  timestamptz;

create unique index if not exists idx_grupos_wa_jid
  on grupos (wa_jid) where wa_jid is not null;

comment on column grupos.captura_inicio_em is
  'Marco temporal: daqui para frente a captura e a fonte de verdade; antes, o upload.';


-- ===========================================================================
-- 2. INSTÂNCIA / SESSÃO DO WHATSAPP
-- ---------------------------------------------------------------------------
-- Uma na prática, mas é entidade com ciclo de vida (QR → conectado → caiu).
-- O token da instância (nós → Evolution) fica cifrado pelo mesmo cripto.ts.
-- O segredo do webhook (Evolution → nós) NÃO fica aqui: vive na env, porque é
-- comparado a cada mensagem e um SELECT+decifra por mensagem seria absurdo.
-- ===========================================================================
create table if not exists wa_instancias (
  id             bigint generated always as identity primary key,
  rotulo         text not null default 'Captura de grupos',
  provedor       text not null default 'evolution'
                 check (provedor in ('evolution', 'zapi')),
  endpoint       text not null default 'http://127.0.0.1:8080',
  instancia_nome text not null,
  instancia_uuid text,

  numero_e164    text,
  perfil_nome    text,

  estado         text not null default 'desconectado'
                 check (estado in ('desconectado','qr_pendente','conectando',
                                   'conectado','sessao_morta','erro')),
  estado_motivo  text,
  estado_em      timestamptz,

  -- QR é volátil: sobrescrito a cada QRCODE_UPDATED (~20s)
  qr_base64      text,
  qr_contagem    integer not null default 0,
  qr_em          timestamptz,

  ultimo_evento_em   timestamptz,
  ultima_mensagem_em timestamptz,
  reconexoes         integer not null default 0,

  token_cifrado  bytea,
  token_iv       bytea,
  token_tag      bytea,
  token_versao   smallint not null default 1,

  criado_por     uuid,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

create unique index if not exists idx_wa_instancias_nome on wa_instancias (instancia_nome);

comment on column wa_instancias.token_cifrado is
  'AES-256-GCM via api/conexao/cripto.ts. Nenhuma rota devolve esta coluna.';

create table if not exists wa_instancia_eventos (
  id           bigint generated always as identity primary key,
  instancia_id bigint not null references wa_instancias(id) on delete cascade,
  tipo         text not null,
  detalhe      jsonb not null default '{}',   -- SEMPRE via sanitizar()
  criado_em    timestamptz not null default now()
);
create index if not exists idx_wa_instancia_eventos
  on wa_instancia_eventos (instancia_id, criado_em desc);


-- ===========================================================================
-- 3. LOG DE WEBHOOK — idempotência e durabilidade
-- ---------------------------------------------------------------------------
-- O índice único É a idempotência: o retry da Evolution (backoff exponencial,
-- várias tentativas) bate no ON CONFLICT DO NOTHING e vira no-op barato.
--
-- Guardamos só METADADO da mensagem. O conteúdo vive em `mensagens`, que tem
-- política de retenção; duplicar o texto aqui criaria um segundo acervo sem
-- prazo de descarte — problema de LGPD, não de disco.
-- ===========================================================================
create table if not exists wa_webhook_eventos (
  id            bigint generated always as identity primary key,
  instancia_id  bigint references wa_instancias(id) on delete set null,
  evento        text not null,
  evento_id     text not null,
  estado        text not null default 'recebido'
                check (estado in ('recebido','processado','ignorado','erro')),
  erro          text,
  tentativas    smallint not null default 0,
  payload       jsonb not null default '{}',
  recebido_em   timestamptz not null default now(),
  processado_em timestamptz
);

create unique index if not exists idx_wa_webhook_idem
  on wa_webhook_eventos (instancia_id, evento, evento_id);

-- varredura de recuperação no boot: o que ficou sem processar volta para a fila
create index if not exists idx_wa_webhook_pendentes
  on wa_webhook_eventos (recebido_em) where estado in ('recebido', 'erro');


-- ===========================================================================
-- 4. MENSAGEM CAPTURADA DENTRO DE `mensagens`
-- ---------------------------------------------------------------------------
-- O ponto mais delicado. `hash_mensagem` hoje é sha256 dos campos CRUS do
-- arquivo ('03/08/2026', '9:12:45 PM'). O webhook não tem esses campos — tem
-- epoch. Não existe forma honesta de reproduzir o hash do upload a partir da
-- captura, porque o formato cru depende do idioma do celular que exportou.
--
-- Duas camadas, ambas não destrutivas:
--   1) wa_msg_id  — idempotência DENTRO da captura (retry do webhook)
--   2) chave_natural — reconciliação ENTRE upload e captura. NÃO é unique de
--      propósito: é heurística (minuto + texto), não identidade.
-- ===========================================================================
alter table mensagens add column if not exists origem text not null default 'upload'
  check (origem in ('upload', 'captura'));
alter table mensagens add column if not exists wa_msg_id     text;
alter table mensagens add column if not exists autor_jid     text;
alter table mensagens add column if not exists texto_hash    text;
alter table mensagens add column if not exists respondendo_a text;

create unique index if not exists idx_mensagens_wa_msg
  on mensagens (grupo_id, wa_msg_id) where wa_msg_id is not null;

-- CORREÇÃO 2 — reconciliação por TEXTO + JANELA DE TEMPO, não por minuto exato.
-- O .txt tem precisão de minuto e vem do relógio do CELULAR; o webhook vem do
-- timestamp do SERVIDOR. Chavear pelo minuto fazia 1 segundo atravessando a
-- virada do minuto virar linha duplicada no painel — que era o risco frequente,
-- não o raro. Agora a chave é só o texto normalizado e o casamento acontece
-- dentro de uma janela de ±90s, na consulta.
create index if not exists idx_mensagens_texto_hash
  on mensagens (grupo_id, texto_hash, enviada_em) where texto_hash is not null;

create index if not exists idx_mensagens_origem
  on mensagens (grupo_id, origem, enviada_em desc);

comment on column mensagens.texto_hash is
  'sha256 do texto normalizado (sem hora, sem autor). Reconciliacao upload x captura usa ISTO + janela de +-90s. NAO e identidade.';

-- Identidade: a captura traz o telefone real (key.participant), que o upload
-- nunca teve. Resolve o risco 1.3 de graça. `wa_identidades` existe porque o
-- mesmo membro pode chegar como @s.whatsapp.net e como @lid.
create table if not exists wa_identidades (
  jid       text primary key,
  pessoa_id bigint not null references pessoas(id) on delete cascade,
  visto_em  timestamptz not null default now()
);


-- ===========================================================================
-- 5. LACUNAS DE CAPTURA
-- ---------------------------------------------------------------------------
-- Sessão caída = buraco no histórico. Registrar é o que permite dizer ao
-- usuário "faça um upload cobrindo 12/08 14:20 → 12/08 19:40".
-- ===========================================================================
create table if not exists wa_lacunas (
  id           bigint generated always as identity primary key,
  instancia_id bigint references wa_instancias(id) on delete set null,
  inicio_em    timestamptz not null,
  fim_em       timestamptz,
  motivo       text not null,
  coberta_por_upload bigint references uploads(id) on delete set null,
  criado_em    timestamptz not null default now()
);
create index if not exists idx_wa_lacunas_abertas
  on wa_lacunas (inicio_em desc) where fim_em is null;


-- ===========================================================================
-- 6. ANÁLISE POR IA (estilo Gong/Chorus)
-- ---------------------------------------------------------------------------
-- `wa_analises` guarda a saída estruturada do modelo por janela.
-- `assinatura` = md5 dos ids da janela: mesma janela não paga duas vezes,
-- mesma mecânica do cache de resumo do dia que já existe.
-- ===========================================================================
create table if not exists wa_analises (
  id           bigint generated always as identity primary key,
  grupo_id     bigint not null references grupos(id) on delete cascade,
  inicio_em    timestamptz not null,
  fim_em       timestamptz not null,
  mensagem_ids bigint[] not null default '{}',
  assinatura   text not null,
  gatilho      text not null,

  nada_relevante boolean not null default false,
  resumo         text,
  temperatura    smallint,          -- 1..5
  sentimento     text,
  -- saída estruturada completa: chamados, dores, pendências, urgências
  dados          jsonb not null default '{}',

  modelo       text,
  tokens_in    integer,
  tokens_out   integer,
  usd          numeric(10,6),
  criado_em    timestamptz not null default now()
);

create unique index if not exists idx_wa_analises_assinatura
  on wa_analises (grupo_id, assinatura);
create index if not exists idx_wa_analises_grupo
  on wa_analises (grupo_id, inicio_em desc);

create table if not exists wa_alertas (
  id          bigint generated always as identity primary key,
  grupo_id    bigint not null references grupos(id) on delete cascade,
  analise_id  bigint references wa_analises(id) on delete cascade,
  tipo        text not null,     -- mencao | termo_critico | volume | silencio | urgencia
  severidade  smallint not null default 3 check (severidade between 1 and 5),
  titulo      text not null,
  detalhe     text,
  mensagem_ids bigint[] not null default '{}',
  estado      text not null default 'novo' check (estado in ('novo','visto','resolvido')),
  criado_em   timestamptz not null default now(),
  visto_em    timestamptz
);
create index if not exists idx_wa_alertas_feed
  on wa_alertas (grupo_id, criado_em desc);
create index if not exists idx_wa_alertas_novos
  on wa_alertas (grupo_id) where estado = 'novo';

-- Regras por grupo: o que é "crítico" é decisão do gestor, não do modelo.
create table if not exists wa_regras (
  grupo_id        bigint primary key references grupos(id) on delete cascade,
  termos_criticos text[] not null default '{}',
  mencoes         text[] not null default '{}',
  volume_limite   integer not null default 25,
  volume_janela_min integer not null default 10,
  silencio_horas  integer not null default 48,
  debounce_seg    integer not null default 90,
  ia_ativa        boolean not null default true,
  teto_usd_dia    numeric(8,4) not null default 1.0,
  atualizado_em   timestamptz not null default now()
);

-- Controle de custo: sem teto, um grupo agitado consome a conta da OpenAI.
create table if not exists wa_uso_ia (
  dia       date not null,
  grupo_id  bigint not null references grupos(id) on delete cascade,
  chamadas  integer not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  usd       numeric(10,6) not null default 0,
  primary key (dia, grupo_id)
);


-- ===========================================================================
-- 7. RLS
-- ---------------------------------------------------------------------------
-- ⚠️ rls-policies.sql termina com GRANT coletivo para `authenticated`.
-- Reaplicá-lo daria SELECT em wa_instancias — inclusive no token cifrado.
-- Este revoke precisa vir DEPOIS daquele grant, sempre.
-- ===========================================================================
alter table wa_instancias        enable row level security;
alter table wa_instancia_eventos enable row level security;
alter table wa_webhook_eventos   enable row level security;
alter table wa_analises          enable row level security;
alter table wa_alertas           enable row level security;
alter table wa_regras            enable row level security;

revoke all on wa_instancias        from authenticated, anon;
revoke all on wa_instancia_eventos from authenticated, anon;
revoke all on wa_webhook_eventos   from authenticated, anon;

do $$ begin
  execute 'drop policy if exists analises_leitura on wa_analises';
  execute 'create policy analises_leitura on wa_analises for select to authenticated
             using (exists (select 1 from grupo_acessos a
                             where a.grupo_id = wa_analises.grupo_id and a.user_id = auth.uid()))';
  execute 'drop policy if exists alertas_leitura on wa_alertas';
  execute 'create policy alertas_leitura on wa_alertas for select to authenticated
             using (exists (select 1 from grupo_acessos a
                             where a.grupo_id = wa_alertas.grupo_id and a.user_id = auth.uid()))';
end $$;

grant select on wa_analises, wa_alertas to authenticated;


-- ===========================================================================
-- 8. O QUE SAI — cobrança de coleta manual (D7)
-- ---------------------------------------------------------------------------
-- As tabelas ficam (auditoria do que já foi enviado), mas a cobrança para.
-- Desligar em vez de dropar: se a captura não vingar, o caminho volta.
-- ===========================================================================
update grupos set lembrete_ativo = false where lembrete_ativo;
