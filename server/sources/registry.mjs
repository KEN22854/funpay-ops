// Реестр источников. method:
//   api / feed / html — цены собираются автоматически (проверено запросом на момент написания);
//   aggregator        — цены магазина приходят через агрегатор CheapShark;
//   manual            — автосбора нет, цену вводишь сам в карточке товара. В note — почему.
//
// categories: keys | skins | currency | accounts

const auto = (id, name, url, categories, adapter, method, note) => ({ id, name, url, categories, adapter, method, note });
const manual = (id, name, url, categories, note) => ({ id, name, url, categories, adapter: null, method: 'manual', note });

const BLOCKED = 'проверено: закрыт Cloudflare/403 для автоматических запросов';
const NOT_IMPL = 'автосбор не реализован — нет открытого API, вводи цену вручную';

const CHEAPSHARK_STORES = [
  ['2', 'GamersGate', 'https://www.gamersgate.com'],
  ['3', 'Green Man Gaming', 'https://www.greenmangaming.com'],
  ['11', 'Humble Store', 'https://www.humblebundle.com/store'],
  ['13', 'Ubisoft Store', 'https://store.ubisoft.com'],
  ['15', 'Fanatical', 'https://www.fanatical.com'],
  ['21', 'WinGameStore', 'https://www.wingamestore.com'],
  ['23', 'GameBillet', 'https://www.gamebillet.com'],
  ['25', 'Epic Games Store', 'https://store.epicgames.com'],
  ['27', 'Gamesplanet', 'https://www.gamesplanet.com'],
  ['30', 'IndieGala', 'https://www.indiegala.com'],
  ['35', 'DreamGame', 'https://www.dreamgame.com'],
  ['1', 'Steam (США, через CheapShark)', 'https://store.steampowered.com'],
  ['7', 'GOG (США, через CheapShark)', 'https://www.gog.com'],
];
const US_NOTE = 'цена в USD для региона США через CheapShark; проверь, активируется ли ключ в твоём регионе';

export const SOURCES = [
  // ── Ключи / игры, автоматически
  auto('steam', 'Steam (РФ)', 'https://store.steampowered.com', ['keys'], 'steam', 'api', 'цена в Steam для региона RU'),
  auto('plati', 'Plati.market', 'https://plati.market', ['keys', 'currency', 'accounts'], 'plati', 'api', 'публичный поиск Digiseller; цена без комиссии платёжной системы'),
  auto('gog', 'GOG (РФ)', 'https://www.gog.com/ru', ['keys'], 'gog', 'api', 'каталог GOG, цена в рублях'),
  auto('gabestore', 'GabeStore', 'https://gabestore.ru', ['keys'], 'gabestore', 'html', 'разбор страницы поиска'),
  ...CHEAPSHARK_STORES.map(([sid, name, url]) => auto(`cs-${sid}`, name, url, ['keys'], 'cheapshark', 'aggregator', US_NOTE)),

  // ── Скины, автоматически
  auto('skinport', 'Skinport', 'https://skinport.com', ['skins'], 'skinport', 'feed', 'публичная выгрузка цен; лимит 8 запросов/5 мин, кэш 15 мин'),
  auto('tm', 'Market.CSGO / Dota2.net / Rust.tm', 'https://market.csgo.com', ['skins'], 'tm', 'feed', 'публичная выгрузка цен в рублях'),
  auto('lis', 'LIS-SKINS', 'https://lis-skins.com', ['skins'], 'lis', 'feed', 'публичная выгрузка, цены в USD'),
  auto('waxpeer', 'Waxpeer', 'https://waxpeer.com', ['skins'], 'waxpeer', 'feed', 'публичная выгрузка, цены в USD'),
  auto('steam-market', 'Steam Community Market', 'https://steamcommunity.com/market', ['skins'], 'steam-market', 'api', 'жёсткий лимит Steam — запрос раз в 3,5 с, кэш 30 мин; деньги остаются в кошельке Steam'),

  // ── Ключи / игры, вручную
  manual('g2a', 'G2A', 'https://www.g2a.com', ['keys', 'currency', 'accounts'], BLOCKED),
  manual('eneba', 'Eneba', 'https://www.eneba.com', ['keys', 'currency'], BLOCKED),
  manual('gamivo', 'Gamivo', 'https://www.gamivo.com', ['keys'], BLOCKED),
  manual('instant-gaming', 'Instant Gaming', 'https://www.instant-gaming.com', ['keys'], BLOCKED),
  manual('kinguin', 'Kinguin', 'https://www.kinguin.net', ['keys', 'currency'], 'страница поиска рендерится скриптом — ' + NOT_IMPL),
  manual('k4g', 'K4G', 'https://k4g.com', ['keys'], NOT_IMPL),
  manual('ggsel', 'GGsel', 'https://ggsel.net', ['keys', 'currency', 'accounts'], 'проверено: серверный поиск не учитывает запрос — ' + NOT_IMPL),
  manual('steambuy', 'SteamBuy', 'https://steambuy.com', ['keys'], NOT_IMPL),
  manual('zaka-zaka', 'Zaka-zaka', 'https://zaka-zaka.com', ['keys'], NOT_IMPL),
  manual('steampay', 'SteamPay', 'https://steampay.com', ['keys'], NOT_IMPL),
  manual('igromagaz', 'Игромагаз', 'https://www.igromagaz.ru', ['keys', 'currency'], NOT_IMPL),
  manual('buka', 'Бука', 'https://shop.buka.ru', ['keys'], NOT_IMPL),
  manual('loaded', 'Loaded (CDKeys)', 'https://www.loaded.com', ['keys'], NOT_IMPL),
  manual('driffle', 'Driffle', 'https://driffle.com', ['keys'], NOT_IMPL),
  manual('hrk', 'HRK Game', 'https://www.hrkgame.com', ['keys'], NOT_IMPL),
  manual('mmoga', 'MMOGA', 'https://www.mmoga.com', ['keys', 'currency'], NOT_IMPL),
  manual('allkeyshop', 'AllKeyShop (агрегатор)', 'https://www.allkeyshop.com', ['keys'], NOT_IMPL),
  manual('ps-store', 'PlayStation Store', 'https://store.playstation.com', ['keys'], NOT_IMPL),
  manual('xbox-store', 'Microsoft Store / Xbox', 'https://www.xbox.com', ['keys'], NOT_IMPL),
  manual('nintendo', 'Nintendo eShop', 'https://www.nintendo.com', ['keys'], NOT_IMPL),

  // ── Скины, вручную
  manual('csfloat', 'CSFloat', 'https://csfloat.com', ['skins'], 'проверено: API отвечает 403 без ключа — ' + NOT_IMPL),
  manual('dmarket', 'DMarket', 'https://dmarket.com', ['skins'], 'проверено: публичный эндпоинт отключён (410) — ' + NOT_IMPL),
  manual('buff163', 'BUFF163', 'https://buff.163.com', ['skins'], 'требует вход в аккаунт — ' + NOT_IMPL),
  manual('bitskins', 'BitSkins', 'https://bitskins.com', ['skins'], 'проверено: публичная выгрузка пустая — ' + NOT_IMPL),
  manual('skinbaron', 'SkinBaron', 'https://skinbaron.de', ['skins'], 'API требует ключ — ' + NOT_IMPL),
  manual('tradeit', 'Tradeit.gg', 'https://tradeit.gg', ['skins'], NOT_IMPL),
  manual('csmoney', 'CS.MONEY', 'https://cs.money', ['skins'], NOT_IMPL),
  manual('skinsmonkey', 'SkinsMonkey', 'https://skinsmonkey.com', ['skins'], NOT_IMPL),
  manual('white-market', 'White.market', 'https://white.market', ['skins'], NOT_IMPL),
  manual('avan', 'Avan.market', 'https://avan.market', ['skins'], NOT_IMPL),
  manual('mannco', 'Mannco.store', 'https://mannco.store', ['skins'], NOT_IMPL),

  // ── Игровая валюта, вручную
  manual('g2g', 'G2G', 'https://www.g2g.com', ['currency', 'accounts'], 'страница рендерится скриптом — ' + NOT_IMPL),
  manual('playerauctions', 'PlayerAuctions', 'https://www.playerauctions.com', ['currency', 'accounts'], BLOCKED),
  manual('eldorado', 'Eldorado.gg', 'https://www.eldorado.gg', ['currency', 'accounts'], NOT_IMPL),
  manual('zeusx', 'ZeusX', 'https://zeusx.com', ['currency', 'accounts'], BLOCKED),
  manual('overgear', 'Overgear', 'https://overgear.com', ['currency', 'accounts'], NOT_IMPL),
  manual('playhub', 'PlayHub', 'https://playhub.com', ['currency', 'accounts'], NOT_IMPL),
  manual('lootbar', 'LootBar', 'https://lootbar.gg', ['currency'], NOT_IMPL),
  manual('codashop', 'Codashop', 'https://www.codashop.com', ['currency'], 'официальные пополнения донат-валюты — ' + NOT_IMPL),
  manual('midasbuy', 'Midasbuy', 'https://www.midasbuy.com', ['currency'], 'официальные пополнения (PUBG UC и др.) — ' + NOT_IMPL),
  manual('seagm', 'SEAGM', 'https://www.seagm.com', ['currency', 'keys'], NOT_IMPL),

  // ── Аккаунты / услуги / маркетплейсы-конкуренты, вручную
  manual('playerok', 'Playerok', 'https://playerok.com', ['currency', 'accounts', 'keys', 'skins'], NOT_IMPL),
  manual('starvell', 'Starvell', 'https://starvell.com', ['currency', 'accounts', 'keys'], NOT_IMPL),
  manual('lzt', 'LZT Market', 'https://lzt.market', ['accounts'], NOT_IMPL),
  manual('epicnpc', 'EpicNPC', 'https://www.epicnpc.com', ['accounts'], NOT_IMPL),
  manual('fp-other', 'FunPay (другой раздел)', 'https://funpay.com', ['currency', 'accounts', 'keys', 'skins'], 'перепродажа внутри FunPay: дешевле в одном разделе/у одного продавца — дороже в другом'),
];

export const SOURCE_BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s]));

export const CATEGORIES = [
  { id: 'keys', name: 'Ключи и игры' },
  { id: 'skins', name: 'Скины и предметы' },
  { id: 'currency', name: 'Игровая валюта' },
  { id: 'accounts', name: 'Аккаунты и услуги' },
];
