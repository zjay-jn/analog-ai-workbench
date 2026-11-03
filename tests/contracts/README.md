# Quality evidence contracts

quality-gate-report.schema.json 是可提交的证据结构；具体 gate report、原始日志、截图、安装清单与 SBOM 必须进入被忽略的 .local/quality-evidence 或独立不可变 evidence bundle。

未运行的检查必须标 NOT_RUN。尚不存在或不适用的能力在摘要中标 NOT_AVAILABLE 或 N/A 并给出理由，不得作为 PASS 计数。
