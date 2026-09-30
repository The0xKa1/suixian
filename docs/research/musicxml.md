# MusicXML 六线谱导入

## 格式依据
- [MusicXML 4.0 note](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/note/)
- [divisions 与 duration](https://www.w3.org/2021/06/musicxml40/musicxml-reference/examples/divisions-and-duration-elements/)
- [六线谱 string / fret](https://www.w3.org/2021/06/musicxml40/musicxml-reference/examples/technical-element-tablature/)
- [print 分页](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/print/)

## 当前实现
- 入口：`src/lib/score-import/musicxml.ts`，原生 DOMParser，本地解析。
- 输入：未压缩的 `.musicxml` 或 `.xml`，score-partwise，单乐器。
- 选取带弦号/品位的目标谱表；按 backup / forward / chord 还原音符起点。
- 根据弦号、品位、定弦与变调夹生成实际 MIDI 音高。
- 默认标准调弦 E2 A2 D3 G3 B3 E4；可读取完整六弦 staff-tuning。
- 时值单位除以 divisions，统一为四分音符拍数；同起点音符合并为和弦事件。
- 延音线续音不产生新的起音事件；休止保留时间轴，不生成有声音符。
- 重新排成每页 4 行六线谱，支持 print 的 new-page，最多 80 小节/20 页。
- 重排页码/行内位置与 reference.position 同时生成，避免音符定位与画面脱节。
- 每个事件另存实际渲染坐标 `cursor`，用于音频播放光标；旧版已知 SVG 按实际绘制的音符横坐标恢复，拒绝未知版式或有歧义的密集音符。
- 这里显示的是重排后的简化 TAB；拍号/连梁/表现记号并非完整乐谱排版器。

## 边界
- 不支持 MXL 压缩包、多个乐器、无弦号/品位的纯五线谱、七弦吉他。
- 反复/跳转、装饰音、推弦、泛音明确拒绝，避免产生错误的跟随路径。
- 原始 PDF/图片仍能阅读；不能由此推断已实现任意谱面的 OMR。
- 本模块不启动麦克风；参考音符交给听音模块使用。

## 验证样本
- `scripts/create-musicxml-fixture.mjs` 生成三页 TAB 与不支持格式的测试样本。
- `tests/fixtures/guitar-study.musicxml`：12 小节、96 起音、3 页。
- `guitar-repeat.musicxml`：验证反复段落拒绝。
- `not-tab.musicxml`：验证缺少弦号/品位时拒绝。
- `overflow.musicxml`、`empty-fret.musicxml`：验证时间轴溢出与空品位拒绝。
- 小节时间轴限制 64 拍，累加和除法结果均在解析阶段校验。
