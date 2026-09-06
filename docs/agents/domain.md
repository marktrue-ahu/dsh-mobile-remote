# Domain Docs

Engineering skills 探索 codebase 时，应如何消费这个 repo 的 domain documentation。

## Before exploring, read these

- repo 根目录的 **`CONTEXT.md`**；
- **`docs/adr/`** 中与你即将处理区域相关的 ADR。

如果这些文件不存在，静默继续。producer skill（`/grill-with-docs`）会在 terms 或 decisions 实际被解决时懒创建它们。

## File structure

这是 single-context repo：

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

当输出命名 domain concept 时，使用 `CONTEXT.md` 中定义的 term。不要漂移到 glossary 明确避免的 synonyms。

如果需要的概念还不在 glossary 中，这是一个信号：要么重新考虑是否正在发明项目没有使用的语言，要么通过 `/grill-with-docs` 记录缺口。

## Flag ADR conflicts

如果输出与现有 ADR 矛盾，明确指出，而不是静默覆盖。
