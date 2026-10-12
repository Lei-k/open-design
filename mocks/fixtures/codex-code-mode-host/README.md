Captured Codex 0.162.1 app-server notifications supplied by the independent S73 reviewer, using a loopback mock provider (no real provider). Incoming frames are trimmed to turn/item/warning/raw-item behavior. Thread, turn and item identifiers are replaced; host paths become `/private-release/bin/codex-code-mode-host`, cwd becomes `/workspace`. Process identifiers, metadata, repeated terminal summaries and raw developer/user environment prompts are removed. No credentials or tokens are retained.

- `nb`, `nbw`: binary-only package; thread warning, no tool item.
- `ok`, `sb`: full package; healthy command execution, including the real outer bubblewrap run.
- `badrun`: executable non-ELF host without raw events; no observable failure evidence. Retained as evidence of why raw events must be requested, not as a detectable failure control.
- `rawrun`: same non-ELF host with raw events; correlated custom exec call/output carries `Exec format error (os error 8)` without a warning or tool item.

The regression replays these through the shipping session → normalizer → PersonalRunEvents path. Additional refusal/privacy cases derive from the captured raw call/output and warning shapes.
