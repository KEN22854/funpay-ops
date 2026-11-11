/** Лимиты и правила автовыдачи FunPay. */

export const DELIVERY_LIMITS = {
  maxCharsPerItem: 140,
  maxParagraphs: 6,
  maxItemsPerLot: 500,
  maxItemsPerDay: 5000,
} as const;

export interface ChecklistItem {
  id: string;
  text: string;
  clause?: string;
}

export const PUBLISH_CHECKLIST: ChecklistItem[] = [
  { id: 'text', text: 'Товар — текст (ключ, код, ссылка), а не действие в аккаунте.' },
  { id: 'same', text: 'Все товары в пуле взаимозаменяемы (один регион, один номинал, одна платформа).' },
  { id: 'len', text: `Каждая строка ≤ ${DELIVERY_LIMITS.maxCharsPerItem} символов.` },
  { id: 'fields', text: 'В поле «товары» только товары, инструкции — в «Сообщение после оплаты».', clause: '2.1.7' },
  { id: 'service', text: 'Для услуг/перепривязки автовыдача НЕ включена.', clause: '2.1.8' },
  { id: 'resp', text: 'Понимаю, что при сбое бота отвечаю перед покупателем я.' },
];

export const DELIVERY_REFERENCE = [
  { k: 'Символов на один товар', v: `${DELIVERY_LIMITS.maxCharsPerItem}` },
  { k: 'Перенос внутри товара', v: '\\n (до 6 абзацев)' },
  { k: 'Товаров в одном лоте', v: `${DELIVERY_LIMITS.maxItemsPerLot}` },
  { k: 'Товаров в сутки', v: `${DELIVERY_LIMITS.maxItemsPerDay}` },
];

export const DELIVERY_CLAUSES = [
  {
    clause: '2.1.7',
    text: 'Поле товаров автовыдачи — только для самих товаров. Приветствие, инструкция, просьба подтвердить заказ — в поле «Сообщение покупателю после оплаты».',
  },
  {
    clause: '2.1.8',
    text: 'Автовыдача не включается для услуг и перепривязки аккаунтов — там товар не является готовым текстом.',
  },
];

export const KNOWLEDGE_BASE_URL = 'https://support.funpay.com';
