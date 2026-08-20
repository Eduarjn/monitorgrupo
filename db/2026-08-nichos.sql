-- Nichos: o painel fala a língua do negócio do cliente.
--
-- Os cards globais servem para qualquer grupo, mas são genéricos ("o que ficou
-- pendente"). Um provedor de internet não pergunta isso — ele pergunta quem
-- está sem resposta há mais tempo e quem já reclamou três vezes. Uma imobiliária
-- pergunta qual lead esfriou.
--
-- O nicho mora no GRUPO, não no usuário: a mesma empresa pode ter um grupo de
-- suporte e um de vendas, e cada um quer perguntas diferentes.
--
-- Card sem nicho (null) continua aparecendo em todo lugar. Card com nicho só
-- aparece quando o grupo é daquele nicho. Isso mantém compatibilidade: nada do
-- que ja existe muda de comportamento.

begin;

-- ---------------------------------------------------------------- 1. colunas
alter table grupos    add column if not exists nicho text;
alter table consultas add column if not exists nicho text;

comment on column grupos.nicho    is 'segmento do cliente; define quais cards aparecem';
comment on column consultas.nicho is 'null = card serve a todos os nichos';

-- Vocabulario fechado: nicho digitado livre viraria "provedor", "Provedor",
-- "provedor de internet" e nenhum card casaria.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'grupos_nicho_valido') then
    alter table grupos add constraint grupos_nicho_valido check (
      nicho is null or nicho in
        ('provedor', 'imobiliaria', 'condominio', 'distribuidora', 'atendimento', 'comercial'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'consultas_nicho_valido') then
    alter table consultas add constraint consultas_nicho_valido check (
      nicho is null or nicho in
        ('provedor', 'imobiliaria', 'condominio', 'distribuidora', 'atendimento', 'comercial'));
  end if;
end $$;

-- O card e buscado por (nicho do grupo) a cada abertura da aba.
create index if not exists consultas_nicho_idx on consultas (nicho) where ativa;

-- ------------------------------------------------- 2. cards por nicho (seed)
-- Todos sao 'pergunta': as metricas ja tem cards globais e valem para qualquer
-- segmento. O que muda por nicho e a PERGUNTA, que e onde mora o vocabulario
-- do negocio.
--
-- Regra de escrita das perguntas: pedir sempre CITACAO da mensagem de origem.
-- Resposta sem origem no painel de gestao vira opiniao, e opiniao ninguem paga.

insert into consultas (grupo_id, nicho, titulo, descricao, natureza, pergunta, visual, dias)
values
-- ---- PROVEDOR DE INTERNET ------------------------------------------------
(null, 'provedor', 'Risco de cancelamento',
 'Quem demonstrou intencao de cancelar ou insatisfacao repetida.',
 'pergunta',
 'Liste os clientes que demonstraram intencao de cancelar, pedir desconto para ficar, ou que reclamaram do mesmo problema mais de uma vez. Para cada um, cite a mensagem exata e a data. Se nao houver nenhum, diga que nao houve.',
 'texto', 30),

(null, 'provedor', 'Reclamacoes tecnicas',
 'Quedas, lentidao e instabilidade relatadas no periodo.',
 'pergunta',
 'Liste as reclamacoes de natureza tecnica (queda de conexao, lentidao, oscilacao, sem sinal, wi-fi). Agrupe por tipo de problema e diga quantas vezes cada tipo apareceu, citando ao menos uma mensagem de exemplo por tipo.',
 'texto', 30),

(null, 'provedor', 'Chamados sem retorno',
 'Quem pediu ajuda e nao teve resposta da equipe.',
 'pergunta',
 'Identifique mensagens de clientes pedindo ajuda, informando problema ou cobrando retorno que NAO tiveram resposta posterior da equipe. Cite a mensagem e diga ha quanto tempo esta sem resposta.',
 'texto', 15),

(null, 'provedor', 'Cobranca e faturamento',
 'Boleto, vencimento, negociacao e bloqueio por pagamento.',
 'pergunta',
 'Liste as mensagens sobre boleto, segunda via, vencimento, negociacao de divida ou bloqueio por falta de pagamento. Cite cada uma e diga se foi resolvida na conversa.',
 'texto', 30),

-- ---- IMOBILIARIA ----------------------------------------------------------
(null, 'imobiliaria', 'Leads sem atendimento',
 'Interessados que apareceram e ninguem assumiu.',
 'pergunta',
 'Identifique mensagens que trazem um interessado, lead ou pedido de visita e verifique se algum corretor assumiu o atendimento na sequencia. Liste os que ficaram sem dono, citando a mensagem e o horario.',
 'texto', 15),

(null, 'imobiliaria', 'O que o cliente procura',
 'Perfil de imovel mais pedido no periodo.',
 'pergunta',
 'Consolide o que os interessados estao procurando: tipo de imovel, bairro, faixa de preco, numero de quartos, se e compra ou locacao. Agrupe por padrao e cite exemplos reais de mensagem.',
 'texto', 30),

(null, 'imobiliaria', 'Objecoes que travaram',
 'Por que o negocio nao andou.',
 'pergunta',
 'Liste as objecoes e travas mencionadas pelos interessados (preco alto, documentacao, financiamento negado, condicao de pagamento, localizacao). Para cada uma, cite a mensagem e diga se houve resposta do corretor.',
 'texto', 30),

-- ---- CONDOMINIO -----------------------------------------------------------
(null, 'condominio', 'Conflito escalando',
 'Discussao entre moradores subindo de tom.',
 'pergunta',
 'Identifique discussoes entre moradores que subiram de tom, com acusacao pessoal, ironia agressiva ou exposicao de alguem pelo nome. Cite as mensagens e diga quem estava envolvido. Se nao houve conflito, diga isso claramente.',
 'texto', 15),

(null, 'condominio', 'Exposicao indevida',
 'Dado pessoal de morador exposto no grupo.',
 'pergunta',
 'Verifique se algum morador foi exposto no grupo: citado como inadimplente, com numero de apartamento ligado a acusacao, foto sem consentimento, ou dado pessoal divulgado. Cite a mensagem. Este e um risco juridico para o sindico.',
 'texto', 30),

(null, 'condominio', 'Demandas de manutencao',
 'O que os moradores pediram para consertar.',
 'pergunta',
 'Liste os pedidos de manutencao, reparo ou reclamacao sobre area comum (elevador, portao, piscina, garagem, limpeza, barulho). Agrupe por item e diga quantas vezes cada um foi citado, com exemplo de mensagem.',
 'texto', 30),

-- ---- DISTRIBUIDORA / ATACADO ---------------------------------------------
(null, 'distribuidora', 'Pedidos combinados',
 'O que foi pedido, com quantidade e condicao.',
 'pergunta',
 'Liste os pedidos feitos no grupo: produto, quantidade, preco e condicao de pagamento acordada. Cite a mensagem exata de cada pedido, com data e autor. Este historico e o que resolve divergencia depois.',
 'tabela', 30),

(null, 'distribuidora', 'Descontos e excecoes',
 'Condicao fora da tabela que alguem concedeu.',
 'pergunta',
 'Identifique descontos, prazos estendidos, condicoes especiais ou excecoes a tabela que foram concedidos na conversa. Cite quem concedeu, para quem, e a mensagem exata.',
 'texto', 30),

(null, 'distribuidora', 'Problemas de entrega',
 'Atraso, avaria e divergencia de nota.',
 'pergunta',
 'Liste as reclamacoes sobre entrega: atraso, produto avariado, quantidade errada, divergencia de nota fiscal, devolucao. Cite cada mensagem e diga se houve solucao registrada na conversa.',
 'texto', 30),

-- ---- ATENDIMENTO GENERICO -------------------------------------------------
(null, 'atendimento', 'Sem resposta',
 'Mensagens de cliente que ficaram no vacuo.',
 'pergunta',
 'Identifique mensagens de clientes que nao tiveram nenhuma resposta da equipe depois. Cite cada uma, com autor e horario, e diga ha quanto tempo esta sem resposta.',
 'texto', 15),

(null, 'atendimento', 'Assuntos que mais repetem',
 'O que o cliente pergunta toda semana.',
 'pergunta',
 'Agrupe as solicitacoes por assunto e ordene do mais frequente ao menos frequente. Para cada assunto, diga quantas vezes apareceu e cite uma mensagem de exemplo. Isso indica o que deveria virar FAQ ou automacao.',
 'texto', 30),

(null, 'atendimento', 'Clientes insatisfeitos',
 'Quem demonstrou irritacao ou frustracao.',
 'pergunta',
 'Liste as pessoas que demonstraram irritacao, frustracao ou ameaca de reclamar em outro canal. Cite a mensagem e o motivo. Ordene do mais grave para o menos grave.',
 'texto', 30),

-- ---- COMERCIAL / VENDAS ---------------------------------------------------
(null, 'comercial', 'Negocios em aberto',
 'Oportunidades citadas e o estagio de cada uma.',
 'pergunta',
 'Liste as oportunidades de negocio mencionadas e em que pe cada uma parou (proposta enviada, aguardando retorno, em negociacao, fechada, perdida). Cite a mensagem que sustenta cada conclusao.',
 'texto', 30),

(null, 'comercial', 'Compromissos assumidos',
 'O que alguem prometeu e para quando.',
 'pergunta',
 'Liste os compromissos assumidos por alguem da equipe (enviar proposta, retornar ligacao, agendar reuniao, mandar documento), com o prazo prometido e se houve confirmacao de cumprimento. Cite a mensagem.',
 'tabela', 30),

(null, 'comercial', 'Concorrencia citada',
 'Quando o cliente mencionou outro fornecedor.',
 'pergunta',
 'Identifique mensagens em que alguem cita um concorrente, compara preco com outro fornecedor, ou menciona proposta de terceiro. Cite a mensagem e o contexto.',
 'texto', 30)

on conflict do nothing;

commit;
