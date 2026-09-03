/**
 * 桌面客户端配置下发（`/api/v1/client-config`）的契约版本。
 *
 * 放在 lib/ 而不是 route.ts 里：Next.js App Router 的 route.ts **只允许导出 HTTP 方法与固定配置字段**，
 * 多导出一个常量 `next build` 就报 "not a valid Route export field"（2026-09-03 Vercel 生产构建因此红了两次；
 * `next dev` 不做这项检查，只有 build 才报）。
 *
 * v2（2026-09-03）：按档位下发 `tiers.standard / tiers.enhanced`，客户端不持任何写死的 base URL；
 * v1 字段保留给未升级客户端，废弃时机见 docs/HANDOFF.md §0-新f。
 */
export const CLIENT_CONFIG_CONTRACT_VERSION = 2;
