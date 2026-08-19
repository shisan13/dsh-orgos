/**
 * Digest 测试(FR-F2 回执摘要压缩;确定性规则)
 */
import { describe, expect, it } from 'vitest'
import { buildDigest, foldDigests, REPORT_SECTIONS } from './Digest.ts'
import type { Digest } from './Digest.ts'

const REF = { kind: 'delegation' as const, id: 'dlg-1' }

describe('Given 结构化完成报告', () => {
  const report = `登录页已完成并自测通过。

## 结论
登录页实现完成,6 个用例全部通过,无遗留问题。

## 指标
- 用例数: 6
- 失败数: 0
- 耗时: 2.5h

## 验证
pnpm test 全绿;截图见附件 login.png`

  it('Then buildDigest 提取结论/指标/验证(确定性规则)', () => {
    const d = buildDigest(report, REF, { maxConclusionLength: 50 })
    expect(d.conclusion).toBe('登录页实现完成,6 个用例全部通过,无遗留问题。')
    expect(d.metrics).toEqual([
      { name: '用例数', value: '6' },
      { name: '失败数', value: '0' },
      { name: '耗时', value: '2.5h' },
    ])
    expect(d.verification).toContain('pnpm test 全绿')
    expect(d.detailsRef).toEqual(REF)
  })

  it('Then 结论超长截断加省略号', () => {
    const d = buildDigest(report, REF, { maxConclusionLength: 10 })
    expect(d.conclusion).toHaveLength(10)
    expect(d.conclusion.endsWith('…')).toBe(true)
  })
})

describe('Given 无结构化段的报告', () => {
  it('Then 结论取首行,指标/验证为空', () => {
    const d = buildDigest('第一行是结论。\n第二行细节。', REF)
    expect(d.conclusion).toBe('第一行是结论。')
    expect(d.metrics).toEqual([])
    expect(d.verification).toBe('')
  })

  it('Then 空报告结论为空', () => {
    const d = buildDigest('', REF)
    expect(d.conclusion).toBe('')
  })

  it('Then 非法指标行被跳过(非 名称: 值 格式)', () => {
    const d = buildDigest('## 指标\n- 无冒号行\n- 名称: 值\n随便一行', REF)
    expect(d.metrics).toEqual([{ name: '名称', value: '值' }])
  })
})

describe('Given 逐层折叠(摘要链)', () => {
  const children: Digest[] = [
    { conclusion: 'fe-1 完成 A 模块,3 用例通过', metrics: [{ name: '用例数', value: '3' }], verification: 'test ok', detailsRef: { kind: 'delegation', id: 'd1' }, generatedAt: 1 },
    { conclusion: 'be-1 完成 B 模块,2 用例通过', metrics: [{ name: '用例数', value: '2' }], verification: '', detailsRef: { kind: 'delegation', id: 'd2' }, generatedAt: 1 },
  ]

  it('Then 折叠 = 结论并列 + 同名指标求和 + 验证计数', () => {
    const d = foldDigests(children, { kind: 'delegation', id: 'fold-1' })
    expect(d.conclusion).toContain('fe-1 完成 A 模块')
    expect(d.conclusion).toContain('be-1 完成 B 模块')
    expect(d.metrics).toEqual([{ name: '用例数', value: '5' }])
    expect(d.verification).toBe('1/2 个子报告附验证输出')
    expect(d.detailsRef).toEqual({ kind: 'delegation', id: 'fold-1' })
  })

  it('Then 超出 maxFoldChildren 的子报告合并计数', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      conclusion: `子报告 ${i + 1}`,
      metrics: [],
      verification: '',
      detailsRef: { kind: 'delegation' as const, id: `d${i + 1}` },
      generatedAt: 1,
    }))
    const d = foldDigests(many, REF, { maxFoldChildren: 20, maxConclusionLength: 1000 })
    expect(d.conclusion).toContain('另有 5 个子报告未展开')
  })

  it('Then 全无验证时 verification 为空串', () => {
    const d = foldDigests([children[1]!], REF)
    expect(d.verification).toBe('')
  })

  it('Then 混合数值指标并列显示', () => {
    const mixed = [
      { conclusion: 'a', metrics: [{ name: '耗时', value: '2h' }], verification: '', detailsRef: { kind: 'delegation' as const, id: 'x' }, generatedAt: 1 },
      { conclusion: 'b', metrics: [{ name: '耗时', value: '1.5h' }], verification: '', detailsRef: { kind: 'delegation' as const, id: 'y' }, generatedAt: 1 },
    ]
    const d = foldDigests(mixed, REF)
    expect(d.metrics).toEqual([{ name: '耗时', value: '2h / 1.5h' }])
  })
})

describe('Given 报告段约定', () => {
  it('Then REPORT_SECTIONS 导出 结论/指标/验证', () => {
    expect(REPORT_SECTIONS).toEqual(['结论', '指标', '验证'])
  })

  it('Then 段名大小写不敏感且支持前导符号', () => {
    const d = buildDigest('## 指标\n* 修复数: 2\n## 指标2\nx: 1', REF)
    expect(d.metrics).toEqual([{ name: '修复数', value: '2' }])
  })
})
