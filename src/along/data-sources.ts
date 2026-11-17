import { z } from 'zod'

/** Capability catalog, not an account connection registry. The model never supplies an authorization URL. */
export const DATA_SOURCE_PROVIDERS = ['okx', 'apple-health'] as const
export const DATA_SOURCE_INPUT = z.array(z.object({
  provider: z.enum(DATA_SOURCE_PROVIDERS), reason: z.string().trim().min(1).max(240),
}).strict()).max(2).refine(sources=>new Set(sources.map(source=>source.provider)).size===sources.length,
  'each provider may be recommended only once')
export type DataSourceInput = z.infer<typeof DATA_SOURCE_INPUT>[number]
export interface GoalDataSource extends DataSourceInput { status: 'recommended' }

export const DATA_SOURCE_CATALOG = [
  {provider:'okx',name:'OKX',access:'official_setup',url:'https://www.okx.com/account/my-api',
    description:'交易、持仓及资金流水的只读 API 设置。当前 Along 仅打开官方设置入口，尚未实现凭证接收、账户读取或 OAuth；打开页面不表示已授权。不要要求用户在聊天里发送密钥。'},
  {provider:'apple-health',name:'Apple Health',access:'native_permission',
    description:'在 iPhone 原生授权所选健康类型并共享摘要，仅当此目标需要健康数据时推荐；不共享原始样本。'},
] as const

export const DATA_SOURCE_DDL = `CREATE TABLE IF NOT EXISTS goal_data_sources (
  goal_id TEXT PRIMARY KEY REFERENCES goal(id), user_id TEXT NOT NULL,
  sources TEXT NOT NULL, updated_at TEXT NOT NULL
);`

export const recommendedSources = (input: unknown): GoalDataSource[] => DATA_SOURCE_INPUT.parse(input)
  .sort((a,b)=>a.provider.localeCompare(b.provider)).map(source=>({...source,status:'recommended'}))
