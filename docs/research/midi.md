# MIDI 文件播放与谱面同步

## 使用
- 与谱子一起选择 `.mid` / `.midi`，或在已有谱面上使用「添加音频」后选择 MIDI。
- MIDI 作为播放来源，仍需配套 PDF、图片或受支持的 MusicXML；当前不从 MIDI 生成谱面。
- 导入完成显示「MIDI 同步」和「合成音色」；沿用播放、暂停、跳转、光标、缓冲和翻页定位。
- 全程在浏览器本地处理；PDF / 图片仍使用已授权的本机识谱服务。

## 实现
- `media-file.ts` 统一扩展名 / MIME 分类，混合选择时不会把 MIDI 当成谱页。
- `midi.ts` 校验 SMF 文件和事件边界，通过 `@tonejs/midi` 提取带真实秒数的音符；正确应用 PPQ、默认速度和速度变化。
- `midi-alignment.ts` 比较绝对音高集合与完整起音顺序，尝试各声部及所有有固定音高声部的合并。
- 和弦允许 30 ms 内不同音高起音，同声部重复同音必须具有独立起音；不跳过参考事件，不按平均时长分配页面。
- 多个候选完整匹配但时间不同会拒绝，提示导出对应完整声部。
- 对齐方法为 `midi-notes`，锚点直接取 MIDI 音符时间；覆盖值 1 表示完整序列一致，不是实弹准确率。
- `import-midi.ts` 在匹配成功后生成统一音色 WAV，继续使用 `HTMLAudioElement.currentTime` 驱动已有播放器。
- 保存 `ScoreAudio.kind=midi`、原始 MIDI Blob、合成 WAV 和时间轴；旧音频记录无需迁移。
- 导入可取消，失败不覆盖原谱面；合成采用分片计算和资源限制。
- 原件 / 重排沿用稳定事件时间锚点；重新识谱读取原始 MIDI，不把合成 WAV 当作 MIDI 解析。

## 支持边界
- SMF 0 / 1、PPQ 时间基准、变速、音符力度、休止、和弦与多个有固定音高的声部。
- MIDI 最多 5 MB / 8 分钟 / 10000 个音符；谱面参考仍最多 2400 个事件、20 页。
- 固定合成音色，不还原 General MIDI 乐器音色或外部音色库；鼓轨不参与播放和对齐。
- SMF 2、SMPTE 时间基准、弯音、延音踏板等尚未支持的音高 / 时值控制会明确拒绝。
- 这是文件播放，不是 MIDI 键盘、USB 设备或 Web MIDI 实时输入。
- 谱面与 MIDI 需为同一完整声部 / 顺序；额外装饰音、未展开反复、缺段和识谱错误可能导致拒绝。

## 样例
- `tests/fixtures/guitar-study.musicxml` + `tests/fixtures/guitar-study.mid`：96 音符、3 页，约 43 秒。
- MIDI 内含真实 72 → 84 → 66 BPM 变化、前静音、页间停顿和力度变化。
- `guitar-study-wrong.mid` 全部升高半音，用于验证拒绝不匹配输入。
- `guitar-study-invalid.mid` 是损坏文件头，用于验证解析错误。
- `node scripts/create-midi-fixture.mjs` 可重建上述三个文件，不修改原始 MusicXML。

## 验证
- 25 项 MIDI 相关自动化测试，覆盖解析 / 合成 / 音符匹配 / 原文件恢复与取消；全项目 106 项 JS 测试通过。
- 桌面和 390px 浏览器验证上传、播放、自动翻页、双视图光标、拖动、刷新恢复和错误拒绝。
- 截图见 `docs/design-references/midi-*.png`；这些是控制样本验证，不代表任意 MIDI 或谱面都能匹配。

## 依赖
- [Tonejs/Midi](https://github.com/Tonejs/Midi) 2.0.28，MIT；仅使用解析库，不请求云端或外部音色。
