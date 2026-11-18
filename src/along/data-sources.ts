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
  {provider:'okx',name:'OKX',access:'native_read_only',url:'https://www.okx.com/account/my-api',
    description:'从 App 原生安全流程连接只读交易账户摘要；连接设置、实际权限校验、已保存摘要和 Agent 新鲜读取是不同状态。以当前 Host 验证的 source_ready 和任务受限 along_source_read 为准，不能凭页面打开或用户自报认为已连通。registered trading_account_summary 只含 tradingEquityUsd（USD）、assetCount 和 positionCount（count）。实际来源另声明 trading_history 时，可通过任务受限读取近三个月成交/账单的确定性报告，包含固定窗口、分页完整性、分币费用与普通衍生品交易盈亏分量；缺失/截断必须说明。报告不是完整账户收益，现货期初成本和用户策略规则/映射仍需真实证据，不得按币种或标签臆造策略归属。数据可能需 iPhone 前台采集补传；不承诺关闭 App 后持续采集。OAuth 和 App CSV 上传/导入未接入，不要求用户在聊天发密钥。'},
  {provider:'apple-health',name:'Apple Health',access:'native_permission',
    description:'在 iPhone 原生授权所选健康类型并共享摘要，仅当此目标需要健康数据时推荐；不共享原始样本。'},
] as const

export const DATA_SOURCE_DDL = `CREATE TABLE IF NOT EXISTS goal_data_sources (
  goal_id TEXT PRIMARY KEY REFERENCES goal(id), user_id TEXT NOT NULL,
  sources TEXT NOT NULL, updated_at TEXT NOT NULL
);`

export const recommendedSources = (input: unknown): GoalDataSource[] => DATA_SOURCE_INPUT.parse(input)
  .sort((a,b)=>a.provider.localeCompare(b.provider)).map(source=>({...source,status:'recommended'}))
