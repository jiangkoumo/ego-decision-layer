# 第三方代码

本项目包含从下列项目翻译（Python → JavaScript）或改写而来的代码。按其许可要求，随附版权与许可声明。

---

## jev-ultrafast — Browser Use

- **来源**：https://github.com/browser-use/jev-ultrafast （对照 revision `c32df93`）
- **许可**：MIT License — Copyright (c) 2026 Browser Use
- **涉及范围**（分级依据见 [`THIRD-PARTY-ASSESSMENT.md`](THIRD-PARTY-ASSESSMENT.md)，
  并排证据见 [`bench/raw/third-party-excerpts.md`](bench/raw/third-party-excerpts.md)）：
  - `scripts/decider-loop.mjs` 的**响应校验** `validateChoice`（判据顺序与阈值 `0.02` / `1e-6` 一致）
  - `scripts/decider-loop.mjs` 的**动作执行器**（动作前检查序列、下拉可用性谓词、
    鼠标按下/抬起、`selectAll` 的平台修饰键常量 `4` / `2`）
  - `scripts/decider-loop.mjs` 的**观测层元素表构建**（部分子步骤）
  - **提示词规则** `NEXT_ACTION` / `TARGET`
  - **动作后等待**（`after_input` 段）
  - **dynamic operation + target 架构**

### MIT License

```
MIT License

Copyright (c) 2026 Browser Use

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## citrolabs/ego-lite

- **来源**：https://github.com/citrolabs/ego-lite （MIT）
- **性质**：本项目的**运行基础**（通过 `ego-browser` 驱动），**未再分发**其任何代码或文档。
  根目录的 `SKILL.md` 是本项目自己撰写的附加技能，装在应用包之外。

---

## @modelcontextprotocol/sdk（可选 MCP 入口的运行时依赖）

- **来源**：npm `@modelcontextprotocol/sdk`，固定版本 **1.32.2**（`mcp/package.json`、`mcp/package-lock.json`）
- **许可**：MIT
- **涉及范围**：仅 `mcp/` 目录导入（stdio server/client 传输）；**未复制或修改其源码**，也不进入核心引擎、
  CLI 与安装脚本的运行依赖。不装 `mcp/node_modules` 时仓库其余部分行为不变。
- **性质**：v1.x 维护线，实现到 2025-11-25 的 MCP 规范。
