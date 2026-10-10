# 画布修图工具与 AI 调用接口

## 工具分组

| 用途 | 工具 |
| --- | --- |
| 布局与导航 | 编辑工作台、移动图层、裁剪图层、自由变换、平移画布 |
| 选区 | 矩形、椭圆、套索、多边形套索、涂抹选中、魔棒 |
| 绘制（按常用程度排列） | 画笔、文字、基础形状、油漆桶、渐变、取色器 |
| 修复 | 橡皮、马赛克、局部明暗、局部模糊/锐化/涂抹、蒙版画笔、修复画笔、仿制图章、智能抠图 |
| 调色 | 亮度、对比度、饱和度、色相、色温、风格；工作台提供色阶、曲线、色彩平衡、反相、阈值、色调分离、锐化、杂色、模糊 |
| AI | 生图、局部重绘、扩图补全、绘画助手 |

套索、椭圆、魔棒和涂抹支持新建、添加、减去、交集选区。Shift 添加，Alt 减去。精细选区单边最多 4096 像素；反选范围为文档边界，无固定文档时使用可见内容边界。取消选区用 Escape。多边形套索依次点击顶点，Enter 或属性中的应用按钮完成。

有选区时，画笔、橡皮、图章、删除、复制/剪切图层、调色、导出和 AI 编辑均使用实际像素遮罩，保留未选中区域及选区空洞。像素修改支持撤销/重做。

删除与橡皮合并为一个入口：橡皮涂抹删除；有选区时按 Delete 删除选中像素，也可使用选区属性中的清除按钮。AI 的 `delete_pixels`、`clear_selection_pixels` 继续可用。图章工具：Alt 点击当前图层取样，再涂抹目标区域；也可在属性中输入取样坐标，方便触屏使用。每次笔画从开始时的图层快照取样，避免重复复制新画出的像素。取色器采集可见图层合成色及透明度。

## 新增常用绘制工具

| 工具 | 快捷键 | 用法 | AI action | 对应测试 |
| --- | --- | --- | --- | --- |
| 文字 | T | 输入多行文字，点击添加独立可编辑文字图层；字号 8–512，支持粗体和系统字体名称；选中文字图层后可更新内容 | `add_text_layer`、`edit_text_layer`、`rasterize_layer`，兼容 `draw_text` | 创建、移动/旋转后修改文字、项目恢复、栅格化；旧像素文字仍测选区空洞与撤销 |
| 基础形状 | U | 拖动绘制矩形、椭圆、直线、箭头；矩形/椭圆支持描边与填充 | `draw_shape` | 四类形状、描边内部、图块边界、选区与撤销/重做 |
| 油漆桶 | F | 点击填充相邻近似颜色；选区空洞阻断连通，不跨越未选中区域 | `fill_region` | 连通性、颜色边界、透明图层、选区阻隔与撤销/重做 |
| 渐变 | 属性选择 | 拖动定义颜色方向，支持线性/径向；填充选区或拖动矩形 | `draw_gradient` | 两种渐变、颜色方向、反向拖动、选区与撤销/重做 |

文字工具创建独立可编辑图层；像素笔刷与滤镜要求先栅格化文字。旧 `draw_text` 仍可把文字直接绘到当前像素图层并使用选区遮罩。无选区的油漆桶默认以当前图层像素边界为范围；空图层的手动操作使用可见画布范围，AI 操作需要指定范围。渐变有选区时可水平或垂直拖动，无选区时必须拖出有宽高的矩形。像素绘制使用实际选区遮罩，支持图层位移、负坐标、撤销/重做；操作范围单边最多 4096 像素。手动操作在松开指针时提交，取消触控操作不会留下修改。

智能抠图使用已配置的图片连接、模型和 TokenNest 图片分组，请求透明背景并把结果放入新图层，保留原图。真实透明度与抠图效果取决于模型能力。边缘背景颜色较接近的图片也可使用本地去背景，无需请求 AI。

## 裁剪、变换与局部修图

| 工具 | 快捷键 | 用法 | AI action | 对应测试 |
| --- | --- | --- | --- | --- |
| 裁剪图层 | R | 拖动矩形或沿用精细选区，点击应用，仅保留当前图层选区内像素 | `crop_layer` | 矩形/空洞遮罩、负坐标、透明度、图层属性、撤销来源独立 |
| 自由变换 | 属性选择 | 输入宽高、角度与水平/垂直斜切，可锁定比例或关闭平滑缩放；统一收纳翻转和 90° 旋转 | `transform_layer` | 缩放、任意旋转、斜切、蒙版随图变换、中心位置、旧操作兼容、超限/退化拒绝 |
| 马赛克 | P | 涂抹局部细节；也可一键应用到选区或当前图层，像素块 2–128 | `pixelate` | 颜色均值、透明度、选区空洞、跨图块一致性、撤销/重做和取消 |
| 局部明暗 | O | 减淡/加深笔刷，强度 1–100%；同一笔不重复叠加强度 | `exposure_brush` | 两种相反方向、透明度、选区限制、冻结笔画来源、撤销/重做 |

裁剪删除当前图层范围外的像素，不改变画布坐标，也不裁剪其他图层；精细选区中的空洞保留为透明。自由变换针对整个当前图层，忽略选区，围绕内容中心缩放/旋转；原有翻转和 90° 旋转统一使用此实现。两者先创建独立图块，再提交到图层历史，撤销/重做可切换完整图层状态。变换尺寸 1–4096，顺时针角度 -360°–360°；旋转后的外接图像同样不得超过单边 4096。

马赛克以画布世界坐标对齐像素块，按透明度加权计算块内颜色，保留每个像素的原始透明度。局部明暗改变 RGB 并保留透明度。两种笔刷均按实际选区遮罩修改，每笔读取开始时的原图快照；触控取消时恢复整笔修改。`get_state` 的 `editing` 字段返回当前像素块、明暗模式/强度和变换属性。

## 智能体接口

在已连接画布客户端的智能体会话中调用现有 `canvas_tool`，无须添加另一套凭证或地址。先调用 `list_sessions`、`select_session`、`get_state`；`list_tools` 返回按用途分组的工具及操作名。所有坐标均为画布世界坐标，允许负值。

| action | 主要参数 |
| --- | --- |
| `select_lasso` | `points`，至少 3 点 |
| `select_brush` | `points`、`brush`，笔刷 1–160 像素 |
| `select_ellipse` | `x`、`y`、`width`、`height` |
| `select_wand` | `x`、`y`、`tolerance`，选择当前图层相邻近似颜色 |
| `invert_selection` | 在文档或可见内容边界内反选 |
| `delete_pixels` | 有选区时删除选中像素；否则需要 `points` 或 `x/y/toX/toY` 与 `brush` |
| `clone_stamp` | `sourceX`、`sourceY`、目标 `points`、`brush` |
| `sample_color` | `x`、`y`，返回 `color` 和 `alpha` |
| `draw_text` | `x/y` 顶部定位、`text`（1–2000 字符）、`fontSize`、`fontFamily`（系统字体名称或通用字体）、`bold`、`color` |
| `draw_shape` | `x/y/toX/toY`、`shape: rectangle \| ellipse \| line \| arrow`、`brush`（线宽）、`filled`、`color` |
| `fill_region` | `x/y` 种子点、`color`、`tolerance`；可指定 `boundsX/boundsY/width/height`，否则使用选区或图层像素边界 |
| `draw_gradient` | `x/y/toX/toY` 定义方向、`color`、`secondaryColor`、`gradientKind: linear \| radial` |
| `crop_layer` | 使用当前实际选区，或显式 `x/y/width/height`（仍受已有精细选区限制） |
| `transform_layer` | `transform: resize-rotate`、`targetWidth/targetHeight`、`angle`、`smoothing`；仍支持 `flip-x/flip-y/rotate` |
| `pixelate` | `blockSize`；可用 `points/brush` 涂抹，或 `x/y/width/height` 范围，默认选区/当前图层内容 |
| `exposure_brush` | `points/brush` 或 `x/y/toX/toY`、`exposureMode: dodge \| burn`、`strength` |
| `export_selection_mask` | `outputPath`，必须为新的绝对 PNG 路径；不覆盖已有文件 |
| `generate` | `mode`、`prompt`，继续使用已配置图片连接 |

选区操作可传 `selectionMode: replace | add | subtract | intersect`，默认 `replace`。`get_state` 返回选区边界与 `selectionKind`。导出的遮罩按这些边界定位，选中部分为不透明白色，未选中部分为透明；图片编辑供应商需要的遮罩由应用转换为透明表示可编辑。

新增绘制接口颜色为 `#RRGGBB`，修改当前图层，隐藏图层返回错误；参数错误在修改像素前拒绝。界面和 AI 接口共用 `applyDrawingCommand`，不需要请求图片生成模型。

```json
{"action":"draw_text","x":40,"y":40,"text":"作品标题\n说明文字","fontSize":32,"bold":true,"color":"#123456"}
```

```json
{"action":"draw_shape","shape":"arrow","x":40,"y":100,"toX":240,"toY":100,"brush":6,"color":"#ff0000"}
```

```json
{"action":"fill_region","x":20,"y":20,"boundsX":0,"boundsY":0,"width":512,"height":512,"color":"#ffffff","tolerance":20}
```

```json
{"action":"draw_gradient","x":0,"y":0,"toX":512,"toY":512,"color":"#ff0000","secondaryColor":"#0000ff","gradientKind":"linear"}
```

```json
{"action":"crop_layer","x":0,"y":0,"width":512,"height":512}
```

```json
{"action":"transform_layer","transform":"resize-rotate","targetWidth":768,"targetHeight":512,"angle":15,"smoothing":true}
```

```json
{"action":"pixelate","blockSize":16,"points":[{"x":100,"y":100},{"x":200,"y":100}],"brush":48}
```

```json
{"action":"exposure_brush","exposureMode":"burn","strength":20,"points":[{"x":100,"y":100},{"x":200,"y":100}],"brush":24}
```

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

## 基础图像编辑工作台

左侧“编辑工作台”集中提供文档、图层、选区、文字、滤镜和导出属性。已有工具继续承担对应绘制操作；文字、变换、局部润色均只有一个工具入口，兼容旧 AI action。

| 功能 | AI 接口与参数 | 对应验证 |
| --- | --- | --- |
| 画布大小/背景 | `set_document`: `x/y/width/height/background`；`infinite=true` 恢复无限画布 | 文档参数校验、背景与尺寸、项目恢复 |
| 图像大小/文档裁剪 | `resize_document`: `width/height/smoothing`；`crop_document`: 当前选区边界或 `x/y/width/height`，`trim=false` 只改文档框 | 多图层相对位置、重采样、参考线/选区随尺寸变化、裁掉外部像素 |
| 参考线/网格/吸附/标尺 | `set_guides`: `guides:[{axis:"x"或"y",value}]`、`grid/snap`；工作台显示坐标刻度 | 吸附到参考线和文档边界、超限与非法参数 |
| 图层混合/锁定/剪贴 | `set_layer`: `blendMode/locked/alphaLocked/clipping`；16 种混合模式 | 真实叠底/滤色像素、剪贴透明度、隐藏底层、锁定后拒绝编辑 |
| 蒙版 | `set_layer_mask`: `maskMode=reveal/hide/selection/remove/enable/disable`；`paint_layer_mask`: `points/brush/reveal`；`apply_layer_mask` | 显隐不损坏源像素、移动后绘蒙版、移除/停用/应用、项目保存 |
| 分组/对齐/合并 | `group_layers`: `layerIds/group`；`set_group`: `group/name/visible`；`align_layers`: `layerIds/alignment`；`flatten_layers` | 分组重命名与显隐、按选区/文档对齐、合并保留隐藏图层 |
| 全选/羽化/扩展/收缩/反选 | `select_all`；`modify_selection`: `operation/radius`；`select_polygon`: `points/selectionMode` | 形态学像素、边缘羽化、文档范围反选、多边形遮罩 |
| 选区填充/描边 | `fill_selection`: `color`；`stroke_selection`: `color/brush`，宽度 1–128 | 填充多个断开的选区，描绘外边缘与空洞边缘，保持内部透明 |
| 复制/剪切/粘贴 | `copy_pixels/cut_pixels/paste_pixels`；粘贴可指定 `x/y` | 遮罩形状/透明度/世界坐标，剪切不修改历史来源；应用内部像素剪贴板 |
| 可编辑文字 | `add_text_layer/edit_text_layer/rasterize_layer`: `text/fontSize/fontFamily/bold/color` | 修改经过移动、旋转的文字，保留变换、蒙版、图层 ID 与存储来源 |
| 色阶/曲线/色彩平衡 | `filter`: `filter=levels/curves/color-balance`；`black/white/gamma`、递增 `curve:[{x,y}]`、`red/green/blue` | 查表、插值、范围校验与透明度保持 |
| 基础滤镜 | `filter`: `invert/threshold/posterize/sharpen/noise/blur`，`amount`；可传 `points/brush` 限制范围 | 选区空洞、跨图块采样、固定种子杂色、独立历史来源 |
| 局部润色 | `retouch_brush`: `retouchMode=blur/sharpen/smudge`、`points/brush/strength` | 模糊/锐化限于笔画、涂抹沿拖动携带颜色，保留透明度 |
| 修复画笔 | `heal_stamp`: `sourceX/sourceY/points/brush`；Alt 点击取样 | 转移源纹理并匹配目标平均颜色，保持目标透明度与选区 |
| 笔刷硬度/不透明度 | `paint/erase`: `points/brush/color/hardness/brushOpacity` | 同一笔交叠不重复累积不透明度、软边、透明度锁定、撤销 |
| 多格式导出 | `export_image`: `format=png/jpeg/webp`、`quality=.1–1`、`selectionOnly`、`outputPath` | 真实格式头、尺寸/背景/遮罩；JPEG 透明背景转白；桌面路径扩展名与浏览器 MIME |
| 历史 | `get_history/undo/redo` | 最大 50 步，像素/图层/选区/文档变更均进入历史，保存项目保留当前状态 |

快捷键：Ctrl/Cmd+A 全选，C 复制，X 剪切，V 粘贴；Ctrl/Cmd+Z 撤销，Shift+Z 或 Y 重做；X 交换前景背景色，D 恢复黑白。输入框内保留标准文字编辑快捷键。

```json
{"action":"set_document","x":0,"y":0,"width":1024,"height":768,"background":"transparent"}
```

```json
{"action":"set_layer_mask","maskMode":"selection"}
```

```json
{"action":"filter","filter":"curves","curve":[{"x":0,"y":0},{"x":128,"y":155},{"x":255,"y":255}]}
```

```json
{"action":"transform_layer","targetWidth":600,"targetHeight":400,"angle":10,"skewX":12,"smoothing":true}
```

```json
{"action":"export_image","format":"webp","quality":0.9,"outputPath":"C:\\Exports\\artwork.webp"}
```

文件范围是应用 `.tbcanvas` 项目和常见图片。项目保留图层像素、蒙版、文字来源、混合/锁定/分组/剪贴属性、文档和参考线，兼容旧项目；撤销历史与内部剪贴板不持久化。桌面 AI 导出要求新的绝对路径，不覆盖已有文件。

当前是 8 位 RGB 像素编辑：文档与精细栅格操作单边最多 4096 像素；分组为一层命名分组，滤镜直接修改像素；修复画笔是局部纹理与平均颜色匹配。尚未实现 Photoshop 的嵌套组、智能对象、矢量路径、透视变形、CMYK/高位深色彩管理和专业内容识别修复，不应把这些列为已支持。

## 手机版布局与触控

画布工作区宽度不足 1000px，或宽度不超过 1100px 的短横屏，以及 Android 嵌入模式，使用全宽画布、底部常用工具和按需打开的面板。全部工具仍按原有分组提供；属性、图层、文件和会话收进弹层，竖屏从底部展开，短横屏从右侧展开。输入控件避让可视键盘区域，底部工具栏保留安全区。

默认单指操作当前工具、双指平移缩放；第二根手指落下时撤回尚未完成的单指编辑，剩余手指抬起前不会重新绘画。属性面板可启用并记住“手指仅导航”，用触控笔绘画。触控笔可接管单指编辑，笔画期间忽略手指接触。手机和桌面复用原有编辑命令与 AI 接口。

`bun run scripts/test-canvas-mobile.ts` 使用生产组件和实际 CSS，在隔离 Chromium 中检查 320px、390px、短横屏、Android 样式、桌面和容器尺寸切换；验证工具与文件入口、图层、键盘可视区域、最近图片预览和指针撤销行为。指针与键盘采用模拟输入，不能替代实机触控笔、系统键盘与 Android 返回键验证。先运行 `bun run electron:build:renderer`；加 `--screenshots` 可在 `.tmp/` 保存布局截图。

## 运行测试

`bun test ./apps/electron/src/renderer/pages/studio ./apps/electron/src/shared/canvas-export.test.ts ./packages/session-tools-core/src/handlers/canvas-drawing-schema.test.ts ./packages/session-tools-core/src/handlers/canvas-retouch-schema.test.ts ./packages/session-tools-core/src/handlers/canvas-photoshop-schema.test.ts ./packages/session-tools-core/src/handlers/canvas-tool.test.ts`

`bun run scripts/test-canvas-retouch.ts` 在隐藏 Electron/Chromium 窗口中验证真实 Canvas 合成，包括负坐标、图层位移、选区空洞、跨图块图章、撤销、调色和透明度，并执行 `canvas-drawing.browser.ts`、`canvas-editing.browser.ts` 和 `canvas-photoshop.browser.ts` 中新增工具的实际像素测试及保存恢复；使用临时隔离配置，不访问真实用户画布或 AI 服务。
