// Сервер использует единый финансовый движок из shared/ — здесь только реэкспорт.
export { ENGINE_VERSION, forecast, solvePrice, maxMarginPct, saleResult, platformFee, payoutFactor, lossesOf, effectiveWithdrawPct } from '../../shared/finance.mjs';
