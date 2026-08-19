/**
 * dsh-orgos-core 纯领域内核导出(domain/ 分层纪律:零 DSH import,harness-agnostic)
 * 技术设计 §2.4:Codex/Claude Code 以"成员执行引擎"身份一等可用;换宿主时内核可移植。
 */
export * from './types.ts'
export { OrgTree, OrgTreeError } from './org/OrgTree.ts'
export { parseTeamConfig, validateTeamConfig } from './config/TeamConfig.ts'
export type { ParseResult } from './config/TeamConfig.ts'
export { RouterResolver } from './route/RouterResolver.ts'
export type { RoutableMessage, RouteResult, RouterOptions } from './route/RouterResolver.ts'
export { DelegationEngine } from './delegation/DelegationEngine.ts'
export type { EngineError, EngineErrorCode, EngineOptions, EngineResult } from './delegation/DelegationEngine.ts'
export { transition, validateBrief, DelegationStateError } from './delegation/stateMachine.ts'
export type { BriefIssue, Delegation, DelegationEvent, DelegationStatus } from './delegation/stateMachine.ts'
export { AclPolicy } from './acl/AclPolicy.ts'
export type { AclGate } from './acl/AclPolicy.ts'
export { Mailbox } from './mailbox/Mailbox.ts'
export type { BroadcastTarget, MailItem, MailRecipient, MailboxResult } from './mailbox/Mailbox.ts'
export { TaskBoard } from './taskboard/TaskBoard.ts'
export type { TaskItem, TaskResult, TaskStatus } from './taskboard/TaskBoard.ts'
export { projectMail, projectTasks, projectDelegations, roleScope, visibilityGeometry } from './scope/ScopeProjection.ts'
export { buildDigest, foldDigests, REPORT_SECTIONS } from './digest/Digest.ts'
export type { Digest, DigestMetric, DigestOptions } from './digest/Digest.ts'
export type { MailProjection, MemberScope, ProjectContext, ProjectableMail, ProjectableTask, ScopeLevel, TaskProjection, VisibilityGeometry } from './scope/ScopeProjection.ts'
