<div align="center">

# 🤖 Code Insight Panel

**为你的代码提供实时 AI 分析的 VS Code 扩展**

[![Version](https://img.shields.io/visual-studio-marketplace/v/huanxiaomang.hxm-ai-analyzer-panel?style=flat-square&logo=visual-studio-code&logoColor=white&color=blue)](https://marketplace.visualstudio.com/items?itemName=huanxiaomang.hxm-ai-analyzer-panel)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/huanxiaomang.hxm-ai-analyzer-panel?style=flat-square&logo=visual-studio-code&logoColor=white&color=green)](https://marketplace.visualstudio.com/items?itemName=huanxiaomang.hxm-ai-analyzer-panel)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/huanxiaomang.hxm-ai-analyzer-panel?style=flat-square&logo=visual-studio-code&logoColor=white&color=yellow)](https://marketplace.visualstudio.com/items?itemName=huanxiaomang.hxm-ai-analyzer-panel)
[![License](https://img.shields.io/github/license/huanxiaomang/vscode-ai-anaylsis-panel?style=flat-square&color=orange)](https://github.com/huanxiaomang/vscode-ai-anaylsis-panel/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/huanxiaomang/vscode-ai-anaylsis-panel?style=flat-square&logo=github&color=red)](https://github.com/huanxiaomang/vscode-ai-anaylsis-panel)

</div>

---

![预览](images/preview.webp)

## 📖 简介

Code Insight Panel 是一个非常方便的 VS Code 扩展，通过可自定义的多维度分析视图，为你的代码提供实时 AI 分析。帮助你更好地理解代码结构、发现潜在问题并获得优化建议。

实习过的肯定都知道，自己一个人看组内项目都很复杂很难懂，文件很多每次看一个文件都问一次 AI 不现实，这个插件正是解决这个问题，在看大型复杂项目快速浏览多个文件时，主动提高效率。

### ✨ 核心特性

- **实时同步**: 切换文件时自动跟随更新
- **多维度分析**: 自定义分析维度（概览、实现、优化等）
- **智能缓存**: 分析结果持久化存储
- **主题自适应**: 自动跟随 VS Code 明暗主题切换

---

## 🚀 快速开始

### 安装

打开 VS Code 扩展面板，搜索 `Code Insight Panel`即可安装，安装后要自行配置 apiKey 来使用

## ⚙️ 配置指南

我是婴儿，看不懂下面一大堆文字教程怎么办？

[婴儿图文教程](docs/babyREADME.md)

### 必需配置

在使用前，需要配置 AI 服务相关参数。打开 VS Code 设置（`Ctrl+,`），搜索 `Code Insight Panel`：

#### 1. API Key (`codeInsightPanel.apiKey`)

你的 OpenAI API Key 或兼容服务的 API Key

```json
"codeInsightPanel.apiKey": "sk-xxx..."
```

#### 2. API Endpoint (`codeInsightPanel.apiEndpoint`)

API 服务地址，默认为 OpenAI，也可使用其他兼容服务

```json
"codeInsightPanel.apiEndpoint": "https://api.openai.com/v1/chat/completions"
```

#### 3. Model (`codeInsightPanel.model`)

使用的 AI 模型

```json
"codeInsightPanel.model": "gpt-4o-mini"
```

![设置界面](images/setting.png)

### 💡 推荐配置：使用硅基流动（免费）

[硅基流动](https://siliconflow.cn/) 提供免费的 API Key，可直接使用以下配置：

```json
{
  "codeInsightPanel.model": "moonshotai/Kimi-K2-Instruct",
  "codeInsightPanel.apiEndpoint": "https://api.siliconflow.cn/v1/chat/completions",
  "codeInsightPanel.apiKey": "你的apiKey"
}
```

### 可选配置

#### 并发控制 (`codeInsightPanel.maxParallelRequests`)

设置最大并行 AI 请求数，默认为 30

```json
"codeInsightPanel.maxParallelRequests": 30
```

### 自定义分析维度

扩展默认提供三个分析维度，你可以在设置中自定义 `codeInsightPanel.tabs`：

```json
{
  "codeInsightPanel.tabs": [
    {
      "key": "summary",
      "title": "内容概览",
      "prompt": "请分析文件 ${fileName}，提供简洁的功能概述..."
    },
    {
      "key": "implementation",
      "title": "核心实现",
      "prompt": "详细说明文件 ${fileName} 的核心实现逻辑..."
    },
    {
      "key": "optimization",
      "title": "优化建议",
      "prompt": "针对文件 ${fileName}，提供具体的代码优化建议..."
    }
  ]
}
```

数组的每一项分别对应一个 tab：

![Tabs](images/tabs.png)

#### Tab 配置项说明

- `key`: Tab 的唯一标识符
- `title`: Tab 显示的标题
- `prompt`: AI 分析时使用的提示词

#### 提示词变量

在自定义提示词时，可以使用以下变量：

- `${fileName}`: 当前文件名
- `${codeContent}`: 当前文件完整代码

---

## 📚 使用教程

### 方式一：右键菜单

直接右键文件，选择 `启动 AI 分析视图`

### 方式二：命令面板

直接按 `Ctrl+Shift+P`（Mac: `Cmd+Shift+P`）打开命令面板，输入 `启动 AI 分析视图`，回车执行

<div align="center">

**如果这个项目对你有帮助，请给它一个 ⭐️！**

Made with ❤️ by [huanxiaomang](https://github.com/huanxiaomang)

</div>
