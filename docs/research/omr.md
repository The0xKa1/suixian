# 本地识谱与音频时间轴

## 处理范围
- 用户已授权增加本机服务；浏览器将渲染后的谱页发往 `127.0.0.1:5174`。
- 不把谱子或音频传到云端；音频解码、特征提取和时间轴对齐仍在浏览器完成。
- 服务支持原始 PDF 的渲染页面、PNG、JPEG、WebP；每页保留上传顺序。
- 印刷五线谱使用真实 Audiveris 5.11.0；音高、和弦、声部、休止与时值来自其 MusicXML 输出。
- 简单六线谱使用本机 Tesseract；识别六根弦和品位数字，按标准吉他定弦 E2–A2–D3–G3–B3–E4 计算音高。
- TAB 仅识别音高顺序；`beat` / `durationBeats` 是顺序占位值，实际时间由上传音频对齐得到，不声称读取了 TAB 节奏。
- MusicXML 不需要 OMR；其格式支持范围见 [MusicXML](musicxml.md)。
- 通过识谱校验的五线谱同时返回完整 MusicXML 供重新排版；TAB 缺真实节奏时仅返回音符参考，明确标记重排不可用。

## 实现
- `server/omr_service.py`：本机 HTTP 接口、格式校验、任务互斥、临时目录、逐页识别。
- `server/musicxml_reference.py`：合并同步声部和和弦，按四分音符读取时值、休止和拍号。
- 页内延音线合并到最初起音，不把延音终点误认为新的弹奏；跨页或缺失端点的延音线拒绝导入。
- `server/tab_ocr.py`：横线检测、六线分组、长横线与小节线消除、逐弦数字 OCR、未覆盖墨迹检查。
- `server/local_process.py`：统一管理 Java、Tesseract 和图像转换进程；取消请求或终止服务时结束所属子进程。
- 音符位置使用“原页面序号 + 页内音乐顺序比例”，不使用重新排版后的 MusicXML 页码。
- `server/omr_geometry.py` 从 Audiveris `.omr` 原生档案提取原图尺寸、音符边界、谱行与节奏槽，并校验 MusicXML 小节数量与时值。
- `event.cursor` 保存归一化原图 x / y / height 与 system；TAB 直接使用品位和六根弦的像素位置，不用重排的 MusicXML 坐标。
- 上传音频可按匹配音符显示移动光标，并在缓冲中保持当前行可见；麦克风模式仍按整页跟随。
- 对齐质量不够时不生成可播放时间轴，保留谱面并显示错误；识谱成功本身不等于音频已对齐。

## 明确限制
- OMR 是识别结果，可能漏音、错音或错节奏；没有“任意谱子精确识别”的保证。
- 原图尺寸、小节或坐标缺失 / 不一致时省略光标，仍可使用已通过验证的页级音频对齐；旧记录需重新导入获取坐标。
- 印刷五线谱优先；手写、简谱、模糊拍照、复杂记号暂未验证。
- 五线谱与 TAB 混排图片目前拒绝；避免把两套记谱重复当成两个声部。
- TAB 仅支持清晰、近水平的六线数字谱、0–24 品、标准定弦、无变调夹。
- TAB 不是通用吉他技法识别；推弦、击勾弦、滑音、泛音、哑音、特殊定弦和反复不受支持。
- TAB 的 OCR 置信不足或剩余未识别墨迹会拒绝；未识别的定弦说明仍可能导致错误，需核对来源是否标准定弦。
- 五线谱输出中的反复、D.C. / D.S. / Coda、移调乐器、无固定音高音符会拒绝；需使用展开顺序、实音 MusicXML。
- 装饰性倚音不占主时间轴，原录音中的装饰音仍可能降低对齐质量。
- 不支持图片跨页延音线和不完整小节续接；独立识别每页不能可靠恢复这些上下文。
- 合奏、嘈杂录音、变速、自由节奏与实际设备仍需更多样本验证。
- 当前引擎安装脚本仅支持 Apple Silicon macOS，依赖系统 `sips`；其他平台需单独适配。

## 本地运行
```sh
npm run setup:omr
npm run dev
```
- 安装脚本下载官方约 85 MB 的 Audiveris DMG，验证固定 SHA-256，解包到忽略的 `.tools/audiveris/`。
- 使用安装包自带的 Java，不在系统应用目录安装应用，也不更改系统 Java。
- Audiveris 使用本地英文 Tesseract 数据；缺少时从 Tesseract 官方仓库下载。
- 简单 TAB OCR 需要命令行 `tesseract`；当前电脑已安装，其他电脑可用 `brew install tesseract`。
- `npm run dev` 管理前端和 OMR 生命周期；单独运行可用 `python3 server/omr_service.py`。
- 健康接口：`GET /api/health` 返回 `{service:"suixian-omr", ready, engine, busy}`。
- 识谱接口：`POST /api/recognize`，JSON `{pages:[{src:"data:image/...;base64,...",width,height}]}`。
- 成功返回 `{reference:{events,initialTempo?},engine,notationSources,notationUnavailable?}`；每份结构来源含 XML、原页序、起始拍和时长。错误返回 `{error}` 和非 2xx 状态。
- 每次 1–20 页；单图 30 MB，解码后合计 45 MB，请求 80 MB，单页不超过 4000 万像素。
- 单页识别最多 150 秒，全任务最多 10 分钟；同一时间只处理一份谱子。
- 服务临时谱页、MusicXML 与引擎日志在任务结束后删除；完整 XML 经响应返回浏览器并随谱库保存，服务不建立用户文件缓存。
- 限定回环监听、Host 与本机前端 Origin；拒绝外部 URL、伪造图像签名、XML 实体和过大输入。

## 验证与来源
```sh
python3 -m unittest discover -s server -p 'test_*.py' -v
SUIXIAN_OMR_INTEGRATION=1 python3 -m unittest discover -s server -p 'test_*.py' -v
```
- 自动测试覆盖和弦/声部/休止、页码、延音、反复、异常数值、XML 实体、来源限制和取消清理。
- 24 项测试通过，含真实 Audiveris 与 Tesseract；覆盖完整 XML 记号保留、跨页偏移、TAB 降级、原图坐标与取消清理。
- `server/fixtures/cucaracha.png` 来自 [Audiveris 5.11.0 的独立印刷样本](https://github.com/Audiveris/audiveris/blob/5.11.0/data/examples/cucaracha.png)。
- `cucaracha-first-system.png` 是其首行 5 小节裁剪；`cucaracha-expected.json` 按印刷谱人工读出旋律与低音，不由 OMR 生成。
- 此样本的真实引擎输出有 24 个起音；浏览器两页端到端验证使用独立预期音符合成的录音。
- `standard-tab.png` 为本项目原创测试谱；预先指定的 16 个品位音高与实际 Tesseract 输出逐项一致。
- 受控样本只证明这条处理链工作，不代表真实录音、任意乐谱或所有扫描质量的准确率。
- [Audiveris 源码及版本](https://github.com/Audiveris/audiveris/tree/5.11.0)，许可证 [AGPL-3.0](https://github.com/Audiveris/audiveris/blob/5.11.0/LICENSE)。
- [Tesseract](https://github.com/tesseract-ocr/tesseract) 与 [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) 使用 Apache-2.0；外部引擎独立执行，来源与版本保留在安装目录。
