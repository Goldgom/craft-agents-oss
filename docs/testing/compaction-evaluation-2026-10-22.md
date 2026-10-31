# 上下文压缩效果实测（2026-10-22）

当前工作区源码，未修改压缩实现。原有未提交变更保持原样。

## 结果

通过真实 Pi SDK `compactWithPolicy`、当前 `createCompactionPolicy`、本地历史归档及真实模型 `gpt-6-luna` 测试。使用 TokenNest 已配置连接和渠道组，经应用现有 Electron safeStorage 接口读取凭据，未导出凭据或修改真实会话。

| 合成历史轮次 | 压缩前估算 tokens | 压缩后估算 tokens | 保留比例 | 耗时 | 模型请求次数 | 精确引用保留 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 24 | 25,211 | 815 | 3.23% | 18.49 秒 | 4 | 6/6 |
| 80 | 85,355 | 825 | 0.97% | 38.27 秒 | 9 | 6/6 |

数值包含摘要、归档入口和保留原文，采用 SDK 估算，并再次对压缩后上下文求和核对；不是服务商 tokenizer 的精确计数。此次测试使用 128,000 上下文窗口、16,384 最大输出的模型描述，触发分段后合并。测试高压缩标记将近期原文保留预算临时设为 512，完成后恢复。

样本包含中文重复日志、已完成旧任务、分布于开头和中段的有效约束、结尾的最新要求。六个精确引用为工单、误差阈值、中文文件路径、发票号、金额及节点编号。两组均保留全部精确引用、未核实状态、缺少回执和 HTTP 200 不代表业务修复的要求；原始会话条目均保持一致，历史另有本地归档入口。

## 发现的语义问题

80 轮样本摘要增加了“另有一次结果被截断为 `status=2`”。源样本没有独立的 `status=2` 观测；按 UTF-8 字节切分历史可能切在 `status=200` 中间，分段模型将边界碎片当作了观测。后续合并保留了这一偏差。

同一样本将源约束“不得发布或付款”写成“不得发布付款或付款信息，也不得付款”，发布禁令的措辞范围出现漂移。虽然仍保留了禁止付款，不能据此认定所有硬约束的语义都完全一致。24 轮样本正确保留“禁止发布或付款”。

因此，压缩比例与流程可靠性在这些样本上表现良好，但不能称为无损摘要。重复日志很多、有效任务较少，允许远低于 10% 的结果；这不证明信息密集的真实会话也能压到同一比例。尚未测试连续多次真实模型压缩后的语义累积漂移，也未通过压缩后的模型执行下一轮任务验证行为。

## 回归验证

以下 9 个文件共 **122 项通过、0 项失败、778 次断言**，总耗时 51.94 秒：

- `packages/pi-agent-server/src/compaction-policy.test.ts`
- `packages/pi-agent-server/src/compaction-recovery.test.ts`
- `packages/pi-agent-server/src/compaction-memory.test.ts`
- `packages/pi-agent-server/src/compaction-models.test.ts`
- `packages/pi-agent-server/build/compaction-routing.test.ts`
- `packages/server-core/src/super-agent/SuperAgentCompaction.test.ts`
- `packages/server-core/src/super-agent/SuperAgentService.test.ts`
- `packages/ui/src/components/chat/__tests__/compaction-history.test.ts`
- `packages/shared/src/agent/__tests__/conversation-summary.test.ts`

这些自动化用例使用固定模型响应，验证 SDK 集成、失败恢复、归档回查、模型回退、打包路由、自动触发和继续执行等流程；模型语义效果来自上述两次独立真实模型测试。

原始指标和完整摘要见 [JSON 结果](./compaction-evaluation-2026-10-22.json)。公开结果中的本机临时目录前缀统一替换为 `<TEMP_SESSION_ROOT>`，指标及其余摘要内容保持原样。
