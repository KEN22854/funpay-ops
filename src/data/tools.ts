/**
 * Сторонние библиотеки и боты для FunPay. Справочник, НЕ рекомендация.
 * У FunPay нет официального API: все эти инструменты работают через golden_key
 * (cookie сессии) и могут привести к блокировке аккаунта.
 */

export interface ToolInfo {
  id: string;
  name: string;
  language: 'Python';
  source: 'PyPI' | 'GitHub';
  url: string;
  install: string | null;
  features: string[];
  note?: string;
}

export const TOOLS: ToolInfo[] = [
  {
    id: 'aiofunpayapi',
    name: 'aioFunPayAPI',
    language: 'Python',
    source: 'PyPI',
    url: 'https://pypi.org/project/aioFunPayAPI/',
    install: 'pip install aioFunPayAPI',
    features: [
      'Асинхронная работа (asyncio)',
      'Авторизация по golden_key',
      'Прослушивание событий: новые сообщения, заказы',
      'Отправка сообщений',
      'Выдача товара при заказе',
    ],
  },
  {
    id: 'funpaybotengine',
    name: 'FunpayBotEngine',
    language: 'Python',
    source: 'PyPI',
    url: 'https://pypi.org/project/FunpayBotEngine/',
    install: 'pip install FunpayBotEngine',
    features: ['Обёртка для FunPay', 'Автоподнятие лотов', 'Автоответы', 'Автовыдача'],
    note: 'На её основе построен готовый бот FunPayHub.',
  },
  {
    id: 'funpayace',
    name: 'FunpayACE',
    language: 'Python',
    source: 'PyPI',
    url: 'https://pypi.org/project/FunpayACE/',
    install: 'pip install FunpayACE',
    features: ['«Вечный онлайн»', 'Автоподнятие лотов', 'Получение баланса'],
  },
  {
    id: 'cardinal',
    name: 'FunPay Cardinal',
    language: 'Python',
    source: 'GitHub',
    url: 'https://github.com/search?q=FunPayCardinal&type=repositories',
    install: null,
    features: ['Открытый код', 'Автовыдача', 'Автоподнятие', 'Автоответы', 'Управление через Telegram'],
    note: 'Готовый бот, а не библиотека. Ставится клонированием репозитория — проверяй, что это оригинальный репозиторий, а не форк с изменённым кодом.',
  },
  {
    id: 'fpx',
    name: 'fpx',
    language: 'Python',
    source: 'GitHub',
    url: 'https://github.com/search?q=fpx+funpay&type=repositories',
    install: null,
    features: ['Создание лотов', 'Получение данных редактора категорий'],
  },
];

export const TOOLS_WARNING =
  'FunPay не имеет официального API. Все перечисленные инструменты используют golden_key — cookie вашей сессии. ' +
  'Использование — на ваш риск, возможна блокировка аккаунта.';

export const GOLDEN_KEY_WARNING =
  'golden_key даёт полный доступ к аккаунту и балансу. Не передавай его третьим лицам, не вставляй в чужие боты ' +
  'и не публикуй в репозиториях. Код бота проверяй до запуска.';
