# 文档与目录

## 阅读顺序
1. [项目情况](project.md)：当前能力、限制和下一步。
2. [交接记录](handoff.md)：本轮结果、运行与验证。
3. [算法研究](research/score-following.md)：论文、实现和实验边界。
4. [MusicXML](research/musicxml.md)：支持格式和导入验证。
5. [本机识谱](research/omr.md)：引擎安装、支持格式与识别边界。
   [结构化乐谱](research/structured-score.md)：双视图、语义模型、重排和音频锚点。
6. [MIDI 文件](research/midi.md)：本地合成、音符对齐与测试样例。
7. [参考站分析](research/reference.md)：公开源码、视觉和动效证据。
8. [项目约定](../AGENTS.md)：工作流程、文案与文档维护。

## 目录结构
```text
suixian/
├── README.md                    启动、MIDI 试用与验证入口
├── AGENTS.md                    工作约定
├── .codegraph/                  本地结构索引
├── package.json                 依赖和命令
├── index.html                   页面入口
├── vite.config.ts               开发与构建
├── tsconfig.json                TypeScript 配置
├── src/
│   ├── main.tsx                 React 入口
│   ├── App.tsx                  路由、谱库、上传窗口
│   ├── styles.css               字体、全局视觉、响应式
│   ├── types.ts                 乐谱与参考接口
│   ├── components/
│   │   ├── ScoreReader.tsx      阅读、听音与交互
│   │   ├── ScoreReader.css      阅读器布局与动效
│   │   └── MusicIcon.tsx        自绘 24 格线稿图标
│   ├── hooks/
│   │   ├── useScoreFollowing.ts 听音状态与生命周期
│   │   ├── useNotationView.ts   重排加载、视图选择与原件回退
│   │   ├── useAudioPlayback.ts  本地音频播放、暂停与时间读取
│   │   ├── useTrackSpring.ts    谱面轨道弹簧，直接写 DOM
│   │   └── usePageGestures.ts   拖动、轻扫、触控板与滚轮换页
│   └── lib/
│       ├── demo-score.ts        原创 TAB 与 192 音符参考
│       ├── import-score.ts      本地导入入口、PDF / 图片
│       ├── library.ts           IndexedDB 谱库
│       ├── recognize-score.ts   本机识谱请求、取消与结果校验
│       ├── notation.ts          完整 MusicXML、稳定 ID 与语义索引
│       ├── notation-layout.ts   实际谱行几何与音符位置映射
│       ├── notation-render.ts   本地 SVG 排版与完整谱行组页
│       ├── notation-alignment.ts  布局无关音频锚点及阅读位置映射
│       ├── notation*.test.ts    结构保留、坐标与音频重映射测试
│       ├── import-audio.ts      录音解码、MIDI 分流
│       ├── media-file.ts        音频 / MIDI 扩展名与 MIME 分类
│       ├── import-midi.ts       MIDI 导入、对齐和合成接入
│       ├── import-midi.test.ts  配套文件导入与播放数据验证
│       ├── midi.ts              SMF 校验、解析与本地 WAV 合成
│       ├── midi.test.ts         时序、格式、取消与合成验证
│       ├── midi-alignment.ts    MIDI 音符与整份谱面对齐
│       ├── midi-alignment.test.ts  和弦、声部与错误匹配验证
│       ├── audio-alignment.ts   整曲匹配与音频 / 谱面位置映射
│       ├── audio-alignment.test.ts  PCM、拒绝错误匹配与资源测试
│       ├── audio-buffer.ts      匹配页界前后的双页缓冲窗口
│       ├── audio-buffer.test.ts 连续性、短页限幅与倒退定位测试
│       ├── audio-cursor.ts      实际音符时间与谱面光标坐标映射
│       ├── audio-cursor.test.ts 光标换行、缺失坐标与可见性测试
│       ├── score-cursor-legacy.ts  旧版已知 SVG 的坐标恢复
│       ├── score-cursor-legacy.test.ts  坐标一致性与拒绝误推断
│       ├── transition.ts        跨页坐标与谱页淡入淡出
│       ├── transition.test.ts   连续性、淡化与可读性测试
│       ├── motion.ts            弹簧、回弹阻尼与手势落点
│       ├── motion.test.ts       弹簧与手势换页测试
│       ├── score-import/musicxml.ts  简化六线谱解析与排版
│       └── score-following/
│           ├── types.ts         音符、帧、位置接口
│           ├── chroma.ts        FFT、音高特征、起音
│           ├── follower.ts      局部 HMM 跟随
│           ├── microphone.ts    Web Audio 采集与清理
│           ├── index.ts         算法导出
│           ├── follower.test.ts 合成音频与定位测试
│           └── microphone.test.ts  权限与资源竞态测试
├── public/
│   ├── favicon.svg              随弦标记
│   └── fonts/                   本地字体、OFL、SOURCES.txt
├── references/weeksync/         原站公开构建快照及哈希清单
├── scripts/
│   ├── dev.mjs                 前端与本机识谱进程管理
│   ├── setup-omr.py            下载并校验本地识谱引擎
│   ├── create-midi-fixture.mjs   配套 MIDI、变速与异常输入样本
│   ├── create-audio-fixture.mjs  可变速度 TAB 合成录音
│   ├── create-omr-audio-fixture.mjs  独立按印刷谱合成的验证录音
│   ├── capture-reference.mjs    抓取公开参考资源
│   ├── check-docs.mjs           文档 150 行检查
│   ├── create-test-fixtures.mjs PDF 验证样本
│   └── create-musicxml-fixture.mjs  TAB 与异常输入样本
├── server/                      仅监听本机的识谱服务
│   ├── omr_service.py           HTTP、输入限制、任务调度
│   ├── musicxml_reference.py    OMR 音符解析、原始页序与声部合并
│   ├── omr_geometry.py          原图音符边界、谱行与节奏槽坐标
│   ├── tab_ocr.py               标准六线谱品位数字 OCR
│   ├── local_process.py         识谱进程取消与清理
│   ├── test_omr.py              解析、识别与输入校验测试
│   ├── test_notation.py         完整 XML、来源偏移与 TAB 降级测试
│   └── fixtures/               公开印刷谱、独立预期音符、原创 TAB
├── .tools/                      本机 OMR 引擎与依赖，不进入前端构建
├── tests/fixtures/              PDF、图片、MusicXML、WAV、MIDI 验证样本
└── docs/
    ├── index.md                 本目录
    ├── project.md               项目情况
    ├── handoff.md               交接记录
    ├── design-references/       当前界面；notation-* 双视图、cursor-fixed-height-* 光标、midi-* 播放验收
    └── research/
        ├── reference.md         参考站依据
        ├── score-following.md   论文与跟随算法
        ├── musicxml.md          TAB 导入边界
        ├── midi.md              MIDI 文件支持与边界
        ├── omr.md               本机识谱安装、边界与验证
        ├── structured-score.md  结构化乐谱与双视图约定
        └── components/          阅读器、导入模块规格
```

`node_modules/`、`dist/` 为依赖和生成产物，`.codegraph/` 为本地索引。
每轮结束同步本目录、项目情况与交接记录；每份 Markdown 不超过 150 行。
