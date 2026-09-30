# Weeksync 参考站

来源：[weeksync.app](https://weeksync.app/?ref=onepagelove)。抓取日期：2026-09-29。

## 已保存的公开源码

- 目录：`references/weeksync/`。
- HTML 1 份、CSS 2 份、JavaScript 11 份、字体 11 份，共 25 项，947,155 字节。
- [manifest.json](../../references/weeksync/manifest.json) 记录 URL、本地路径、状态、大小及 SHA-256。
- 所有资源成功保存；清单中的 25 个文件均已重新计算哈希确认。
- [抓取脚本](../../scripts/capture-reference.mjs)：`node scripts/capture-reference.mjs`。
- `--reuse-html` 使用已有 HTML，再抓取其中显式引用的资源。
- 抓取范围是同源 HTML、链接到的 CSS / JS、CSS 引用的字体与声明的 source map。
- 未下载跨域统计脚本、宣传图像、视频，也未执行下载到的 JS。

这是生产站向浏览器公开提供的源码快照，不是原始开发仓库。
页面使用 Next.js，组件已打包压缩；下载文件内没有公开的 `sourceMappingURL`。
页面及所下载 JS 中未发现项目仓库链接；仅见第三方 `core-js` 的许可证链接。
不据此推断原始 TSX、后端、账号系统或构建配置已经取得。

## 视觉依据

[CSS 摘录](../../references/weeksync/design-excerpts.css) 保留原样规则与原文件位置。

| 项目 | 原站值 |
| --- | --- |
| 页面框底 | `#cec9c0` |
| 框外背景 | `body.landing-page { background-color: #d2d2d2 }` |
| 纸面 | `#f9f7f3` |
| 强调色 | `#dfe296` |
| 文字 / 点线 | `#000` |
| 圆角 | `33.12rem` |
| 点线边框 | `4.032rem dotted #000` |
| 外侧留白 | `15rem` |
| 左侧固定栏 | 宽 `371rem`、高 `100vh` |
| 字体 | `Red Hat Mono`，正文常规、局部斜体 |
| 正文 | `12em`、行高 `132%`、字距 `.03em` |

原站桌面根字号为 `calc(1vw / 14.4)`，1440px 宽时 `1rem = 1px`。
这些 rem 数值属于参考站的缩放体系，随弦采用正常字号时须转换。
桌面与移动布局断点为 `1023px`；移动端隐藏左侧固定栏，改为顶部菜单。

## 动效依据

[JS 摘录](../../references/weeksync/motion-excerpts.txt) 保存原始代码及字符偏移。
主要证据来自 `assets/_next/static/chunks/app/page-ff4abee83e8efd56.js`。

| 行为 | 触发与实现 | 原站参数 |
| --- | --- | --- |
| 滚动内容 | 自写 `LoopScroll`，逐帧更新 `translate3d` | `requestAnimationFrame` |
| 滚轮惯性 | 每帧衰减速度 | `friction: .55`、`speedFactor: .25` |
| 点击定位区段 | 逐帧插值到目标进度 | `1600ms`、`easeInOutQuad` |
| 导航高亮 | 监听 `loopscroll:progress` | 命中视口高度 `33%` 的区段 |
| 文字逐字出现 | `IntersectionObserver` 进入后开始 | 阈值 `.3`，每字 `15 / 30 / 50ms` |
| 按钮花括号展开 | hover 改变文字两侧间距 | `7.2rem → 14.4rem`，`.2s ease` |
| 剪刀张合 | 由滚动阶段驱动两个刀片旋转 | 正负 `20°`，hover `.25s ease-out` |
| 票据进出 | 由滚动进度驱动平移与旋转 | 横移最大 `20vw`、纵移正负 `150vh`、旋转正负 `12°` |
| 移动菜单 | 顶部移入 | `.35s cubic-bezier(.22,.61,.36,1)` |

点击滚动缓动公式：`t < .5 ? 2*t*t : 1 - (-2*t + 2)**2 / 2`。
原站桌面复制内容形成循环滚动；固定侧栏不随内容一起移动。
文字尚未出现的部分保留排版空间，仅设透明，避免逐字出现造成换行跳动。
没有把原站描述为弹簧动画；已确认的关键实现是惯性滚动与时间插值。

## 随弦采用方式

- 保留灰米色底、黑色点线框、固定侧栏、括号按钮和宽松排版。
- 原型文案使用简短中文；装饰字体与中文回退字体分开设置。
- 跨页缓冲由演奏进度驱动，同一条谱面轨道连续移动。
- 下一页先进入视野，缓冲区展开后再推进；翻页时不销毁正在可见的谱面。
- 按钮保留轻微展开，谱面运动保持稳定，避免把票据的大角度旋转带入读谱区域。
- 原站的无限循环和剪刀用于理解动效节奏，不是随弦读谱流程的必要功能。

截图和浏览器交互检查由主任务记录；本文件区分源码证据与随弦适配决策。
