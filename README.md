# 随弦 Suixian

本地读谱应用：上传谱子，配合录音或 MIDI 播放、光标定位与平滑自动翻页。

## 功能
- PDF、图片、受支持的 MusicXML；保存原件和结构化乐谱，按屏幕宽度重新排版。
- MP3 / WAV 等浏览器可解码录音，或 `.mid` / `.midi` 文件，与谱面内容匹配。
- 播放 / 暂停、拖动进度、谱面光标、提前跨页缓冲和淡入淡出。
- 本地谱库；有音符参考时可使用实验性的麦克风跟随。

## 启动
需要 Node.js（支持 `--experimental-strip-types`）、npm 和 Python 3。

```sh
npm ci
npm run setup:omr  # 首次安装本机识谱引擎，当前安装脚本支持 macOS Apple Silicon
npm run dev
```

打开 <http://127.0.0.1:5173/>。前端使用 5173，本机识谱服务使用 5174。
只试 MusicXML 和 MIDI 时可运行 `npm run dev:web`，无需安装识谱引擎。

## 试用 MIDI
点击「上传谱子」，一起选择：
- [guitar-study.musicxml](tests/fixtures/guitar-study.musicxml)
- [guitar-study.mid](tests/fixtures/guitar-study.mid)

点击「识别并对齐」，完成后播放。已有谱子也可通过「添加音频」选择 MIDI。
样例约 43 秒，含变速和停顿；MusicXML 导入版为三页，重排页数随宽度变化。

## 验证
```sh
npm test
npm run test:omr
SUIXIAN_OMR_INTEGRATION=1 npm run test:omr  # 需先安装本机引擎
npm run build
npm run check:docs
```

## 边界与数据
- 音频和 MIDI 在浏览器处理；PDF / 图片识谱只发送到本机服务，不发送云端。
- 自动识谱、录音匹配和麦克风跟随仍是实验能力，不能保证任意谱面或实弹准确率。
- MIDI 需配套同曲谱子，使用统一合成音色；暂不支持实时 MIDI 设备、弯音或延音踏板。
- 谱库保存在当前浏览器，清除站点数据会删除已保存的文件；无云同步。
- 详细格式限制、运行说明与实现状态见 [文档](docs/index.md)；MIDI 边界见 [MIDI 文件说明](docs/research/midi.md)。
