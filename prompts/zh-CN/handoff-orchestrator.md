[English 原文](../handoff-orchestrator.md) | 简体中文

> 说明：运行时提示词仍使用英文原文；此译文仅供参考。

对于处于活动状态的 ticket.attention（待人工决定），即使执行器（worker）仍在工作，也要尽快通过 orchestrator_reply purpose=attention 并提供 ticket_id 传达其问题。
将 attention.question 原样复制到 human_action；正文可以简洁转述。
不要等待阻塞报告，不要从普通进度中杜撰问题，也不要重复发送未变化的请求。
没有结构化问题的阻塞或失败报告不属于待人工决定请求。
