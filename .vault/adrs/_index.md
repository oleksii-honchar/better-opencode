---
type: index
title: "Architecture Decision Records"
createdAt: "2026-06-08T18:32:00Z"
updatedAt: "2026-07-13T12:30:00Z"
tags: []
---

# Architecture Decision Records

Decisions about how better-opencode is built, configured, and maintained — captured as ADRs with context, alternatives, and consequences.

## Nodes

- [[0001-system-prompt-persistence.adr.md]] — Persist System Prompt in Session Database (ADR-0001, status: proposed)
- [[0002-hybrid-cli-background.adr.md]] — Hybrid Approach for DB Maintenance (ADR-0002, status: accepted)
- [[0003-existing-time-archived-cascade.adr.md]] — Use Existing time_archived + Cascade Deletion (ADR-0003, status: accepted)
- [[0004-wal-checkpoint-truncate.adr.md]] — Background WAL Checkpoint — TRUNCATE Mode (ADR-0004, status: accepted)
- [[0005-journal-size-limit.adr.md]] — PRAGMA journal_size_limit Instead of auto_vacuum (ADR-0005, status: accepted)
- [[0006-tool-output-age-deletion.adr.md]] — Tool Output Deletion on Age, Not Session Status (ADR-0006, status: accepted)
- [[0007-always-extract-skills.adr.md]] — metaSkillEnabled: Always Extract Skills to MetaState (ADR-0007, status: accepted)
- [[0008-leave-tools-transform-unchanged.adr.md]] — metaSkillEnabled: Leave toolsTransform Unchanged (ADR-0008, status: accepted)
- [[0009-grafana-v2-api-format.adr.md]] — Use Grafana v2 API Format (ADR-0009, status: accepted)
- [[0010-table-panels-for-log-stream.adr.md]] — Use Table Panels for Log Stream Instead of Native Logs Panel (ADR-0010, status: accepted)
- [[0011-datadog-log-explorer-ux.adr.md]] — Datadog Log Explorer UX Pattern (ADR-0011, status: accepted)
- [[0012-exclude-otel-metrics-panels.adr.md]] — Exclude OTEL Metrics Panels (ADR-0012, status: accepted)
- [[0013-hardcode-servicename.adr.md]] — Hardcode ServiceName Instead of Dashboard Variable (ADR-0013, status: accepted)
- [[0014-conditional-all-macro.adr.md]] — Use $__conditionalAll Macro for Multi-Select Variable Safety (ADR-0014, status: accepted)
- [[0015-dashboard-tags-include-logs.adr.md]] — Dashboard Tags Include `logs` for Discovery (ADR-0015, status: accepted)
- [[0016-clear-detector-history.adr.md]] — Stop Clearing Detector History on Clean Stream Completion (ADR-1, status: accepted)
- [[0017-tool-detection-gap-tolerance.adr.md]] — Add Tool-Only Detection with Gap Tolerance (ADR-2, status: accepted)
- [[0018-alternating-pattern-detection.adr.md]] — Add Period-2 Alternating Pattern Detection (ADR-3, status: accepted)
- [[0019-self-diagnosis-detection.adr.md]] — Self-Diagnosis Detection with Immediate Intervention (ADR-4, status: accepted)
- [[0020-detector-state-sharing.adr.md]] — Detector State Sharing — No Per-Thread Isolation Needed (ADR-5, status: accepted)
- [[0021-loop-reflection-in-nudges.adr.md]] — Agent-Persona-Coach Loop Reflection in Existing Nudges (ADR-6, status: accepted)
- [[0022-multi-provider-model-field.adr.md]] — Add models: Field to Agent Configuration (ADR-0022, status: accepted)
- [[0023-resolution-priority.adr.md]] — Resolution Priority — models Before model (ADR-0023, status: accepted)
- [[0024-exact-provider-match.adr.md]] — Provider Match — Exact Comparison (ADR-0024, status: accepted)
- [[0025-graceful-fallback.adr.md]] — Graceful Fallback — Not Hard Error (ADR-0025, status: accepted)
- [[0026-deprecate-model-fields.adr.md]] — Deprecate model: and modelPreset: After models: Implementation (ADR-0026, status: accepted)
- [[0027-parse-model-variant-return-type.adr.md]] — Extend `parseModel` Return Type to Include Variant (ADR-0027, status: accepted)
- [[0028-inline-variant-precedence.adr.md]] — Inline `:variant` Wins Over Explicit Config Variant (ADR-0028, status: accepted)
- [[0029-colon-as-variant-separator.adr.md]] — Use `:` as Variant Separator (Not `/`) (ADR-0029, status: accepted)
- [[0030-models-per-entry-variant.adr.md]] — Propagate Per-Entry Variant for `models[]` Array (ADR-0030, status: accepted)
- [[0031-variant-downstream-validation.adr.md]] — Validate Variant Downstream, Not in Parser (ADR-0031, status: accepted)
- [[0032-protect-anthropic-protocol-tool-use.adr.md]] — Protect Anthropic Protocol tool_use from Meta Tool Rename (ADR-0032, status: accepted)
- [[0033-absolute-directory-mcp-arguments.adr.md]] — Pass Existing Absolute Directory MCP Arguments Through Unchanged (ADR-0033, status: accepted)
- [[0034-log-helper-lives-in-core.adr.md]] — Log Helper Lives in core (ADR-0034, status: accepted)
- [[0035-json-lines-format-for-tools-log.adr.md]] — JSON Lines Format for tools.log (ADR-0035, status: accepted)
- [[0036-unified-toolslog-helper.adr.md]] — Unified toolsLog Helper Called from Both tool.ts and session/tools.ts (ADR-0036, status: accepted)
- [[0037-numeric-rotation-keep-5-backups.adr.md]] — Numeric Rotation — Keep 5 Backups (ADR-0037, status: accepted)
- [[0038-env-var-gating-opencode-log-tools.adr.md]] — Environment Variable Gating — OPENCODE_LOG_TOOLS (ADR-0038, status: accepted)
- [[0039-single-post-execution-log-line.adr.md]] — Single Post-Execution Log Line per Tool Call (ADR-0039, status: accepted)
- [[0040-log-truncated-output-plus-raw-length.adr.md]] — Log Truncated Output + Raw Length (ADR-0040, status: accepted)
- [[0041-error-logging-in-same-file.adr.md]] — Error Logging in the Same File (ADR-0041, status: accepted)
- [[0042-intent-delegation-architecture.adr.md]] — Intent Delegation Architecture (ADR-0042, status: accepted)
- [[0043-select-qwen35-08b-composition-model.adr.md]] — Select Qwen3.5-0.8B as Composition Model (ADR-0043, status: accepted)
- [[0044-execute-original-intent-on-failure.adr.md]] — Execute Original Intent on Failure (ADR-0044, status: accepted)
- [[0045-accept-malformed-args-intention-in-meta-use.adr.md]] — Accept Malformed Args and Optional Intention in meta_use (ADR-0045, status: accepted)
- [[0046-two-phase-implementation-strategy.adr.md]] — Two-Phase Implementation Strategy (ADR-0046, status: accepted)
- [[0047-expose-llm-service-to-plugins-via-plugininput.adr.md]] — Expose LLM Service to Plugins via PluginInput (ADR-0047, status: accepted)
- [[0048-manage-system-tools-through-meta-tool.adr.md]] — Manage System Tools Through Meta Tool (ADR-0048, status: accepted)
- [[0049-line-count-log-rotation.adr.md]] — Line Count Log Rotation for tools.log (ADR-0049, status: accepted)
