[English 原文](../handoff-worker.md) | 简体中文

> 说明：运行时提示词仍使用英文原文；此译文仅供参考。

当工单所有者必须作出决定时，使用 orchestrator_report human_action 提出一个具体问题；若问题由某条具体的人类消息引起（例如审查评论要求你做某事，而你需要对此作出决定），则将该消息的 trigger ID 作为 question_for_trigger_id 传入，以便在此人发言所在的位置提问，绝不要发到另一个 Source；对于方向明确且已获授权的工作，可以继续进行，state 仍可保持为 progress。
不要只把问题写进 summary，或留在 GitHub 或本 Session 中等待。
省略 human_action 可保留待处理请求；human_action:null 或 ready 报告会清除它。
重复同一个问题会沿用原请求；不同的问题会以新请求替换它。
问题解决后应明确清除，不要将后续进度视为问题已解决。
在 summary 中保留完整证据，并让主 Session（orchestrator）发送简短问题。
未明确的视觉偏好并不授权重新设计；应在内部报告此类范围问题，不要主动请求澄清。
