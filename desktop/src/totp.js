// 注意：TOTP 算码统一在主进程进行（src/main/totp-store.js 的 generateTotpCode，
// 用 BigInt 计数器、支持 SHA1/256/512 与可配置位数/周期）。本模块只为渲染层
// 提供周期常量和进度计算，不再做客户端算码。
//
// 旧版这里有一个 generate()，写死 SHA1/6位/30秒，且用 32 位 `c >>>= 8` 填 8 字节
// 计数器——2038 年后 time/30 超出 2^32 会丢高位算出错码。该函数渲染层从未调用
// （列表里的码都来自主进程下发的快照），已删除以防日后误用。
const TOTP = (() => {
  const DIGITS = 6
  const PERIOD = 30

  function getRemainingSeconds() {
    return PERIOD - (Math.floor(Date.now() / 1000) % PERIOD)
  }

  function getPeriodProgress() {
    const elapsed = Math.floor(Date.now() / 1000) % PERIOD
    return (PERIOD - elapsed) / PERIOD
  }

  return { getRemainingSeconds, getPeriodProgress, DIGITS, PERIOD }
})()

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TOTP
}
