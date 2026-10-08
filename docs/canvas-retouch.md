# 画布修图工具与 AI 调用接口

## 工具分组

| 用途 | 工具 |
| --- | --- |
| 导航 | 移动图层、平移画布 |
| 选区 | 矩形、椭圆、套索、涂抹选中、魔棒 |
| 绘制 | 画笔、取色器 |
| 修复 | 橡皮、删除、仿制图章、智能抠图 |
| 调色 | 亮度、对比度、饱和度、色相、色温、模糊、风格 |
| AI | 生图、局部重绘、扩图补全、绘画助手 |

套索、椭圆、魔棒和涂抹支持新建、添加、减去、交集选区。Shift 添加，Alt 减去。精细选区单边最多 4096 像素；反选范围为当前选区外接边界。取消选区用 Escape。

有选区时，画笔、橡皮、图章、删除、复制/剪切图层、调色、导出和 AI 编辑均使用实际像素遮罩，保留未选中区域及选区空洞。像素修改支持撤销/重做。

删除工具：有选区时点击或按 Delete 删除选中像素；无选区时按笔刷涂抹删除。图章工具：Alt 点击当前图层取样，再涂抹目标区域；也可在属性中输入取样坐标，方便触屏使用。每次笔画从开始时的图层快照取样，避免重复复制新画出的像素。取色器采集可见图层合成色及透明度。

智能抠图使用已配置的图片连接、模型和 TokenNest 图片分组，请求透明背景并把结果放入新图层，保留原图。真实透明度与抠图效果取决于模型能力。边缘背景颜色较接近的图片也可使用本地去背景，无需请求 AI。

## 智能体接口

在已连接画布客户端的智能体会话中调用现有 `canvas_tool`，无须添加另一套凭证或地址。先调用 `list_sessions`、`select_session`、`get_state`；`list_tools` 返回按用途分组的工具及操作名。所有坐标均为画布世界坐标，允许负值。

| action | 主要参数 |
| --- | --- |
| `select_lasso` | `points`，至少 3 点 |
| `select_brush` | `points`、`brush`，笔刷 1–160 像素 |
| `select_ellipse` | `x`、`y`、`width`、`height` |
| `select_wand` | `x`、`y`、`tolerance`，选择当前图层相邻近似颜色 |
| `invert_selection` | 在当前选区边界内反选 |
| `delete_pixels` | 有选区时删除选中像素；否则需要 `points` 或 `x/y/toX/toY` 与 `brush` |
| `clone_stamp` | `sourceX`、`sourceY`、目标 `points`、`brush` |
| `sample_color` | `x`、`y`，返回 `color` 和 `alpha` |
| `export_selection_mask` | `outputPath`，必须为新的绝对 PNG 路径；不覆盖已有文件 |
| `generate` | `mode`、`prompt`，继续使用已配置图片连接 |

选区操作可传 `selectionMode: replace | add | subtract | intersect`，默认 `replace`。`get_state` 返回选区边界与 `selectionKind`。导出的遮罩按这些边界定位，选中部分为不透明白色，未选中部分为透明；图片编辑供应商需要的遮罩由应用转换为透明表示可编辑。

```json
{
  "action": "select_lasso",
  "points": [{ "x": 10, "y": 10 }, { "x": 180, "y": 20 }, { "x": 90, "y": 160 }],
  "selectionMode": "replace"
}
```

```json
{
  "action": "clone_stamp",
  "sourceX": 40,
  "sourceY": 60,
  "points": [{ "x": 120, "y": 60 }, { "x": 160, "y": 60 }],
  "brush": 24
}
```

随后可调用 `generate`，使用 `mode: inpaint` 与提示词重绘选中区域，或 `mode: cutout` 抠图。多候选结果继续使用 `choose_candidate`。图像供应商必须支持相应图片编辑/透明背景能力；调用失败会返回错误。

## 验证

`bun test apps/electron/src/renderer/pages/studio/canvas-retouch.test.ts packages/session-tools-core/src/handlers/canvas-retouch-schema.test.ts`

`bun run scripts/test-canvas-retouch.ts` 在隐藏 Electron/Chromium 窗口中验证真实 Canvas 合成，包括负坐标、图层位移、选区空洞、跨图块图章、撤销、调色和透明度；使用临时隔离配置，不访问真实用户画布或 AI 服务。
