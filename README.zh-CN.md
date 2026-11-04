# dsh-superagent

[English](README.md) | **简体中文**

> **仅供研究参考的原型，不是 DeepSeek 的官方产品。** 这份代码源自我们团队的日常开发工作，其中大部分工程由编码智能体完成。请把它当作研究代码，而不是可投入生产的软件。它仍可能包含缺陷，编码风格与工程实践也可能不一致。在你自己的环境中使用前，请先审查并调整。
>
> 我们为公开发布做了调整，因此它不同于我们的内部版本，也不同于《Exploring Super-agent Design: Towards a More Autonomous Agent System》一文描述的实现。文章中讨论的一些设计属于未来发展方向，并未在这个原型中实现。

dsh-superagent 是一个面向单个 GitHub 仓库的主动式编码智能体，打包为 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的 bundle。它监听 GitHub，也可以选择监听飞书。当获允许的人向智能体请求工作时，它会开一个工作项，在自己的智能体会话和目录中处理，并在原对话中作答，例如给出一个 pull request。一个 Web 面板显示哪些事项需要人处理。

它也是一种与智能体协作的方式：**占用尽可能少的人工注意力，提供尽可能多的价值。** 一个能为整个团队行动的智能体，也可能浪费整个团队的注意力；因此它只在被请求时、或在团队写下的规则允许时行动，并且只在有人必须行动、或能使用结果时才说话。[000 理念](docs/zh/000-philosophy.md)说明了这条原则，以及它对运营者的要求。

## 安装配置

安装配置步骤很多，因此由智能体和你一起完成。请让你的编码智能体执行：

> 阅读本仓库的 SETUP.zh-CN.md，和我一起安装配置 dsh-superagent。

它一次只问一个简短的问题，一次性展示完整计划，然后安装并配置好一切。它遵循的是 [SETUP.zh-CN.md](SETUP.zh-CN.md)。

## 文档

请按顺序阅读编号文档；每篇只建立在此前的文档之上。

- [000 理念](docs/zh/000-philosophy.md)
- [001 领域模型](docs/zh/001-domain.md)
- [002 授权机制](docs/zh/002-authorization.md)
- [003 执行](docs/zh/003-execution.md)
- [004 提示词](docs/zh/004-prompts.md)
- [005 面板](docs/zh/005-panel.md)
- [006 部署](docs/zh/006-deployment.md)：手动安装配置、配置、升级和故障排查
- [007 架构](docs/zh/007-architecture.md)
- [008 实操手册](docs/zh/008-cookbook.md)：新增一个来源

运行时提示词和技能文件也有简体中文参考译本，分别位于 [`prompts/zh-CN/`](prompts/zh-CN/)、[飞书技能](skills/dsh-superagent-feishu/SKILL.zh-CN.md) 和 [GitHub 技能](skills/dsh-superagent-github/SKILL.zh-CN.md)。运行时仍只加载英文原件。

## 开发

`pnpm check` 会运行类型检查、测试和构建。

## 许可证

[MIT](LICENSE)
