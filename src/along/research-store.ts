/** AlongStore-owned evidence: retrieval is bound to the worker, user and goal before it can be cited. */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export const RESEARCH_DDL = `
CREATE TABLE IF NOT EXISTS research_source (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), goal_id TEXT NOT NULL REFERENCES goal(id),
 ticket_id TEXT NOT NULL, purpose TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_source_scope ON research_source(user_id,goal_id,ticket_id);
CREATE TABLE IF NOT EXISTS research_request (
 id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, goal_id TEXT NOT NULL, ticket_id TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_reply (
 message_id TEXT PRIMARY KEY REFERENCES message(id), input TEXT NOT NULL, recommendation TEXT, notification TEXT
);`
export interface ResearchScope { userId: string; goalId: string; ticketId: string }
export type ResearchPurpose = 'weather' | 'access' | 'route' | 'general'
export interface ResearchSource {
 id: string; title: string; url: string; retrievedAt: string; expiresAt: string; publishedAt?: string
}
export interface ResearchEvidence extends ResearchSource { content: string; purpose: ResearchPurpose; fetched: boolean }
const ttl: Record<ResearchPurpose, number> = { weather: 3*3600_000, access: 86400_000, route: 7*86400_000, general: 86400_000 }
/** Scoped web receipts and reply identities on AlongStore’s shared SQLite handle. */
export class ResearchStore {
 constructor(private readonly db: DatabaseSync) {}
 save(scope: ResearchScope, source: {title: string; url: string; content: string; purpose: ResearchPurpose; publishedAt?: string; fetched: boolean}, now=Date.now()): ResearchEvidence {
  if (!this.db.prepare('SELECT 1 FROM goal WHERE id=? AND user_id=?').get(scope.goalId,scope.userId)) throw Error('research goal not found')
  const receipt: ResearchEvidence = { id: 'src_'+randomUUID().replaceAll('-',''), title:source.title.slice(0,300),url:source.url,
   retrievedAt:new Date(now).toISOString(),expiresAt:new Date(now+ttl[source.purpose]).toISOString(),
   ...(source.publishedAt && Number.isFinite(Date.parse(source.publishedAt)) ? {publishedAt:new Date(source.publishedAt).toISOString()}:{}),
   content:source.content.slice(0,24000),purpose:source.purpose,fetched:source.fetched }
  this.db.prepare('INSERT INTO research_source(id,user_id,goal_id,ticket_id,purpose,content,metadata) VALUES(?,?,?,?,?,?,?)')
   .run(receipt.id,scope.userId,scope.goalId,scope.ticketId,source.purpose,receipt.content,JSON.stringify(receipt))
  return receipt
 }
 get(scope: ResearchScope,id: string): ResearchEvidence | undefined {
  const row=this.db.prepare('SELECT metadata FROM research_source WHERE id=? AND user_id=? AND goal_id=? AND ticket_id=?')
   .get(id,scope.userId,scope.goalId,scope.ticketId)
  return row ? JSON.parse(String(row.metadata)) as ResearchEvidence : undefined
 }
 claimRequest(scope:ResearchScope,operation:string):number | undefined {
  const n=this.db.prepare('SELECT count(*) AS n FROM research_request WHERE user_id=? AND goal_id=? AND ticket_id=?').get(scope.userId,scope.goalId,scope.ticketId)
  if(Number(n?.n)>=16)return undefined
  const result=this.db.prepare('INSERT INTO research_request(user_id,goal_id,ticket_id,operation,status,at) VALUES(?,?,?,?,?,?)').run(scope.userId,scope.goalId,scope.ticketId,operation,'started',new Date().toISOString());return Number(result.lastInsertRowid)
 }
 finishRequest(scope:ResearchScope,id:number,status:string):void {
  this.db.prepare('UPDATE research_request SET status=? WHERE id=? AND user_id=? AND goal_id=? AND ticket_id=?').run(status,id,scope.userId,scope.goalId,scope.ticketId)
 }
 saveReply(messageId: string,input: unknown,recommendation?: unknown,notification?: unknown): void {
  this.db.prepare('INSERT INTO research_reply(message_id,input,recommendation,notification) VALUES(?,?,?,?)')
   .run(messageId,JSON.stringify(input),recommendation===undefined?null:JSON.stringify(recommendation),notification===undefined?null:JSON.stringify(notification))
 }
 reply(messageId: string): {input: unknown; recommendation?: unknown; notification?: unknown} | undefined {
  const row=this.db.prepare('SELECT * FROM research_reply WHERE message_id=?').get(messageId)
  return row ? {input:JSON.parse(String(row.input)),...(row.recommendation===null?{}:{recommendation:JSON.parse(String(row.recommendation))}),
   ...(row.notification===null?{}:{notification:JSON.parse(String(row.notification))})} : undefined
 }
}
