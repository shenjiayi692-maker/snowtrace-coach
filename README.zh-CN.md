<p align="center">
  <img src="./public/og.png" width="100%" alt="Snowtrace — see the gap, ride the fix">
</p>

<p align="center">
  <a href="https://snowtrace-coach.sjysjy.chatgpt.site"><strong>打开 Snowtrace</strong></a>
  · <a href="./docs/BETA_RUNBOOK.md">Beta 手册</a>
  · <a href="./docs/ANALYSIS_DEPLOYMENT.md">部署分析服务</a>
</p>

<p align="center"><a href="./README.md">English</a> · <strong>中文</strong></p>

# Snowtrace

Snowtrace 是一个以"置信度优先"为原则的单板刻滑教练。骑手上传一段参考片段和一段自己骑行的片段；系统先判断素材是否可用，再对齐可比的转弯阶段，找出一处有意义的动作差距，返回一个有证据支撑的训练动作。

本仓库是第一个纵向切片，不是成品教练产品。Web 端不展示示例教练内容：它在上传前先检查 worker 可用性，并且只显示经质量闸门的分析服务实际返回的证据。

## 这套系统拒绝比较什么

<p align="center">
  <img src="./assets/readme/gates.svg" width="100%" alt="两段片段依次通过六道可比性闸门：素材质量、骑手身份、机位视角、归一化、关键点可靠性、统计下限。其中五道可以让整次运行停在一个具体的诚实非答案上，第四道改写坐标而不拒绝。只有全部通过的比较才会变成一处教练差距，语言模型也只在这一点上被调用。第七层是离线评测套件，它检查这些闸门是否真的会关上。">
</p>

这个仓库里几乎每一个工程决策都来自同一条规则：**两个测量值只有在"它们之间的差异在两段片段里含义相同"时才允许被比较。** 其余一切都是推论，而代码做的大部分事情是拒绝。

教练类产品只有一个方向的失败是要命的。不是漏掉了一个观察——拿不到答案的骑手再拍一次就是了。而是给出一条自信的指令，而它其实是素材的假象：参考片段是侧拍而骑手是背拍、两位骑手站姿相反、被比较的两个弯在相反的刃上。每一种都会产出一个干净、合理、完全错误的数字。所以下面每一道闸门都被允许终止整次运行，且没有任何一道被允许"降低置信度然后继续"。

| 闸门 | 什么情况下比较无效 | 取而代之发生什么 |
| --- | --- | --- |
| 素材质量 | 模糊、镜头稳定性、曝光、骑手占画面比例、可用转弯数中任一项独立不达标 | 要求重拍，并点名是哪一项没过。模糊或稳定性被卡会进一步限制哪些指标能够存在 |
| 骑手身份 | 画面里不止一个人可被追踪，且主体存在歧义 | 分析暂停并询问是哪位骑手，给出代表帧的框选，然后在选定轨迹上重跑 |
| 机位视角 | 两段片段声明的视角不同 | 该配对被拒绝。每种视角另有自己的指标白名单——正/背面素材只支持七个指标中的三个，因为 2D 投影摧毁了其余的 |
| 站姿、刃、阶段、方向 | 前后脚、heelside/toeside、转弯阶段或屏幕移动方向没有对齐 | 这道闸门改写而不是拒绝：指标按片段各自归一化，使 heelside 只与 heelside 配对、顶点只与顶点配对 |
| 关键点可靠性 | 某个必需关键点被遮挡，或追踪缺口超过 250 ms | 只有依赖该关键点的指标掉出，其余继续。长缺口绝不通过插值被桥接进教练证据 |
| 统计下限 | 置信度低于 0.70、效应量相对骑手自身噪声底低于 1.0、或配对转弯少于两个 | "未找到可靠差距"作为一个真实结果返回，而不是一条弱建议 |

语言模型位于全部六道之后。它可以为一个**已被接受的**比较重新措辞；它不能选择指标、不能选择训练动作、不能引入任何数字。[`docs/LLM_COACHING_CONTRACT.md`](./docs/LLM_COACHING_CONTRACT.md) 是被强制执行的边界，而 `lib/coaching.ts` 里的确定性模板即使在渲染器启用之后仍然是生产环境的兜底。

[`docs/decisions.zh-CN.md`](./docs/decisions.zh-CN.md) 给出每条边界背后的理由、被否掉的替代方案，以及这个选择付出的代价。

## 谁来检查这些闸门

六道会拒绝的闸门，其价值不超过"它们真的会拒绝"这件事的证据。所以 `evals/` 是第七层，它唯一的主题就是前面那六道。它离线运行，不改变任何运行时行为，只测量和提出建议，不做重新设计。

- `evals/gate_surface.py` 扫过质量闸门接受的每一个标量，报告判定在哪里翻转。在 15,972 种配置中，有 33.8% 的评分高到足以拿 `full`，却被单独一条硬阈值降级为 `limited`——而给骑手看的 readiness 数字并不解释这件事。
- `evals/degrade.py` 用已知的量去损坏一段已知良好的素材，于是施加的损坏本身就是标签。它发现流水线自己生成的分析代理片正在摧毁闸门随后要评分的清晰度信号——系统在评判一段它自己降过质的素材，并把责任归到骑手的拍摄上。
- `evals/abstention.py` 守住最要命的那个结果：一段片段与它自己比较必须产出零条教练差距，而一个明显真实的差异必须产出一条。任何一项单独都能被"永远什么都不说"的组件满足。它在 0.11 秒内跑完，不需要视频、MediaPipe 或 FFmpeg。

设计里的四个弃权用例中有三个被刻意没有写。它们需要尚不存在的素材或一个活的任务队列，而对着 mock 写出来只会测试 mock 本身。

## 已经建成的部分

- 移动优先的 Web 流程：目标 → 参考片段 → 骑手片段 → 拍摄情境 → 质量检查 → 处理 → 单一差距报告，附可检视的 Show Me 证据
- 上传前的浏览器端检查：时长、分辨率、方向、曝光、清晰度，让不可用的片段在上传之前就失败
- Worker 端媒体归一化：尊重手机显示旋转，把定帧率和变帧率统一转换为零基 CFR 30 fps，并在运行时拒绝超过一帧的时基漂移
- 独立的 Python 分析服务，基于 FFmpeg、OpenCV 和 MediaPipe Pose Landmarker 任务模型，刻意保持可替换
- 版本化的 `coach-report-v1` 载荷，在服务端构建并持久化，终态回调幂等，另有 12 分钟的回调丢失看门狗
- D1 中的 session、video、track、turn、metric、evidence、report、drill、progression、feedback 表；R2 存放源视频和代理视频，并有带鉴权的保留期清理
- 受 bearer 保护的教练复核队列，以及一套为期七天、KPI 闸门预先约定的 beta 协议（[`docs/BETA_RUNBOOK.md`](./docs/BETA_RUNBOOK.md)）

MVP 只做单板刻滑。它不声称测量力、压力、精确的板刃角度或物理上准确的 3D 测量，也不训练自有视觉模型。

## 仓库地图

- `app/`：Snowtrace Web 纵向切片
- `lib/analysis.ts`：浏览器端共享的分析契约与质量辅助函数
- `lib/coaching.ts`：共享的确定性报告契约、校验器与置信度安全兜底
- `analysis/`：独立的 MediaPipe/FFmpeg 分析服务及其测试
- `evals/`：离线套件，测量质量闸门和比较层是否真的会拒绝；弃权检查完全不需要视频
- `docs/decisions.zh-CN.md`：为什么是这些边界而不是别的，每条都写明代价
- `docs/LLM_COACHING_CONTRACT.md`：面向未来 Responses API 集成的严格证据渲染边界
- `docs/BETA_RUNBOOK.md`：20 人 beta 协议、独立复核、KPI 闸门与 go/no-go 规则
- `docs/ANALYSIS_DEPLOYMENT.md`：单容器 worker 部署、密钥、Sites 接线与生产冒烟测试
- `db/schema.ts`：D1 应用表结构
- `drizzle/`：生成的 D1 迁移
- `worker/`：Sites worker 绑定类型
- `tests/`：渲染后的 Web 流程冒烟测试

## 跑 Web 应用

需要 Node.js 22.13 或更新版本。

```bash
npm ci
npm run dev
```

验证：

```bash
npm run lint
npm run typecheck
npm test
```

`npm test` 会在 `dist/` 产出 Sites 兼容的构建，验证服务端渲染的入口体验，并针对本地 D1/R2 兼容测试替身跑完整的 create → upload → queue → status → delete API 生命周期。

## 跑分析服务

该服务需要 Python 3.11 或 3.12，以及 FFmpeg/ffprobe。默认使用仓库内置的 MediaPipe 任务模型。

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e analysis
.venv/bin/uvicorn snowtrace_analysis.api:app --host 127.0.0.1 --port 8080
```

验证：

```bash
.venv/bin/python -m unittest discover -s analysis/tests -v
```

配对分析端点接受短时效的 HTTPS 下载 URL、可选的短时效代理上传 URL、每段片段的机位模式与站姿、一个共享的声明视角、每段片段显式的屏幕移动方向和首个完整转弯的刃标签，以及可选的选定骑手轨迹 ID。屏幕方向只在指标坐标系中被规范化；刃标签保证 heelside 转弯只与 heelside 配对、toeside 只与 toeside 配对。生产环境可用 `SNOWTRACE_SOURCE_HOSTS` 限制接受的源主机。`/v1/jobs` 增加了一层带鉴权的异步封装，并把经质量闸门的结果投递到白名单内的 HTTPS 回调。

单次本地分析：

```bash
.venv/bin/snowtrace-analyze rider.mp4 --output result.json
```

若要做零月度成本的 concierge beta，用仓库内的启动脚本在 loopback 上启动受 token 保护的 worker：

```bash
export SNOWTRACE_JOB_TOKEN='<analysis_service_token>'
./scripts/run-local-analysis.sh
```

该启动脚本没有 token 就拒绝启动，会校验 FFmpeg、ffprobe、虚拟环境、MediaPipe 模型和请求的端口，把 worker 限制为同时只跑一个分析，并刻意禁用本地文件 URL。它只绑定 `127.0.0.1`；开隧道是一个独立且显式的部署步骤。免费本地 beta 手册及其可用性限制见 [`docs/ANALYSIS_DEPLOYMENT.md`](./docs/ANALYSIS_DEPLOYMENT.md)。

在不发送视频、也不暴露服务 token 的前提下验证 localhost 或最终的 HTTPS 隧道：

```bash
npm run worker:check -- http://127.0.0.1:8080
npm run worker:check -- https://<worker-host>
```

## 部署形态

Web UI 用 Vinext 构建，通过 Sites 部署。`.openai/hosting.json` 声明：

- D1 绑定：`DB`
- R2 绑定：`VIDEOS`

Python 分析服务刻意保持独立，以便在一个带 FFmpeg 和 MediaPipe 的、对 CPU 友好的容器里运行。预期的生产链路是：浏览器 → 签名的 R2 上传 → D1 分析任务 → Python 服务 → D1 报告/证据记录 → Web 报告。

当 Sites 中配置了 `ANALYSIS_SERVICE_URL`、`ANALYSIS_SERVICE_TOKEN` 和 `ANALYSIS_SIGNING_SECRET` 时，排队一次运行会把它派发给 Python 服务。短时效的 HMAC 媒体授权让该服务只能下载这次运行关联的两段视频，并上传 720p 代理片。回调存储原始的版本化输出以及排序后的证据；运行时密钥缺失会让任务诚实地停在排队状态，而不是伪造一个结果。

UI 从不展示示例教练报告。一个完成的任务会落到真实证据、骑手选择、可执行的重拍结果、无可靠差距结果，或一个技术性重试状态之一。

M0 的 Web 路径目前使用同源流式上传，每段片段上限 95 MB，以保持在常见的 Worker 请求上限之下。在提高体积上限之前，应把这条传输通道换成直传对象存储的分片上传。

## 产品护栏

- 低置信度的片段会被拒绝或被限制；它绝不会产出自信的教练措辞。
- 当身份存在歧义时，分析暂停等待骑手选择，而不是默默跟随画面里最大或最近的那个人。
- 每一条教练结论都必须链接到骑手可以亲自检视的阶段和时间点。
- 一份报告只包含一处主要差距和一个训练动作，不是一张清单。
- CASI、AASI、JSBA 之类的体系标签是可选参考，不是真值来源。
- 当服务证据不可用时，UI 绝不用示例值顶替。
