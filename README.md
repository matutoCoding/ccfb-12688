# POV Fan Studio · 全息广告风扇内容编排与上机效果预览系统

跑在浏览器端的全息广告风扇（POV，视觉暂留）内容编排与真机成像预览系统。
**TypeScript + WebGL2 + IndexedDB**，素材全程本地处理、不上传任何服务器，产出物以文件形式交付客户。

## 快速开始

```bash
npm install
npm run dev        # 开发，默认 http://127.0.0.1:5173
npm run build      # 类型检查 + 生产构建到 dist/
npm run test       # 核心算法单元测试（18 项）
npm run preview    # 预览生产构建
```

推荐使用最新版 Chrome / Edge（需要 WebGL2，RGBA16F 浮点缓冲不可用时自动回退 RGBA8）。

## 五个页面与功能落位

| 页面 | 对应需求 | 核心实现 |
| --- | --- | --- |
| 素材库 `/library` | ① | 视频本地入库、入出点逐帧裁剪、源时间码持久化、替换源同时间码自动重链、断链手动重链、`.cube` LUT 导入、同片段多调色方案切换对比、五星评分×时长区间×关键词组合筛选 |
| 画布编排 `/canvas` | ⑨ | 行业模板新建（带画布尺寸与占位框）、替换占位素材自动适配设备灯珠数/直径、极坐标扇环编辑、模板版本升级与打开时同步提示 |
| 预览台 `/preview` | ②③⑤⑥ | 300–1800rpm 滑杆、顺/逆时针、固定时间步 POV 成像、电压漂移/突变注入、PWM 校正前后分屏、环境光传感器断连告警与手动回退 |
| 导出中心 `/export` | ⑦⑧ | POVF 二进制包 + CRC32、逐帧安全半径扫描与帧号/红标、`.povf` 回读校验、U 盘播放日志解析、素材上播统计/异常标记/分布图、Markdown 验收报告 |
| 设备设置 `/devices` | ④⑤⑥ | 序列号/分组/场地登记、倒挂侧装姿态角自动补偿、RGB 白平衡（绑定序列号）、PWM 校准表 CSV 导入导出、照度-亮度锚点曲线拖拽编辑、档案 JSON 换电脑恢复、断连事件日志 |

## 成像保真度：为什么拖转速不抖、不频闪（最关键约束）

真机上 LED 灯带高速旋转，靠人眼视觉暂留把一圈圈离散灯珠拼成图像。本系统的渲染链路
（`src/render/`）在四个层面与真机对齐：

1. **固定时间步子步进（240Hz 仿真，`SIM_HZ`）**
   `requestAnimationFrame` 只负责把余晖缓冲上屏，仿真以固定 `SIM_DT` 推进，
   与显示器刷新率（60/120/144Hz）完全解耦，杜绝转速与刷新之间的拍频条纹。

2. **物理时间 → 机械角的实测映射（`sector-mapper.ts`）**
   真机控制板按编码器脉冲实测每圈周期 `T`，电压波动使 `T` 漂移。
   `SectorMapper` 消费实测周期序列，任意物理时刻的机械角都由该时刻所属圈的实测周期插值得到，
   内容帧按其应出现的物理时刻查映射贴到正确扇形区间——**转速突变时画面不拉伸、不压缩**。
   着色器使用的逆映射 LUT（机械角→内容帧）在 CPU 预算，天然处理漂移下的非单调关系。

3. **余晖缓冲 + 时间常数衰减（`PERSISTENCE_SEC = 50ms`）**
   两个浮点纹理 ping-pong，每帧按 `exp(-dt/τ)` 指数衰减，`dt` 是真实流逝时间，
   与转速无关，模拟视网膜/灯珠余晖，亮度在任意转速下保持一致。

4. **片元级解析扫掠四边形**
   每个仿真子步把扇叶在该步扫过的角区间作为解析区域，片元着色器按半径+角度采样，
   任意转速下扇区连续、无径向缝隙或频闪条带。

辅助保真链路：
- **PWM 非线性校正**（`pwm.ts`）：占空比→感知亮度 256 点 1D LUT 纹理，支持实测 CSV 逐通道导入，预览台可分屏对比校正前后；
- **白平衡**：RGB 三通道增益 + 整体亮度，系数绑定设备序列号；
- **环境光自适应**（`ambient.ts`）：照度→亮度多锚点单调曲线，传感器断连自动回退手动亮度并写设备日志；
- **姿态补偿**：倒挂/侧装的补偿角在条带合成与着色器两处统一旋转。

## 固件数据包格式（POVF v1，小端）

| 偏移 | 长度 | 字段 | 说明 |
| --- | --- | --- | --- |
| 0 | 4 | magic | `POVF`（0x46564F50 LE） |
| 4 | 1 | version | `0x01` |
| 5 | 2 | ledCount | U16 灯珠数 |
| 7 | 2 | frameCount | U16 每圈帧数 |
| 9 | 2 | fps | U16（= framesPerRevolution） |
| 11 | 1 | flags | bit0 = 存在安全半径越界 |
| 12 | N | payload | `frameCount × ledCount × 3` 字节 RGB |
| 末尾 | 4 | crc32 | IEEE 802.3，覆盖前面全部字节 |

打包前对每帧逐灯珠检查归一化半径（含 8% 中心死区）是否超过安全半径，
越界像素进入 `violationMask`，预览台红色标注，并在导出信息中给出帧号与越界灯珠数。
`.povf` 文件可在导出中心回读并重新校验 CRC。

## 目录结构

```
src/
  types.ts                 领域模型（素材/片段/工程/设备/模板/日志…）
  lib/
    db.ts                  IndexedDB Promise 封装（Blob 直接入库）
    store.ts               响应式仓库 + 持久化
    crc32.ts               CRC32（测试向量 "123456789" → CBF43926）
    timecode.ts            源时间码、帧对齐、逐帧微调
    video.ts               视频入库/指纹/取帧/替换重链
    lut.ts                 .cube 解析 + 三线性插值 CPU 套用
    pwm.ts                 PWM 校正曲线、CSV 解析
    ambient.ts             照度-亮度锚点曲线
    sector-mapper.ts       编码器周期→机械角映射、正/逆扇形 LUT
    telemetry.ts           电压漂移/突变遥测仿真（确定性，无随机数）
    export.ts              POVF 打包/校验、设备档案与工程导入导出
    playback-log.ts        U 盘日志解析、统计、验收报告
    seed.ts                内置行业模板、设备工厂
  render/
    pov-renderer.ts        WebGL2 POV 渲染器（余晖 ping-pong + 扫掠片元）
    strip-builder.ts       极坐标内容条带合成（含 LUT/姿态补偿）
    preview-engine.ts      预览链路编排（rAF + 固定步仿真 + 传感器）
  app/                     五个页面、弹层、曲线编辑器、hash 路由、外壳
tests/core.test.ts         18 项纯算法测试
```

## 关键设计取舍

- **零运行时第三方依赖**：仅 `vite`、`typescript`、`vitest` 三个开发依赖。WebGL2、IndexedDB、Canvas、Blob/ObjectURL 全部使用浏览器原生能力，离线可用、便于内网部署。
- **视频帧提取走 Canvas 2D + `seek`**：浏览器无法直接拿到编码帧，采用 `HTMLVideoElement.seek` 到目标时间码后绘制，帧缓存按 `片段:帧号` 复用避免重复 seek；条带刷新节流到约 12Hz。
- **LUT 在 CPU 套用**：条带合成分辨率即灯珠数（百级），逐像素三线性插值开销可接受，且库内预览、画布合成、导出包走同一份调色代码，避免 GPU/CPU 两套实现色差。
- **遥测仿真确定性**：漂移用双频正弦叠加而非随机数，相同输入产生相同周期序列，保证测试可复现、画面无随机抖动。真机联调时 `SectorMapper.pushRevolution` 可直接喂编码器实测数据，仿真层整体替换。
- **本地文件指纹**：FNV-1a（文件名+大小+头部 256KB 采样），避免大文件全量哈希；替换源沿用素材 id，片段以源时间码引用从而自动重链。

## 真机联调接入点

- 编码器脉冲：把每圈实测周期喂给 `PreviewEngine.mapper.pushRevolution(tEnd, periodSec)`，替换 `TelemetrySimulator`；
- 环境光传感器：`PreviewEngine.setAmbientLux(lux)` 与 `setSensorConnected(false/true)`；
- 固件下发：导出中心生成的 `.povf` 即控制板输入，CRC 与内存布局见上表；
- 播放日志：设备端按 `deviceSerial,materialCode,startEpoch,endEpoch,rpmAvg` CSV 行写出，U 盘回读即可解析。
