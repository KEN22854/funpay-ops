/**
 * Правила FunPay — раздел «Запрещённые товары» и связанные пункты 2.1.x.
 * Формулировки и санкции — по официальным правилам и базе знаний FunPay.
 * Правила меняются: сверяйся с первоисточником перед публикацией лота.
 */

export type Severity = 'block' | 'warn' | 'practice';

export interface Rule {
  id: string;
  /** номер пункта правил, если он есть */
  clause: string | null;
  title: string;
  sanction: string;
  /** срок выплаты после идентификации, дней */
  payoutDays: number | null;
  severity: Severity;
}

export interface RuleGroup {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  rules: Rule[];
}

const BLOCK = 'Блокировка аккаунта';

export const RULE_GROUPS: RuleGroup[] = [
  {
    id: 'block-60',
    title: 'Блокировка + выплата после идентификации через 60 дней',
    description: 'Самая жёсткая категория. Аккаунт блокируется, средства выплачиваются только после идентификации и истечения 60 дней.',
    severity: 'block',
    rules: [
      { id: '2.2.1', clause: '2.2.1', title: 'Товары, полученные взломом, брутом, кардингом', sanction: BLOCK, payoutDays: 60, severity: 'block' },
      { id: '2.2.2', clause: '2.2.2', title: 'Обучение незаконной деятельности (дюп, кардинг)', sanction: BLOCK, payoutDays: 60, severity: 'block' },
      { id: '2.2.3', clause: '2.2.3', title: 'Персональные данные третьих лиц', sanction: BLOCK, payoutDays: 60, severity: 'block' },
    ],
  },
  {
    id: 'block-30',
    title: 'Блокировка + выплата после идентификации через 30 дней',
    description: 'Аккаунт блокируется, средства выплачиваются после идентификации и истечения 30 дней.',
    severity: 'block',
    rules: [
      { id: '2.2.4', clause: '2.2.4', title: 'Нелицензионный софт и вредоносные программы', sanction: BLOCK, payoutDays: 30, severity: 'block' },
      { id: '2.2.5', clause: '2.2.5', title: 'Аккаунты соцсетей, подписки на кино/стриминг без специального раздела', sanction: BLOCK, payoutDays: 30, severity: 'block' },
      { id: '2.2.6', clause: '2.2.6', title: 'Телефонные номера РФ, Украины, Беларуси, включая виртуальные', sanction: BLOCK, payoutDays: 30, severity: 'block' },
      { id: '2.2.7', clause: '2.2.7', title: 'Аккаунты оптом (кроме зарегистрированных самим продавцом)', sanction: BLOCK, payoutDays: 30, severity: 'block' },
      { id: '2.2.8', clause: '2.2.8', title: '18+ контент', sanction: BLOCK, payoutDays: 30, severity: 'block' },
      { id: '2.2.9', clause: '2.2.9', title: 'Товары для спама и массовых рассылок', sanction: BLOCK, payoutDays: 30, severity: 'block' },
      { id: '2.2.10', clause: '2.2.10', title: 'Ставки и казино', sanction: BLOCK, payoutDays: 30, severity: 'block' },
      { id: '2.2.11', clause: '2.2.11', title: 'Любые способы доната и накрутки', sanction: BLOCK, payoutDays: 30, severity: 'block' },
    ],
  },
  {
    id: 'warn',
    title: 'Предупреждение (при повторе — блокировка)',
    description: 'Первое нарушение — предупреждение. Повторное — блокировка.',
    severity: 'warn',
    rules: [
      { id: '2.2.12', clause: '2.2.12', title: 'Перепродажа офлайн-активаций и геймпассов', sanction: 'Предупреждение, при повторе — блокировка', payoutDays: null, severity: 'warn' },
      { id: '2.2.13', clause: '2.2.13', title: 'Лотереи, «рандом»', sanction: 'Предупреждение, при повторе — блокировка', payoutDays: null, severity: 'warn' },
      { id: '2.2.14', clause: '2.2.14', title: 'Криптовалюта', sanction: 'Предупреждение, при повторе — блокировка', payoutDays: null, severity: 'warn' },
    ],
  },
  {
    id: 'practice',
    title: 'Сделки и лоты — реальный риск из практики',
    description: 'Пункты раздела 2.1 и практика модерации. Не всегда в списке запрещённых товаров, но санкции применяются.',
    severity: 'practice',
    rules: [
      {
        id: '2.1.1',
        clause: '2.1.1',
        title: 'Уход сделки за пределы FunPay (оплата напрямую, обмен контактами)',
        sanction: 'Блокировка всех аккаунтов и отказ в выплатах',
        payoutDays: null,
        severity: 'block',
      },
      {
        id: 'no-pay',
        clause: null,
        title: 'Передача товара без оплаты через FunPay',
        sanction: 'Немедленная санкция',
        payoutDays: null,
        severity: 'block',
      },
      {
        id: '2.1.10',
        clause: '2.1.10',
        title: 'Дубли лотов, накрутка списка',
        sanction: 'Удаление лотов, при повторе — бан',
        payoutDays: null,
        severity: 'warn',
      },
      {
        id: '2.1.7',
        clause: '2.1.7',
        title: 'Инструкции, приветствия и прочий текст в поле товаров автовыдачи (должны быть в «Сообщении покупателю после оплаты»)',
        sanction: 'Санкция по разделу 2.1 официальных правил — уточни актуальную формулировку в базе знаний',
        payoutDays: null,
        severity: 'warn',
      },
      {
        id: '2.1.8',
        clause: '2.1.8',
        title: 'Автовыдача, включённая для услуг или перепривязки аккаунта',
        sanction: 'Санкция по разделу 2.1 официальных правил — уточни актуальную формулировку в базе знаний',
        payoutDays: null,
        severity: 'warn',
      },
    ],
  },
];

export const ALL_RULES: Rule[] = RULE_GROUPS.flatMap((g) => g.rules);

export const RULES_SOURCES = [
  { label: 'Правила FunPay', url: 'https://funpay.com/rules' },
  { label: 'База знаний FunPay', url: 'https://support.funpay.com' },
];
