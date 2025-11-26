# AI Code Analyzer Panel

一个强大的 VS Code 扩展,为你的代码提供实时 AI 分析。通过可自定义的多维度分析视图,帮助你更好地理解代码结构、发现潜在问题并获得优化建议。

## ✨ 主要特性

- 🚀 **自动启动**: IDE 启动时自动打开分析面板
- 🔄 **实时同步**: 切换文件时,分析面板自动跟随更新
- 💾 **智能缓存**: 分析结果持久化存储,重启 IDE 后无需重新分析
- 📝 **多维度分析**: 支持自定义多个分析维度(概览、实现细节、优化建议等)
- 🎯 **右键快捷**: 文件树中右键即可启动 AI 分析
- ⚡ **流式输出**: 实时显示 AI 分析结果,无需等待
- 🔧 **高度可配置**: 支持自定义 API、模型和分析提示词

## 📦 安装

1. 在 VS Code 扩展市场搜索 `AI Code Analyzer Panel`，或访问https://marketplace.visualstudio.com/items?itemName=huanxiaomang.hxm-ai-analyzer-panel
2. 重启 VS Code

## ⚙️ 配置

在使用前,需要配置 AI 服务相关参数。打开 VS Code 设置(Ctrl+,),搜索 `AI Code Analyzer`:

### 必需配置

1. **API Key** (`aiAnalyze.apiKey`)

   - 你的 OpenAI API Key 或兼容服务的 API Key
   - 示例: `sk-xxx...`

2. **API Endpoint** (`aiAnalyze.apiEndpoint`)

   - API 服务地址
   - 默认: `https://api.openai.com/v1/chat/completions`
   - 也可使用其他兼容 OpenAI 格式的服务

3. **Model** (`aiAnalyze.model`)
   - 使用的 AI 模型
   - 默认: `gpt-4o-mini`
   - 可选: `gpt-4`, `gpt-3.5-turbo` 等

推荐使用硅基流动

可以直接复制下方代码：

```json
"aiAnalyze.model": "moonshotai/Kimi-K2-Instruct",
"aiAnalyze.apiEndpoint": "https://api.siliconflow.cn/v1/chat/completions",
"aiAnalyze.apiKey": "你的apiKey",
"aiAnalyze.debounceTime": 1,
}
```

### 自定义分析维度

扩展默认提供三个分析维度,更改后会在视图中显示。你可以在设置中自定义 `aiAnalyze.tabs`:

```json
{
  "aiAnalyze.tabs": [
    {
      "key": "summary",
      "title": "内容概览",
      "prompt": "分析这个文件的整体功能..."
    },
    {
      "key": "implementation",
      "title": "核心实现",
      "prompt": "详细说明这个文件的实现细节..."
    },
    {
      "key": "optimization",
      "title": "优化建议",
      "prompt": "提供代码优化建议..."
    }
  ]
}
```

**提示词变量**:

- `${fileName}`: 当前文件名
- `${codeContent}`: 当前文件完整代码

## 🎯 使用教程

### 方式一: 自动启动(推荐)

1. 打开 VS Code
2. 分析面板会自动在右侧打开
3. 打开任意代码文件,分析会自动开始
4. 切换文件时,分析面板会自动更新

### 方式二: 右键菜单

1. 在文件资源管理器中找到要分析的文件
2. 右键点击文件
3. 选择 **"启动 AI 分析视图"**
4. 分析面板打开并开始分析该文件

### 方式三: 命令面板

1. 按 `Ctrl+Shift+P` (Mac: `Cmd+Shift+P`) 打开命令面板
2. 输入 `启动AI分析视图`
3. 回车执行
